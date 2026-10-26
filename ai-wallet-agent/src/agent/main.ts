/**
 * Agent process entrypoint.  `npm run agent -- agent.config.json`
 *
 * Holds: an Anthropic API key, RPC URLs, a notification webhook, the API token.
 * Does NOT hold: the owner key, the root seed / user share, the admin key, or
 * the oracle key. Compromise of this process cannot produce a signature.
 */
import { readFileSync } from 'node:fs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { DefaultAdapterRegistry } from '../core/chains/registry.js';
import type { Prices } from '../core/policy/engine.js';
import { readPolicy } from '../core/policy/onchain.js';
import { WalletAgent } from './agent.js';
import { AssetRegistry, CHAINS } from './assets.js';
import { ConditionMonitor } from './conditions/monitor.js';
import type { ChainName } from './intent/schema.js';
import { ClaudeIntentParser, RuleBasedIntentParser } from './intent/parser.js';
import { ConsoleNotifier, MultiNotifier, WebhookNotifier, type Notifier } from './notify.js';
import { CoinGeckoPriceSource, toUsdE8, type PriceSource } from './prices.js';
import { ProposalBuilder, type PolicySnapshotSource, type WalletAddresses } from './proposals/builder.js';
import { startServer } from './server.js';
import { AgentStore } from './store.js';

interface AgentConfig {
	network: 'testnet' | 'mainnet';
	policyId: string;
	wallet: WalletAddresses;
	addressBook: Record<string, string>;
	defaultChain: ChainName;
	port: number;
	webhookUrl?: string;
}

/**
 * Policy view for pre-checks: rules/state from the live Policy object; prices
 * from the agent's feed (an approximation of the on-chain PriceBook — the
 * contract re-checks with its own prices regardless).
 */
class OnchainPolicySnapshot implements PolicySnapshotSource {
	constructor(
		private sui: SuiGrpcClient,
		private policyId: string,
		private prices: PriceSource,
	) {}
	async snapshot() {
		const { rules, state } = await readPolicy(this.sui, this.policyId);
		const symbols = [...new Set(rules.tokens.map((t) => t.oracleSymbol))];
		const usd = await this.prices.usd(symbols);
		const now = Date.now();
		const prices: Prices = Object.fromEntries(Object.entries(usd).map(([s, p]) => [s, { usdE8: toUsdE8(p), updatedMs: now }]));
		return { rules, state, prices };
	}
}

async function main() {
	const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'agent.config.json', 'utf8')) as AgentConfig;
	const token = process.env.AGENT_API_TOKEN;
	if (!token) throw new Error('Set AGENT_API_TOKEN');

	const sui = new SuiGrpcClient({ baseUrl: `https://fullnode.${cfg.network}.sui.io:443`, network: cfg.network });
	const assets = new AssetRegistry();
	const adapters = new DefaultAdapterRegistry();
	const prices = new CoinGeckoPriceSource();
	const store = new AgentStore();
	const labels = Object.keys(cfg.addressBook);
	const parser = process.env.ANTHROPIC_API_KEY ? new ClaudeIntentParser(undefined, labels) : new RuleBasedIntentParser(labels);
	const notifiers: Notifier[] = [new ConsoleNotifier()];
	if (cfg.webhookUrl) notifiers.push(new WebhookNotifier(cfg.webhookUrl));
	const notifier = new MultiNotifier(notifiers);

	const builder = new ProposalBuilder({
		assets,
		adapters,
		prices,
		policy: new OnchainPolicySnapshot(sui, cfg.policyId, prices),
		wallet: cfg.wallet,
		addressBook: cfg.addressBook,
		defaultChain: CHAINS[cfg.defaultChain],
		proposalTtlMs: 10 * 60_000,
		defaultSlippageBps: 50,
	});
	const agent = new WalletAgent({ parser, builder, store, notifier, assets, prices, adapters, wallet: cfg.wallet });
	const monitor = new ConditionMonitor(
		{ prices, adapters, assets, wallet: cfg.wallet, defaultChain: CHAINS[cfg.defaultChain], onTrigger: (w, o) => agent.onTrigger(w, o) },
		() => [...store.watches.values()],
	);
	monitor.start(30_000);
	startServer(agent, store, { port: cfg.port, token });
	console.log(`agent listening on 127.0.0.1:${cfg.port} (parser: ${parser.constructor.name})`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
