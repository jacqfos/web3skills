/**
 * Presigns: the network's precomputed, message-independent half of a
 * signature. One presign is consumed per signature, so keep a small pool and
 * refill in the background. Presigns carry no authority on their own — they
 * are useless without a MessageApproval (policy) and the user's share.
 */
import { CoordinatorInnerModule, Curve, IkaTransaction, SessionsManagerModule, SignatureAlgorithm } from '@ika.xyz/sdk';
import type { Keypair } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { execute, largestIkaCoin, type IkaContext } from './ika.js';
import type { SupportedCurve } from './dkg.js';

export async function requestPresign(ctx: IkaContext, owner: Keypair, curve: SupportedCurve): Promise<string> {
	const ownerAddress = owner.getPublicKey().toSuiAddress();
	const tx = new Transaction();
	const ikaTx = new IkaTransaction({ ikaClient: ctx.ika, transaction: tx });
	const networkKey = await ctx.ika.getLatestNetworkEncryptionKey();
	// Current (v2) zero-trust dWallets use global presigns for ECDSA and EdDSA alike.
	const cap = ikaTx.requestGlobalPresign({
		dwalletNetworkEncryptionKeyId: networkKey.id,
		curve,
		signatureAlgorithm: (curve === Curve.SECP256K1 ? SignatureAlgorithm.ECDSASecp256k1 : SignatureAlgorithm.EdDSA) as never,
		ikaCoin: tx.object(await largestIkaCoin(ctx, ownerAddress)),
		suiCoin: tx.gas,
	});
	// The presign cap must be owned by the signer to be verified later.
	tx.transferObjects([cap], ownerAddress);
	const res = await execute(ctx.sui, owner, tx);
	const ev = res.events.find((e) => e.eventType.includes('::PresignRequestEvent'));
	if (!ev) throw new Error('Presign request event not found');
	const presignId = SessionsManagerModule.DWalletSessionEvent(CoordinatorInnerModule.PresignRequestEvent).parse(ev.bcs).event_data.presign_id;
	await ctx.ika.getPresignInParticularState(presignId, 'Completed', { timeout: 300_000 });
	return presignId;
}
