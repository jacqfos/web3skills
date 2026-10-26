/**
 * Notification channels. Notifications carry a proposal *id* and a summary —
 * never anything that lets the recipient approve without opening the wallet.
 */

export interface Notification {
	title: string;
	body: string;
	proposalId?: string;
	kind: 'proposal_ready' | 'alert' | 'policy_rejected' | 'info';
}

export interface Notifier {
	notify(n: Notification): Promise<void>;
}

export class ConsoleNotifier implements Notifier {
	async notify(n: Notification) {
		console.log(`\n🔔 [${n.kind}] ${n.title}\n   ${n.body}${n.proposalId ? `\n   proposal: ${n.proposalId}` : ''}`);
	}
}

/** Generic JSON webhook: works with ntfy.sh topics, Slack/Discord incoming webhooks via a relay, etc. */
export class WebhookNotifier implements Notifier {
	constructor(
		private url: string,
		private headers: Record<string, string> = {},
	) {}

	async notify(n: Notification) {
		const res = await fetch(this.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...this.headers },
			body: JSON.stringify(n),
		});
		if (!res.ok) console.warn(`notification webhook failed: HTTP ${res.status}`);
	}
}

export class MultiNotifier implements Notifier {
	constructor(private channels: Notifier[]) {}
	async notify(n: Notification) {
		await Promise.allSettled(this.channels.map((c) => c.notify(n)));
	}
}
