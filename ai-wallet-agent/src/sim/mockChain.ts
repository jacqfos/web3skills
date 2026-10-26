/** In-memory chain adapters for the offline simulation and tests. */
import { attachEvmSignature } from '../core/encoding/evm.js';
import type { AdapterRegistry, EvmAdapter, SolanaAdapter } from '../core/chains/adapter.js';
import { FALLBACK_GAS } from '../core/chains/adapter.js';
import type { EvmAction, EvmEnvelope, Hex } from '../core/types.js';

export class MockEvmAdapter implements EvmAdapter {
	readonly kind = 'evm' as const;
	/** `${address}:${token}` (lowercase) -> balance */
	balances = new Map<string, bigint>();
	allowances = new Map<string, bigint>();
	nonce = 0;
	broadcasts: string[] = [];

	constructor(readonly id: number) {}

	setBalance(address: string, token: string, v: bigint) {
		this.balances.set(`${address}:${token}`.toLowerCase(), v);
	}
	async balance({ address, token }: { address: string; token: string }) {
		return this.balances.get(`${address}:${token}`.toLowerCase()) ?? 0n;
	}
	async pendingNonce() {
		return this.nonce;
	}
	async allowance(owner: Hex, token: Hex, spender: Hex) {
		return this.allowances.get(`${owner}:${token}:${spender}`.toLowerCase()) ?? 0n;
	}
	async prepareEnvelope(_from: Hex, action: EvmAction, nonce: number): Promise<EvmEnvelope> {
		return { nonce, gasLimit: FALLBACK_GAS[action.type], maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
	}
	finalize(message: Uint8Array, signature: Uint8Array, from: string) {
		return attachEvmSignature(message, signature, from as Hex);
	}
	async broadcast(raw: string) {
		this.broadcasts.push(raw);
		this.nonce++;
		return `0xmocktx${this.broadcasts.length}`;
	}
	explorerUrl(h: string) {
		return `mock://${h}`;
	}
}

export class MockAdapters implements AdapterRegistry {
	readonly evms = new Map<number, MockEvmAdapter>();
	evm(chainId: number) {
		if (!this.evms.has(chainId)) this.evms.set(chainId, new MockEvmAdapter(chainId));
		return this.evms.get(chainId)!;
	}
	solana(): SolanaAdapter {
		throw new Error('Solana is not simulated in the offline demo');
	}
}
