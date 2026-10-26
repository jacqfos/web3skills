/**
 * Off-chain price feed used by the agent for condition monitoring and for
 * sizing swaps. The policy does NOT trust these numbers: it re-checks value
 * and slippage against its own on-chain PriceBook.
 */

export interface PriceSource {
	/** USD prices for symbols, e.g. { ETH: 3150.12 } */
	usd(symbols: string[]): Promise<Record<string, number>>;
}

const COINGECKO_IDS: Record<string, string> = { ETH: 'ethereum', WETH: 'ethereum', SOL: 'solana', USDC: 'usd-coin', BTC: 'bitcoin' };

export class CoinGeckoPriceSource implements PriceSource {
	constructor(private baseUrl = 'https://api.coingecko.com/api/v3') {}

	async usd(symbols: string[]): Promise<Record<string, number>> {
		const ids = [...new Set(symbols.map((s) => COINGECKO_IDS[s.toUpperCase()]).filter(Boolean))];
		if (ids.length === 0) return {};
		const res = await fetch(`${this.baseUrl}/simple/price?ids=${ids.join(',')}&vs_currencies=usd`);
		if (!res.ok) throw new Error(`price feed HTTP ${res.status}`);
		const body = (await res.json()) as Record<string, { usd: number }>;
		const out: Record<string, number> = {};
		for (const s of symbols) {
			const id = COINGECKO_IDS[s.toUpperCase()];
			const p = id ? body[id]?.usd : undefined;
			if (p !== undefined) out[s.toUpperCase()] = p;
		}
		return out;
	}
}

/** Fixed/mutable prices for tests and the offline simulation. */
export class StaticPriceSource implements PriceSource {
	constructor(public prices: Record<string, number>) {}
	async usd(symbols: string[]) {
		return Object.fromEntries(symbols.filter((s) => s in this.prices).map((s) => [s, this.prices[s]!]));
	}
}

/** Convert a float USD price to the 8-decimal integer format the policy uses. */
export const toUsdE8 = (usd: number): bigint => BigInt(Math.round(usd * 1e8));
