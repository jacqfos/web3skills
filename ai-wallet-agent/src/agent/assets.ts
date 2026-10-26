/**
 * Static asset / chain registry. Must agree with the on-chain policy's token
 * allow-list (the policy is authoritative; this is for building proposals).
 */
import { parseUnits } from 'viem';
import { SOLANA_CLUSTER, type ChainRef, type Hex } from '../core/types.js';
import type { ChainName } from './intent/schema.js';

export interface AssetInfo {
	symbol: string;
	chain: ChainRef;
	/** '' = native */
	address: string;
	decimals: number;
	/** Symbol used by the price feed / on-chain PriceBook */
	priceSymbol: string;
}

export const CHAINS: Record<ChainName, ChainRef> = {
	ethereum: { kind: 'evm', id: 1 },
	sepolia: { kind: 'evm', id: 11155111 },
	solana: { kind: 'solana', id: SOLANA_CLUSTER.mainnet },
	'solana-devnet': { kind: 'solana', id: SOLANA_CLUSTER.devnet },
};

/** Uniswap SwapRouter02 deployments. */
export const SWAP_ROUTERS: Record<number, Hex> = {
	1: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
	11155111: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
};

export const DEFAULT_ASSETS: AssetInfo[] = [
	{ symbol: 'ETH', chain: CHAINS.ethereum, address: '', decimals: 18, priceSymbol: 'ETH' },
	{ symbol: 'WETH', chain: CHAINS.ethereum, address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, priceSymbol: 'ETH' },
	{ symbol: 'USDC', chain: CHAINS.ethereum, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, priceSymbol: 'USDC' },
	{ symbol: 'ETH', chain: CHAINS.sepolia, address: '', decimals: 18, priceSymbol: 'ETH' },
	{ symbol: 'WETH', chain: CHAINS.sepolia, address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', decimals: 18, priceSymbol: 'ETH' },
	{ symbol: 'USDC', chain: CHAINS.sepolia, address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6, priceSymbol: 'USDC' },
	{ symbol: 'SOL', chain: CHAINS.solana, address: '', decimals: 9, priceSymbol: 'SOL' },
	{ symbol: 'SOL', chain: CHAINS['solana-devnet'], address: '', decimals: 9, priceSymbol: 'SOL' },
];

export class AssetRegistry {
	constructor(readonly assets: AssetInfo[] = DEFAULT_ASSETS) {}

	find(symbol: string, chain: ChainRef): AssetInfo | undefined {
		const s = symbol.toUpperCase();
		return this.assets.find((a) => a.symbol === s && a.chain.kind === chain.kind && a.chain.id === chain.id);
	}

	require(symbol: string, chain: ChainRef): AssetInfo {
		const a = this.find(symbol, chain);
		if (!a) throw new Error(`${symbol} is not a supported asset on ${chain.kind}:${chain.id}`);
		return a;
	}

	/** Where an asset lives when the user didn't name a chain. */
	defaultChainFor(symbol: string, preferred: ChainRef): ChainRef {
		if (this.find(symbol, preferred)) return preferred;
		const any = this.assets.find((a) => a.symbol === symbol.toUpperCase() && a.chain.kind === (symbol.toUpperCase() === 'SOL' ? 'solana' : 'evm'));
		if (!any) throw new Error(`Unknown asset ${symbol}`);
		return any.chain;
	}

	toBaseUnits(asset: AssetInfo, decimal: string): bigint {
		if (!/^\d*\.?\d+$/.test(decimal)) throw new Error(`invalid amount "${decimal}"`);
		return parseUnits(decimal, asset.decimals);
	}
}
