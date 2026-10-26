import { bytesToHex } from 'viem';
import type { Hex, Payload } from '../types.js';
import { evmMessage } from './evm.js';
import { solanaMessage } from './solana.js';

export * from './base58.js';
export * from './evm.js';
export * from './solana.js';

/**
 * Bytes the dWallet will sign for `payload`, exactly as the policy contract
 * builds them. `solanaFrom` is the dWallet's Solana address (needed as fee payer).
 */
export function messageFor(payload: Payload, solanaFrom?: string): Uint8Array {
	if (payload.chain === 'evm') return evmMessage(payload.action, payload.envelope);
	if (!solanaFrom) throw new Error('Solana dWallet address required');
	return solanaMessage(payload.action, payload.envelope, solanaFrom);
}

export function messageHexFor(payload: Payload, solanaFrom?: string): Hex {
	return bytesToHex(messageFor(payload, solanaFrom));
}
