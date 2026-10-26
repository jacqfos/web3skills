/**
 * Wires the real agent, builder, review and policy engine to the mock chain /
 * mock Ika network. Used by examples/critical-path.ts and the tests.
 */
import { parseUnits, recoverTransactionAddress, type Hex } from 'viem';
import { UserRejectedError } from '../core/errors.js';
import type { PolicyState, Prices, Rules } from '../core/policy/engine.js';
import type { Proposal } from '../core/types.js';
import { WalletAgent } from '../agent/agent.js';
import { AssetRegistry, CHAINS, DEFAULT_ASSETS, SWAP_ROUTERS } from '../agent/assets.js';
import { ConditionMonitor } from '../agent/conditions/monitor.js';
import { RuleBasedIntentParser } from '../agent/intent/parser.js';
import type { Notification, Notifier } from '../agent/notify.js';
import { StaticPriceSource, toUsdE8 } from '../agent/prices.js';
import { ProposalBuilder } from '../agent/proposals/builder.js';
import { AgentStore } from '../agent/store.js';
import { reviewProposal, type Review } from '../wallet/review.js';
import { MockAdapters } from './mockChain.js';
import { MockIkaNetwork, MockPolicyContract, MockUserDevice } from './mockIka.js';

export const OWNER = '0x00000000000000000000000000000000000000000000000000000000000000a1';
export const ALICE: Hex = '0x1111111111111111111111111111111111111111';
export const ATTACKER: Hex = '0xBAdBAdbaDbadbaDBaDbaDBadBaDbadBadBaDBAD0';
const SEPOLIA = CHAINS.sepolia;
const asset = (s: string) => DEFAULT_ASSETS.find((a) => a.symbol === s && a.chain.id === SEPOLIA.id)!;

class RecordingNotifier implements Notifier {
	sent: Notification[] = [];
	constructor(private log: (s: string) => void) {}
	async notify(n: Notification) {
		this.sent.push(n);
		this.log(`🔔 [${n.kind}] ${n.title} — ${n.body}`);
	}
}

export function createSimulation(log: (s: string) => void = () => {}) {
	let now = 1_800_000_000_000;
	const clock = () => now;

	// --- Ika: DKG creates the dWallet; user keeps their share on the device ---
	const network = new MockIkaNetwork();
	const dw = network.dkg();
	const device = new MockUserDevice(dw.dwalletId, dw.userShare);

	// --- On-chain policy (hard limits) ---
	const usdc = asset('USDC');
	const weth = asset('WETH');
	const rules: Rules = {
		maxDailyUsdE8: toUsdE8(500),
		maxTxPerDay: 10,
		maxSlippageBps: 100,
		maxPriceAgeMs: 300_000,
		chains: [SEPOLIA],
		tokens: [
			{ chain: SEPOLIA, address: '', oracleSymbol: 'ETH', decimals: 18, maxPerTx: parseUnits('0.5', 18) },
			{ chain: SEPOLIA, address: weth.address, oracleSymbol: 'ETH', decimals: 18, maxPerTx: parseUnits('0.5', 18) },
			{ chain: SEPOLIA, address: usdc.address, oracleSymbol: 'USDC', decimals: 6, maxPerTx: parseUnits('400', 6) },
		],
		destinations: [
			{ chain: SEPOLIA, address: dw.address },
			{ chain: SEPOLIA, address: ALICE },
		],
		routers: [{ chainId: SEPOLIA.id, address: SWAP_ROUTERS[SEPOLIA.id]! }],
		evmGas: { [SEPOLIA.id]: { maxFeePerGas: parseUnits('100', 9), maxPriorityFeePerGas: parseUnits('5', 9), maxGasLimit: 300_000n } },
	};
	const state: PolicyState = { owner: OWNER, paused: false, day: 0, spentUsdE8: 0n, txCount: 0, evmNonces: {} };
	const feed = new StaticPriceSource({ ETH: 3300, USDC: 1, SOL: 150 });
	const priceBook = (): Prices =>
		Object.fromEntries(Object.entries(feed.prices).map(([s, p]) => [s, { usdE8: toUsdE8(p), updatedMs: now }]));
	const policy = new MockPolicyContract(rules, state, dw.dwalletId, priceBook());

	// --- Chain + agent ---
	const adapters = new MockAdapters();
	const sepolia = adapters.evm(SEPOLIA.id);
	sepolia.setBalance(dw.address, usdc.address, parseUnits('150', 6));
	const assets = new AssetRegistry();
	const store = new AgentStore();
	const notifier = new RecordingNotifier(log);
	const wallet = { owner: OWNER, evm: dw.address };
	const addressBook = { alice: ALICE };
	const builder = new ProposalBuilder({
		assets,
		adapters,
		prices: feed,
		policy: { snapshot: async () => ({ rules: policy.rules, state: policy.state, prices: (policy.prices = priceBook()) }) },
		wallet,
		addressBook,
		defaultChain: SEPOLIA,
		proposalTtlMs: 10 * 60_000,
		defaultSlippageBps: 50,
		now: clock,
	});
	const agent = new WalletAgent({ parser: new RuleBasedIntentParser(['alice']), builder, store, notifier, assets, prices: feed, adapters, wallet });
	const monitor = new ConditionMonitor(
		{ prices: feed, adapters, assets, wallet, defaultChain: SEPOLIA, onTrigger: (w, o) => agent.onTrigger(w, o) },
		() => [...store.watches.values()],
	);

	const reviewCtx = () => ({
		now,
		tokens: DEFAULT_ASSETS.map((a) => ({ chain: a.chain.kind, chainId: a.chain.id, address: a.address, symbol: a.symbol, decimals: a.decimals })),
		addressBook: { [ALICE]: 'alice', [dw.address]: 'my dWallet', [SWAP_ROUTERS[SEPOLIA.id]!]: 'Uniswap SwapRouter02' },
	});

	/**
	 * The wallet's approval flow, step for step as in src/wallet/sign.ts, but
	 * against the mocks: review -> user decision -> policy -> user share -> network.
	 */
	async function walletApprove(p: Proposal, decide: (r: Review) => boolean = () => true) {
		const review = reviewProposal(p, reviewCtx()); // 1. independent verification
		review.lines.forEach((l) => log(`   │ ${l}`));
		review.warnings.forEach((w) => log(`   │ ⚠ ${w}`));
		if (!decide(review)) {
			store.updateStatus(p.id, 'rejected_by_user');
			throw new UserRejectedError(); // 2. explicit user approval
		}
		const { approval, message } = policy.authorize(OWNER, p.payload, now); // 3. policy check (on-chain in prod)
		if (Buffer.compare(Buffer.from(message), Buffer.from(review.message)) !== 0) throw new Error('policy built different bytes');
		const user = device.contribute(message); // 4. USER SHARE participates
		const sig = network.requestSign({ approval, message, user }); // 5. network share participates
		const raw = await sepolia.finalize(message, sig, dw.address);
		const signer = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
		const txHash = await sepolia.broadcast(raw);
		store.updateStatus(p.id, 'broadcast', { txHash });
		return { raw, signer, txHash };
	}

	return {
		agent, store, monitor, notifier, policy, network, device, feed, sepolia, dw, walletApprove,
		advance: (ms: number) => (now += ms),
		usdc, weth,
	};
}
