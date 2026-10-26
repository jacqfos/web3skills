/**
 * The agent: chat in, replies + proposals out. It can read and propose; it
 * cannot sign, cannot change the policy, and never sees any key material.
 */
import { randomUUID } from 'node:crypto';
import { formatUnits } from 'viem';
import { formatUsdE8 } from '../core/policy/engine.js';
import type { Proposal } from '../core/types.js';
import type { AssetRegistry } from './assets.js';
import type { IntentParser } from './intent/parser.js';
import type { Notifier } from './notify.js';
import type { PriceSource } from './prices.js';
import type { BuilderDeps, ProposalBuilder } from './proposals/builder.js';
import type { AgentStore, Watch } from './store.js';
import { policyErrorMessage, type PolicyErrorName } from '../core/errors.js';

export interface AgentReply {
	text: string;
	proposals: Proposal[];
	watch?: Watch;
}

export interface AgentDeps {
	parser: IntentParser;
	builder: ProposalBuilder;
	store: AgentStore;
	notifier: Notifier;
	assets: AssetRegistry;
	prices: PriceSource;
	adapters: BuilderDeps['adapters'];
	wallet: BuilderDeps['wallet'];
}

export class WalletAgent {
	constructor(private d: AgentDeps) {}

	async handle(userText: string): Promise<AgentReply> {
		const { intent, reply } = await this.d.parser.parse(userText);
		switch (intent.type) {
			case 'clarify':
				return { text: intent.question, proposals: [] };
			case 'transfer':
			case 'buy':
				if (intent.condition) return this.arm(userText, intent.condition, intent, reply);
				return this.propose(intent, userText, reply);
			case 'alert':
				return this.arm(userText, intent.condition, null, reply);
			case 'portfolio':
				return { text: await this.portfolio(), proposals: [] };
			case 'history':
				return { text: this.history(), proposals: [] };
			case 'list_watches': {
				const ws = [...this.d.store.watches.values()].filter((w) => w.status === 'armed');
				return { text: ws.length ? ws.map((w) => `• ${w.id.slice(0, 8)}: "${w.userText}"`).join('\n') : 'No active watches.', proposals: [] };
			}
			case 'cancel_watch': {
				const id = intent.watch_id;
				const w = [...this.d.store.watches.values()].find((x) => x.status === 'armed' && (!id || x.id.startsWith(id)));
				if (!w) return { text: 'No matching active watch.', proposals: [] };
				w.status = 'cancelled';
				return { text: `Cancelled watch "${w.userText}".`, proposals: [] };
			}
		}
	}

	/** Called by the ConditionMonitor when a watch fires. */
	async onTrigger(w: Watch, observed: string): Promise<void> {
		if (!w.action) {
			await this.d.notifier.notify({ kind: 'alert', title: 'Price alert', body: `${w.userText} — now ${observed}` });
			return;
		}
		const { proposals } = await this.propose(w.action, w.userText, '');
		const ok = proposals.filter((p) => p.status === 'pending_approval');
		if (ok.length === 0) {
			await this.d.notifier.notify({ kind: 'policy_rejected', title: 'Condition met, but blocked by your policy', body: proposals.map(explain).join(' ') });
			return;
		}
		for (const p of ok) {
			await this.d.notifier.notify({
				kind: 'proposal_ready',
				title: 'Transaction ready for your approval',
				body: `${observed}. ${p.agentSummary}. Open your wallet to review and approve.`,
				proposalId: p.id,
			});
		}
	}

	private async propose(intent: Parameters<ProposalBuilder['fromTransfer']>[0] | Parameters<ProposalBuilder['fromBuy']>[0], userText: string, reply: string): Promise<AgentReply> {
		let proposals: Proposal[];
		try {
			proposals = intent.type === 'transfer' ? await this.d.builder.fromTransfer(intent, userText) : await this.d.builder.fromBuy(intent, userText);
		} catch (e) {
			return { text: `I couldn't prepare that: ${(e as Error).message}`, proposals: [] };
		}
		proposals.forEach((p) => this.d.store.addProposal(p));
		const blocked = proposals.filter((p) => !p.precheck.ok);
		if (blocked.length) {
			return { text: `Your policy would reject this, so I haven't asked you to sign. ${blocked.map(explain).join(' ')}`, proposals };
		}
		const usd = proposals.reduce((s, p) => s + BigInt(p.precheck.usdE8), 0n);
		return {
			text: `${reply} ${proposals.length > 1 ? `${proposals.length} transactions are` : 'A transaction is'} ready (≈${formatUsdE8(usd)}). Review and approve in your wallet — I can't sign for you.`.trim(),
			proposals,
		};
	}

	private arm(userText: string, condition: Watch['condition'], action: Watch['action'], reply: string): AgentReply {
		const watch: Watch = { id: randomUUID(), createdAt: Date.now(), userText, condition, action, status: 'armed' };
		this.d.store.watches.set(watch.id, watch);
		const then = action ? "When it happens I'll prepare the transaction and ask you to approve it." : "I'll notify you.";
		return { text: `${reply} Watching now. ${then}`.trim(), proposals: [], watch };
	}

	private async portfolio(): Promise<string> {
		const lines: string[] = [];
		const symbols = [...new Set(this.d.assets.assets.map((a) => a.priceSymbol))];
		const prices = await this.d.prices.usd(symbols).catch(() => ({}) as Record<string, number>);
		for (const a of this.d.assets.assets) {
			const owner = a.chain.kind === 'evm' ? this.d.wallet.evm : this.d.wallet.solana;
			if (!owner) continue;
			try {
				const bal =
					a.chain.kind === 'evm'
						? await this.d.adapters.evm(a.chain.id).balance({ address: owner, token: a.address })
						: await this.d.adapters.solana(a.chain.id).balance({ address: owner, token: a.address });
				if (bal === 0n) continue;
				const amount = formatUnits(bal, a.decimals);
				const p = prices[a.priceSymbol];
				lines.push(`• ${amount} ${a.symbol} (${a.chain.kind}:${a.chain.id})${p ? ` ≈ $${(Number(amount) * p).toFixed(2)}` : ''}`);
			} catch {
				lines.push(`• ${a.symbol} (${a.chain.kind}:${a.chain.id}): unavailable`);
			}
		}
		return lines.length ? lines.join('\n') : 'No balances found.';
	}

	private history(): string {
		const h = this.d.store.history();
		if (!h.length) return 'No transactions yet.';
		return h
			.slice(0, 20)
			.map((p) => `• ${new Date(p.createdAt).toISOString()} ${p.agentSummary} — ${p.status}${p.txHash ? ` (${p.txHash})` : ''}`)
			.join('\n');
	}
}

function explain(p: Proposal): string {
	return p.precheck.violations.map((v) => policyErrorMessage(v as PolicyErrorName)).join(' ');
}
