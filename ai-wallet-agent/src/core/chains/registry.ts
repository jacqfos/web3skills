import type { AdapterRegistry, EvmAdapter, SolanaAdapter } from './adapter.js';
import { ViemEvmAdapter } from './evm.js';
import { RpcSolanaAdapter } from './solana.js';

/** Lazily constructs adapters; RPC URLs come from env (EVM_RPC_<chainId>, SOLANA_RPC_<cluster>). */
export class DefaultAdapterRegistry implements AdapterRegistry {
	private cache = new Map<string, EvmAdapter | SolanaAdapter>();

	evm(chainId: number): EvmAdapter {
		const k = `evm:${chainId}`;
		if (!this.cache.has(k)) this.cache.set(k, new ViemEvmAdapter(chainId, process.env[`EVM_RPC_${chainId}`]));
		return this.cache.get(k) as EvmAdapter;
	}

	solana(cluster: number): SolanaAdapter {
		const k = `sol:${cluster}`;
		if (!this.cache.has(k)) this.cache.set(k, new RpcSolanaAdapter(cluster, process.env[`SOLANA_RPC_${cluster}`]));
		return this.cache.get(k) as SolanaAdapter;
	}
}
