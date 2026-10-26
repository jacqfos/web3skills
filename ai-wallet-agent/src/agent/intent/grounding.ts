/**
 * Grounding checks: every security-relevant value in the parsed intent must
 * literally appear in what the user typed. This catches LLM hallucination and
 * the classic "prompt injection swaps the address" attack before a proposal is
 * even built. (It is defense in depth — the wallet review and the on-chain
 * destination allow-list still apply.)
 */
import type { Condition, Intent } from './schema.js';

const numbersIn = (text: string): number[] =>
	[...text.replace(/,/g, '').matchAll(/\d*\.?\d+/g)].map((m) => Number(m[0]));

const mentionsNumber = (text: string, value: string) => {
	const v = Number(value);
	return Number.isFinite(v) && numbersIn(text).some((n) => n === v);
};

const mentionsWord = (text: string, word: string) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);

export function groundingProblems(intent: Intent, userText: string, addressBookLabels: string[]): string[] {
	const problems: string[] = [];
	const num = (what: string, v: string | null | undefined) => {
		if (v != null && !mentionsNumber(userText, v)) problems.push(`${what} "${v}" is not something you wrote`);
	};
	const cond = (c: Condition | null) => {
		if (!c) return;
		if (c.kind === 'price_below' || c.kind === 'price_above') num('price threshold', c.usd);
		else num('balance threshold', c.amount);
	};
	const recipient = (r: string) => {
		if (r === 'self') return;
		const isLabel = addressBookLabels.some((l) => l.toLowerCase() === r.toLowerCase()) && mentionsWord(userText, r);
		const verbatim = userText.toLowerCase().includes(r.toLowerCase());
		if (!isLabel && !verbatim) problems.push(`recipient "${r}" does not appear in your message`);
	};

	switch (intent.type) {
		case 'transfer':
			num('amount', intent.amount);
			recipient(intent.recipient);
			cond(intent.condition);
			break;
		case 'buy':
			num('amount', intent.buy_amount);
			num('slippage', intent.max_slippage_pct);
			recipient(intent.recipient);
			cond(intent.condition);
			break;
		case 'alert':
			cond(intent.condition);
			break;
	}
	return problems;
}
