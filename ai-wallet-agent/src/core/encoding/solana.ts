/**
 * Byte-exact TypeScript port of contracts/policy/sources/solana.move.
 * test/encoding.test.ts checks it against @solana/web3.js.
 */
import type { SolanaAction, SolanaEnvelope } from '../types.js';
import { base58Decode } from './base58.js';
import { concat } from './evm.js';

const SYSTEM_PROGRAM_ID = new Uint8Array(32);
const IX_TRANSFER = Uint8Array.of(2, 0, 0, 0);

export function systemTransferMessage(
	from: Uint8Array,
	to: Uint8Array,
	lamports: bigint,
	recentBlockhash: Uint8Array,
): Uint8Array {
	if (from.length !== 32 || to.length !== 32 || recentBlockhash.length !== 32) throw new Error('bad key length');
	if (from.every((b, i) => b === to[i])) throw new Error('self transfer');
	const lamportsLe = new Uint8Array(8);
	new DataView(lamportsLe.buffer).setBigUint64(0, lamports, true);
	return concat(
		Uint8Array.of(1, 0, 1, 3),
		from,
		to,
		SYSTEM_PROGRAM_ID,
		recentBlockhash,
		Uint8Array.of(1, 2, 2, 0, 1, 12),
		IX_TRANSFER,
		lamportsLe,
	);
}

/** The message the policy's `check_solana_transfer` builds. `from` is the dWallet's ed25519 pubkey. */
export function solanaMessage(action: SolanaAction, env: SolanaEnvelope, fromBase58: string): Uint8Array {
	return systemTransferMessage(
		base58Decode(fromBase58, 32),
		base58Decode(action.recipient, 32),
		action.lamports,
		base58Decode(env.recentBlockhash, 32),
	);
}

/** Wire format of a single-signer transaction: compact(1) || sig(64) || message. */
export function solanaSignedTx(message: Uint8Array, signature: Uint8Array): Uint8Array {
	if (signature.length !== 64) throw new Error('expected 64-byte ed25519 signature');
	return concat(Uint8Array.of(1), signature, message);
}
