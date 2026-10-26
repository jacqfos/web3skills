/**
 * Chain adapter interfaces. Adding a chain = implementing an adapter + an
 * encoder in src/core/encoding + an `authorize_*` function in the Move policy.
 * (Bitcoin: Ika supports secp256k1 ECDSA/Taproot with SHA256/DoubleSHA256; the
 * policy would build the BIP-143/341 sighash on-chain from typed inputs.)
 */
import type { EvmAction, EvmEnvelope, Hex, SolanaAction, SolanaEnvelope } from '../types.js';

interface BaseAdapter {
	readonly id: number;
	/** token '' = native */
	balance(q: { address: string; token: string }): Promise<bigint>;
	/** Attach an Ika signature to the signed message; returns the raw tx in the chain's wire encoding. */
	finalize(message: Uint8Array, signature: Uint8Array, from: string): Promise<string>;
	broadcast(rawTx: string): Promise<string>;
	explorerUrl(txHash: string): string;
}

export interface EvmAdapter extends BaseAdapter {
	readonly kind: 'evm';
	pendingNonce(from: Hex): Promise<number>;
	allowance(owner: Hex, token: Hex, spender: Hex): Promise<bigint>;
	/** Gas + fees for `action` at `nonce`. Falls back to a fixed gas limit if estimation fails (e.g. swap before approve is mined). */
	prepareEnvelope(from: Hex, action: EvmAction, nonce: number): Promise<EvmEnvelope>;
}

export interface SolanaAdapter extends BaseAdapter {
	readonly kind: 'solana';
	prepareEnvelope(from: string, action: SolanaAction): Promise<SolanaEnvelope>;
}

export interface AdapterRegistry {
	evm(chainId: number): EvmAdapter;
	solana(cluster: number): SolanaAdapter;
}

/** Conservative gas limits used when estimation is impossible. */
export const FALLBACK_GAS: Record<EvmAction['type'], bigint> = {
	evm_transfer: 100_000n,
	evm_erc20_approve: 80_000n,
	evm_swap_exact_in: 300_000n,
};
