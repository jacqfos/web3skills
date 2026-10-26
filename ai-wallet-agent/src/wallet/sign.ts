/**
 * THE SIGNING FLOW (user device). This is the critical path:
 *
 *   proposal (untrusted, from agent)
 *     -> reviewProposal()        independent re-derivation of the bytes
 *     -> confirm()               EXPLICIT USER APPROVAL (UI prompt)
 *     -> unlock vault            user passphrase -> root seed -> share keys
 *     -> ONE Sui PTB, signed by the owner key:
 *          policy::authorize_*()  POLICY CHECK; builds message; returns MessageApproval
 *          verify_presign_cap()
 *          request_sign()         carries the USER'S PARTIAL SIGNATURE, computed
 *                                 locally from the decrypted USER SHARE
 *     -> Ika network             validates approval == message and the user's
 *                                partial signature, then adds the NETWORK SHARE
 *     -> signature               chain adapter attaches it and broadcasts
 *
 * If the policy aborts, nothing reaches the network. If the user does not
 * unlock their share, no partial signature exists and the network cannot sign.
 */
import {
	Curve,
	Hash,
	IkaTransaction,
	parseSignatureFromSignOutput,
	SignatureAlgorithm,
	SessionsManagerModule,
	CoordinatorInnerModule,
} from '@ika.xyz/sdk';
import type { Keypair } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { UserRejectedError } from '../core/errors.js';
import type { Proposal } from '../core/types.js';
import { userShareKeys, type DWalletRecord } from './dkg.js';
import { execute, largestIkaCoin, type IkaContext } from './ika.js';
import { authorize, type PolicyConfig } from './policyTx.js';
import { reviewProposal, type Review, type ReviewContext } from './review.js';

export interface SignArgs {
	ctx: IkaContext;
	policy: PolicyConfig;
	proposal: Proposal;
	review: ReviewContext;
	dwallet: DWalletRecord;
	/** A completed presign for this dWallet's curve (see presign.ts). */
	presignId: string;
	/** Show the review to the user and resolve true only on explicit approval. */
	confirm: (review: Review) => Promise<boolean>;
	/** Called only AFTER approval: prompts for the passphrase and opens the vault. */
	unlock: () => Promise<{ owner: Keypair; rootSeed: Uint8Array; wipe: () => void }>;
}

export async function approveAndSign(a: SignArgs): Promise<{ signature: Uint8Array; message: Uint8Array; suiDigest: string }> {
	// 1. Independent verification. Throws on any mismatch.
	const review = reviewProposal(a.proposal, a.review);

	// 2. Explicit user approval. No approval -> we never touch the share.
	if (!(await a.confirm(review))) throw new UserRejectedError();

	// 3. Unlock the user's secrets for this one operation.
	const secrets = await a.unlock();
	try {
		const isEvm = a.proposal.payload.chain === 'evm';
		const curve = isEvm ? Curve.SECP256K1 : Curve.ED25519;
		const signatureAlgorithm = isEvm ? SignatureAlgorithm.ECDSASecp256k1 : SignatureAlgorithm.EdDSA;
		const hashScheme = isEvm ? Hash.KECCAK256 : Hash.SHA512;
		if (a.dwallet.curve !== curve) throw new Error('dWallet curve does not match the proposal chain');

		// USER SHARE REQUIRED HERE: these keys decrypt the on-chain encrypted
		// user share locally; the SDK uses it to compute the user's partial
		// signature inside requestSign(). Without them, signing is impossible.
		const keys = await userShareKeys(secrets.rootSeed, curve);

		const [dWallet, presign, encryptedShare] = await Promise.all([
			a.ctx.ika.getDWalletInParticularState(a.dwallet.dwalletId, 'Active'),
			a.ctx.ika.getPresignInParticularState(a.presignId, 'Completed'),
			a.ctx.ika.getEncryptedUserSecretKeyShare(a.dwallet.encryptedUserSecretKeyShareId),
		]);

		const tx = new Transaction();
		const ikaTx = new IkaTransaction({ ikaClient: a.ctx.ika, transaction: tx, userShareEncryptionKeys: keys });

		// 4a. POLICY CHECK (on-chain). Aborts the whole PTB if any rule fails.
		const messageApproval = authorize(tx, a.ctx.ika, a.policy, a.proposal.payload, a.proposal.id);

		// 4b. Ika sign request with the user's partial signature.
		const verifiedPresignCap = ikaTx.verifyPresignCap({ presign });
		await ikaTx.requestSign({
			dWallet: dWallet as never, // Active zero-trust dWallet
			messageApproval,
			hashScheme,
			verifiedPresignCap,
			presign,
			encryptedUserSecretKeyShare: encryptedShare,
			message: review.message,
			signatureScheme: signatureAlgorithm,
			ikaCoin: tx.object(await largestIkaCoin(a.ctx, secrets.owner.getPublicKey().toSuiAddress())),
			suiCoin: tx.gas,
		});

		const res = await execute(a.ctx.sui, secrets.owner, tx);

		// 5. Wait for the network to combine its share and publish the signature.
		const signId = parseSignId(res.events);
		const sign = await a.ctx.ika.getSignInParticularState(signId, curve, signatureAlgorithm, 'Completed', { timeout: 120_000 });
		const signature = await parseSignatureFromSignOutput(curve, signatureAlgorithm, Uint8Array.from(sign.state.Completed.signature));
		return { signature, message: review.message, suiDigest: res.digest };
	} finally {
		secrets.wipe();
	}
}

function parseSignId(events: { eventType: string; bcs: Uint8Array }[]): string {
	const ev = events.find((e) => e.eventType.includes('::SignRequestEvent'));
	if (!ev) throw new Error('Sign request event not found');
	return SessionsManagerModule.DWalletSessionEvent(CoordinatorInnerModule.SignRequestEvent).parse(ev.bcs).event_data.sign_id;
}
