/**
 * Condition monitor: polls prices/balances and fires watches.
 *
 * Trust note: the agent decides *when* a condition is met, and that decision
 * is not verified on-chain. A compromised agent can at most fire a proposal
 * early — which the user still has to approve, and which the policy still
 * bounds (value, destination, oracle-checked slippage).
 */
import { formatUnits } from 'viem';
import type { AdapterRegistry } from '../../core/chains/adapter.js';
import type { ChainRef } from '../../core/types.js';
import { CHAINS, type AssetRegistry } from '../assets.js';
import type { Condition } from '../intent/schema.js';
import type { PriceSource } from '../prices.js';
import type { WalletAddresses } from '../proposals/builder.js';
import type { Watch } from '../store.js';

export interface MonitorDeps {
	prices: PriceSource;
	adapters: AdapterRegistry;
	assets: AssetRegistry;
	wallet: WalletAddresses;
	defaultChain: ChainRef;
	onTrigger: (w: Watch, observed: string) => Promise<void>;
}

export class ConditionMonitor {
	private timer?: NodeJS.Timeout;
	private running = false;

	constructor(
		private d: MonitorDeps,
		private watches: () => Watch[],
	) {}

	start(intervalMs = 30_000) {
		this.timer = setInterval(() => void this.tick(), intervalMs);
	}

	stop() {
		clearInterval(this.timer);
	}

	/** One evaluation pass (exported for tests and the demo). */
	async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const armed = this.watches().filter((w) => w.status === 'armed');
			if (armed.length === 0) return;
			const symbols = armed.flatMap((w) => ('usd' in w.condition ? [w.condition.asset.toUpperCase()] : []));
			const prices = symbols.length ? await this.d.prices.usd(symbols) : {};
			for (const w of armed) {
				try {
					const observed = await this.check(w.condition, prices);
					if (observed) {
						w.status = 'triggered';
						w.triggeredAt = Date.now();
						await this.d.onTrigger(w, observed);
					}
				} catch (e) {
					w.status = 'failed';
					w.error = (e as Error).message;
				}
			}
		} finally {
			this.running = false;
		}
	}

	/** Returns a description of the observed value if the condition holds, else null. */
	private async check(c: Condition, prices: Record<string, number>): Promise<string | null> {
		if (c.kind === 'price_below' || c.kind === 'price_above') {
			const p = prices[c.asset.toUpperCase()];
			if (p === undefined) return null;
			const hit = c.kind === 'price_below' ? p < Number(c.usd) : p > Number(c.usd);
			return hit ? `${c.asset.toUpperCase()} = $${p.toFixed(2)}` : null;
		}
		const chain = c.chain ? CHAINS[c.chain] : this.d.assets.defaultChainFor(c.asset, this.d.defaultChain);
		const asset = this.d.assets.require(c.asset, chain);
		const owner = chain.kind === 'evm' ? this.d.wallet.evm : this.d.wallet.solana;
		if (!owner) return null;
		const raw =
			chain.kind === 'evm'
				? await this.d.adapters.evm(chain.id).balance({ address: owner, token: asset.address })
				: await this.d.adapters.solana(chain.id).balance({ address: owner, token: asset.address });
		const threshold = this.d.assets.toBaseUnits(asset, c.amount);
		const hit = c.kind === 'balance_above' ? raw > threshold : raw < threshold;
		return hit ? `balance ${formatUnits(raw, asset.decimals)} ${asset.symbol}` : null;
	}
}
