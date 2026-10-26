/**
 * Wallet CLI — the user's trusted device in v1 (a mobile/desktop app later).
 *
 *   npm run wallet -- init
 *   npm run wallet -- create-dwallet secp256k1 config/policy.rules.json
 *   npm run wallet -- create-dwallet ed25519
 *   npm run wallet -- presign secp256k1
 *   npm run wallet -- pending
 *   npm run wallet -- approve <proposal-id>
 *   npm run wallet -- reject <proposal-id>
 *
 * Files: wallet.vault.json (encrypted secrets), wallet.json (public metadata).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Curve } from '@ika.xyz/sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { DefaultAdapterRegistry } from '../core/chains/registry.js';
import { parse, stringify } from '../core/json.js';
import { rulesFromFile, type RulesFile } from '../core/policy/rulesFile.js';
import type { Proposal } from '../core/types.js';
import { DEFAULT_ASSETS, SWAP_ROUTERS } from '../agent/assets.js';
import { createZeroTrustDWallet, type DWalletRecord, type SupportedCurve } from './dkg.js';
import { createIkaContext } from './ika.js';
import type { PolicyConfig } from './policyTx.js';
import { requestPresign } from './presign.js';
import { approveAndSign } from './sign.js';
import { loadVault, openVault, saveVault, sealVault, wipe } from './vault.js';

const VAULT = 'wallet.vault.json';
const META = 'wallet.json';

interface WalletMeta {
	network: 'testnet' | 'mainnet';
	agentUrl: string;
	packageId: string;
	priceBookId: string;
	admin: string;
	owner: string;
	policyId?: string;
	dwallets: DWalletRecord[];
	presigns: Partial<Record<SupportedCurve, string[]>>;
	addressBook: Record<string, string>;
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const meta = (): WalletMeta => JSON.parse(readFileSync(META, 'utf8')) as WalletMeta;
const saveMeta = (m: WalletMeta) => writeFileSync(META, JSON.stringify(m, null, 2));
const curveArg = (s?: string): SupportedCurve => (s === 'ed25519' ? Curve.ED25519 : Curve.SECP256K1);

async function askHidden(prompt: string): Promise<string> {
	const out = process.stdout;
	process.stdout.write(prompt);
	const orig = out.write.bind(out);
	out.write = (() => true) as typeof out.write; // mute echo
	try {
		return await rl.question('');
	} finally {
		out.write = orig;
		process.stdout.write('\n');
	}
}

async function unlock() {
	const secrets = openVault(await loadVault(VAULT), await askHidden('Vault passphrase: '));
	return { owner: Ed25519Keypair.fromSecretKey(secrets.ownerSecretKey), rootSeed: secrets.rootSeed, wipe: () => wipe(secrets) };
}

async function agentFetch<T>(m: WalletMeta, path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${m.agentUrl}${path}`, {
		...init,
		headers: { authorization: `Bearer ${process.env.AGENT_API_TOKEN ?? ''}`, 'content-type': 'application/json' },
	});
	if (!res.ok) throw new Error(`agent ${path}: HTTP ${res.status}`);
	return parse<T>(await res.text());
}

const policyConfig = (m: WalletMeta): PolicyConfig => {
	if (!m.policyId) throw new Error('No policy yet: run create-dwallet first');
	return { packageId: m.packageId, policyId: m.policyId, priceBookId: m.priceBookId };
};

const commands: Record<string, (args: string[]) => Promise<void>> = {
	async init() {
		if (existsSync(VAULT)) throw new Error(`${VAULT} already exists`);
		const owner = new Ed25519Keypair();
		const pass = await askHidden('Choose a vault passphrase (≥12 chars): ');
		if ((await askHidden('Repeat: ')) !== pass) throw new Error('Passphrases differ');
		await saveVault(VAULT, sealVault({ rootSeed: new Uint8Array(randomBytes(32)), ownerSecretKey: owner.getSecretKey() }, pass));
		const address = owner.getPublicKey().toSuiAddress();
		saveMeta({
			network: 'testnet',
			agentUrl: 'http://127.0.0.1:8787',
			packageId: '<WALLET_POLICY_PACKAGE_ID>',
			priceBookId: '<PRICE_BOOK_ID>',
			admin: '<ADMIN_ADDRESS (hardware wallet / multisig)>',
			owner: address,
			dwallets: [],
			presigns: {},
			addressBook: {},
		});
		console.log(`Vault created. Owner address: ${address}\nFund it with testnet SUI and IKA, then fill packageId/priceBookId/admin in ${META}.`);
		console.log('BACK UP wallet.vault.json + passphrase. Without the root seed inside it, your user share cannot be decrypted and the dWallet cannot sign.');
	},

	async 'create-dwallet'([curveName, rulesPath]) {
		const m = meta();
		const curve = curveArg(curveName);
		const ctx = await createIkaContext(m.network);
		const s = await unlock();
		try {
			const policy = m.policyId
				? ({ mode: 'existing', config: policyConfig(m) } as const)
				: ({
						mode: 'create',
						packageId: m.packageId,
						priceBookId: m.priceBookId,
						admin: m.admin,
						rules: rulesFromFile(JSON.parse(readFileSync(rulesPath ?? 'config/policy.rules.json', 'utf8')) as RulesFile),
						timelockMs: 48 * 3_600_000,
					} as const);
			console.log('Running DKG (user side locally, network side on Ika)…');
			const { record, policyId } = await createZeroTrustDWallet({ ctx, owner: s.owner, rootSeed: s.rootSeed, curve, policy });
			m.policyId = policyId;
			m.dwallets.push(record);
			saveMeta(m);
			console.log(`dWallet ${record.dwalletId}\n  address: ${record.address}\n  policy:  ${policyId}`);
		} finally {
			s.wipe();
		}
	},

	async presign([curveName]) {
		const m = meta();
		const curve = curveArg(curveName);
		const ctx = await createIkaContext(m.network);
		const s = await unlock();
		try {
			const id = await requestPresign(ctx, s.owner, curve);
			(m.presigns[curve] ??= []).push(id);
			saveMeta(m);
			console.log(`presign ready: ${id}`);
		} finally {
			s.wipe();
		}
	},

	async pending() {
		const ps = await agentFetch<Proposal[]>(meta(), '/proposals');
		if (!ps.length) return console.log('Nothing pending.');
		for (const p of ps) console.log(`${p.id}  ${p.agentSummary}  (expires ${new Date(p.expiresAt).toLocaleTimeString()})`);
	},

	async reject([id]) {
		await agentFetch(meta(), `/proposals/${id}/status`, { method: 'POST', body: stringify({ status: 'rejected_by_user' }) });
		console.log('Rejected.');
	},

	async approve([id]) {
		const m = meta();
		const proposal = await agentFetch<Proposal>(m, `/proposals/${id}`);
		const isEvm = proposal.payload.chain === 'evm';
		const curve = isEvm ? Curve.SECP256K1 : Curve.ED25519;
		const dwallet = m.dwallets.find((d) => d.curve === curve);
		if (!dwallet) throw new Error(`No ${curve} dWallet`);
		const presignId = m.presigns[curve]?.[0];
		if (!presignId) throw new Error(`No presign available: run \`presign ${isEvm ? 'secp256k1' : 'ed25519'}\` first`);
		const ctx = await createIkaContext(m.network);

		try {
			const { signature, message } = await approveAndSign({
				ctx,
				policy: policyConfig(m),
				proposal,
				dwallet,
				presignId,
				review: {
					now: Date.now(),
					solanaFrom: m.dwallets.find((d) => d.curve === Curve.ED25519)?.address,
					tokens: DEFAULT_ASSETS.map((a) => ({ chain: a.chain.kind, chainId: a.chain.id, address: a.address, symbol: a.symbol, decimals: a.decimals })),
					addressBook: {
						...Object.fromEntries(Object.values(SWAP_ROUTERS).map((addr) => [addr, 'Uniswap SwapRouter02'])),
						...Object.fromEntries(Object.entries(m.addressBook).map(([label, addr]) => [addr, label])),
						...Object.fromEntries(m.dwallets.map((d) => [d.address, 'my dWallet'])),
					},
				},
				// EXPLICIT USER CONFIRMATION
				confirm: async (r) => {
					console.log('\n──── Review (computed on this device, not by the agent) ────');
					r.lines.forEach((l) => console.log(l));
					r.warnings.forEach((w) => console.log(`⚠  ${w}`));
					console.log(`Agent said: "${proposal.agentSummary}"  — your words: "${proposal.userText}"`);
					return (await rl.question('\nType APPROVE to sign with your share: ')) === 'APPROVE';
				},
				unlock,
			});
			m.presigns[curve]!.shift(); // presigns are single-use
			saveMeta(m);

			const adapters = new DefaultAdapterRegistry();
			const p = proposal.payload;
			const adapter = p.chain === 'evm' ? adapters.evm(p.action.chainId) : adapters.solana(p.action.cluster);
			const raw = await adapter.finalize(message, signature, dwallet.address);
			const txHash = await adapter.broadcast(raw);
			await agentFetch(m, `/proposals/${id}/status`, { method: 'POST', body: stringify({ status: 'broadcast', txHash }) });
			console.log(`Broadcast: ${adapter.explorerUrl(txHash)}`);
		} catch (e) {
			const msg = (e as Error).message;
			const status = (e as Error).name === 'UserRejectedError' ? 'rejected_by_user' : 'failed';
			await agentFetch(m, `/proposals/${id}/status`, { method: 'POST', body: stringify({ status, error: msg }) }).catch(() => {});
			throw e;
		}
	},
};

const [cmd, ...args] = process.argv.slice(2);
const run = cmd ? commands[cmd] : undefined;
if (!run) {
	console.log(`usage: wallet <${Object.keys(commands).join('|')}> [...]`);
	process.exit(1);
}
run(args)
	.catch((e) => {
		console.error(`✖ ${(e as Error).message}`);
		process.exitCode = 1;
	})
	.finally(() => rl.close());
