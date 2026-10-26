/**
 * Zero-trust dWallet creation (DKG) — runs on the user's device.
 *
 * Flow (Ika 2PC-MPC, zero-trust variant):
 *
 *   1. Derive UserShareEncryptionKeys from the user's root seed and register
 *      the encryption key on-chain (once per curve).
 *   2. prepareDKGAsync(): the USER side of DKG runs locally. It produces
 *        - userDKGMessage        (public key share + ZK proof)   -> network
 *        - userPublicOutput      (public)                        -> network
 *        - encryptedUserShareAndProof (user secret share encrypted to the
 *          user's OWN encryption key + proof of correct encryption) -> network
 *        - userSecretKeyShare    (PLAINTEXT user share — never leaves the device)
 *   3. One PTB: request_dwallet_dkg -> returns DWalletCap, which is locked
 *      into the Policy object in the same transaction. The cap is never held
 *      by any address, so no one can approve messages outside the policy.
 *   4. The network runs its side and produces its share. The dWallet waits in
 *      AwaitingKeyHolderSignature until the user signs the public output,
 *      accepting the encrypted share (proves the user can decrypt it).
 *   5. Active. The full private key never existed anywhere: the network holds
 *      its share (itself threshold-split across validators) and the chain holds
 *      the user share encrypted to a key only this device can derive.
 */
import {
	CoordinatorInnerModule,
	createRandomSessionIdentifier,
	Curve,
	IkaTransaction,
	prepareDKGAsync,
	publicKeyFromDWalletOutput,
	SessionsManagerModule,
	UserShareEncryptionKeys,
} from '@ika.xyz/sdk';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bcs } from '@mysten/sui/bcs';
import type { Keypair } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { bytesToHex } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import { base58Encode } from '../core/encoding/base58.js';
import type { Rules } from '../core/policy/engine.js';
import { execute, largestIkaCoin, type IkaContext } from './ika.js';
import { addDWalletToPolicy, createPolicyWithCap, CURVE_ID, setChainAddress, type PolicyConfig } from './policyTx.js';

export type SupportedCurve = typeof Curve.SECP256K1 | typeof Curve.ED25519;

/** Non-secret metadata the wallet keeps locally (wallet.json). */
export interface DWalletRecord {
	curve: SupportedCurve;
	dwalletId: string;
	encryptedUserSecretKeyShareId: string;
	publicKeyHex: string;
	/** EVM 0x-address or Solana base58 address */
	address: string;
}

export async function userShareKeys(rootSeed: Uint8Array, curve: SupportedCurve) {
	return UserShareEncryptionKeys.fromRootSeedKey(rootSeed, curve);
}

async function ensureEncryptionKeyRegistered(ctx: IkaContext, owner: Keypair, keys: UserShareEncryptionKeys, curve: SupportedCurve) {
	try {
		await ctx.ika.getActiveEncryptionKey(keys.getSuiAddress());
		return;
	} catch {
		// not registered yet
	}
	const tx = new Transaction();
	const ikaTx = new IkaTransaction({ ikaClient: ctx.ika, transaction: tx, userShareEncryptionKeys: keys });
	await ikaTx.registerEncryptionKey({ curve });
	await execute(ctx.sui, owner, tx);
}

export interface CreateDWalletArgs {
	ctx: IkaContext;
	owner: Keypair;
	rootSeed: Uint8Array;
	curve: SupportedCurve;
	/** Either create a new policy around this dWallet, or add it to an existing one. */
	policy:
		| { mode: 'create'; packageId: string; priceBookId: string; admin: string; rules: Rules; timelockMs: number }
		| { mode: 'existing'; config: PolicyConfig };
}

export async function createZeroTrustDWallet(a: CreateDWalletArgs): Promise<{ record: DWalletRecord; policyId: string }> {
	const { ctx, owner, curve } = a;
	const ownerAddress = owner.getPublicKey().toSuiAddress();
	const keys = await userShareKeys(a.rootSeed, curve);
	await ensureEncryptionKeyRegistered(ctx, owner, keys, curve);

	// --- (2) user side of DKG, locally ---
	const sessionBytes = createRandomSessionIdentifier();
	const dkg = await prepareDKGAsync(ctx.ika, curve, keys, sessionBytes, ownerAddress);

	try {
		// --- (3) request DKG and lock the cap into the policy, atomically ---
		const tx = new Transaction();
		const ikaTx = new IkaTransaction({ ikaClient: ctx.ika, transaction: tx, userShareEncryptionKeys: keys });
		const networkKey = await ctx.ika.getLatestNetworkEncryptionKey();
		const [cap] = await ikaTx.requestDWalletDKG({
			dkgRequestInput: dkg,
			sessionIdentifier: ikaTx.registerSessionIdentifier(sessionBytes),
			dwalletNetworkEncryptionKeyId: networkKey.id,
			curve,
			ikaCoin: tx.object(await largestIkaCoin(ctx, ownerAddress)),
			suiCoin: tx.gas,
		});
		const curveId = curve === Curve.SECP256K1 ? CURVE_ID.SECP256K1 : CURVE_ID.ED25519;
		if (a.policy.mode === 'create') {
			createPolicyWithCap(tx, {
				pkg: a.policy.packageId,
				owner: ownerAddress,
				admin: a.policy.admin,
				priceBookId: a.policy.priceBookId,
				rules: a.policy.rules,
				timelockMs: a.policy.timelockMs,
				cap: cap!,
				curve: curveId,
			});
		} else {
			addDWalletToPolicy(tx, a.policy.config, cap!, curveId);
		}
		const res = await execute(ctx.sui, owner, tx);

		const request = parseDkgRequestEvent(res.events);
		const policyId =
			a.policy.mode === 'existing'
				? a.policy.config.policyId
				: res.createdObjects.find((o) => o.type?.endsWith('::policy::Policy'))?.objectId;
		if (!policyId) throw new Error('Policy object not found in DKG transaction effects');

		// --- (4) wait for the network side, then accept the encrypted share ---
		const awaiting = await ctx.ika.getDWalletInParticularState(request.dwalletId, 'AwaitingKeyHolderSignature', { timeout: 300_000 });
		const acceptTx = new Transaction();
		await new IkaTransaction({ ikaClient: ctx.ika, transaction: acceptTx, userShareEncryptionKeys: keys }).acceptEncryptedUserShare({
			dWallet: awaiting as never, // narrowed by state; the SDK accepts ZeroTrustDWallet
			userPublicOutput: dkg.userPublicOutput,
			encryptedUserSecretKeyShareId: request.encryptedShareId,
		});
		await execute(ctx.sui, owner, acceptTx);

		// --- (5) active: derive the chain address and record it in the policy ---
		const active = await ctx.ika.getDWalletInParticularState(request.dwalletId, 'Active', { timeout: 300_000 });
		const pubkey = bcs.vector(bcs.u8()).parse(await publicKeyFromDWalletOutput(curve, Uint8Array.from(active.state.Active.public_output)));
		const pk = Uint8Array.from(pubkey);
		const address =
			curve === Curve.SECP256K1
				? publicKeyToAddress(bytesToHex(secp256k1.Point.fromBytes(pk).toBytes(false)))
				: base58Encode(pk);

		const addrTx = new Transaction();
		setChainAddress(
			addrTx,
			{ packageId: a.policy.mode === 'create' ? a.policy.packageId : a.policy.config.packageId, policyId, priceBookId: '' },
			curveId,
			curve === Curve.SECP256K1 ? Buffer.from(address.slice(2), 'hex') : pk,
		);
		await execute(ctx.sui, owner, addrTx);

		return {
			policyId,
			record: {
				curve,
				dwalletId: request.dwalletId,
				encryptedUserSecretKeyShareId: request.encryptedShareId,
				publicKeyHex: bytesToHex(pk),
				address,
			},
		};
	} finally {
		// The plaintext user share is only needed for the encryption proof; drop it.
		dkg.userSecretKeyShare.fill(0);
	}
}

/** Pull dwallet id + encrypted share id out of the DKG request event. */
function parseDkgRequestEvent(events: { eventType: string; bcs: Uint8Array }[]) {
	const ev = events.find((e) => e.eventType.includes('::DWalletDKGRequestEvent'));
	if (!ev) throw new Error('DKG request event not found');
	const parsed = SessionsManagerModule.DWalletSessionEvent(CoordinatorInnerModule.DWalletDKGRequestEvent).parse(ev.bcs);
	const share = parsed.event_data.user_secret_key_share;
	if (!share.Encrypted) throw new Error('Expected an encrypted (zero-trust) user share');
	return { dwalletId: parsed.event_data.dwallet_id, encryptedShareId: share.Encrypted.encrypted_user_secret_key_share_id };
}
