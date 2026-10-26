/**
 * In-memory agent state: proposals, watches, history. Swap for a database in
 * production. Note this is the agent's *view*; the authoritative history of
 * authorizations is the policy's `Authorized` events on Sui.
 */
import type { Proposal, ProposalStatus } from '../core/types.js';
import type { Condition, Intent } from './intent/schema.js';

export interface Watch {
	id: string;
	createdAt: number;
	userText: string;
	condition: Condition;
	/** null = alert only */
	action: Extract<Intent, { type: 'transfer' | 'buy' }> | null;
	status: 'armed' | 'triggered' | 'cancelled' | 'failed';
	triggeredAt?: number;
	error?: string;
}

export class AgentStore {
	readonly proposals = new Map<string, Proposal>();
	readonly watches = new Map<string, Watch>();

	addProposal(p: Proposal) {
		this.proposals.set(p.id, p);
	}

	/** Status transitions reported by the wallet. Terminal states are final. */
	updateStatus(id: string, status: ProposalStatus, extra: { txHash?: string; error?: string } = {}) {
		const p = this.proposals.get(id);
		if (!p) throw new Error('unknown proposal');
		const terminal: ProposalStatus[] = ['broadcast', 'failed', 'rejected_by_user', 'rejected_by_policy', 'expired'];
		if (terminal.includes(p.status)) throw new Error(`proposal already ${p.status}`);
		Object.assign(p, { status, ...extra });
	}

	pending(now = Date.now()): Proposal[] {
		for (const p of this.proposals.values()) {
			if (p.status === 'pending_approval' && now > p.expiresAt) p.status = 'expired';
		}
		return [...this.proposals.values()].filter((p) => p.status === 'pending_approval');
	}

	history(): Proposal[] {
		return [...this.proposals.values()]
			.filter((p) => p.status !== 'pending_approval')
			.sort((a, b) => b.createdAt - a.createdAt);
	}
}
