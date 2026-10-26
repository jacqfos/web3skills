import { describe, expect, it } from 'vitest';
import { groundOrClarify, RuleBasedIntentParser } from '../src/agent/intent/parser.js';
import { ParseResult } from '../src/agent/intent/schema.js';

const ADDR = '0x1111111111111111111111111111111111111111';

describe('grounding: LLM output must match what the user typed', () => {
	const base = (intent: unknown) => ParseResult.parse({ intent, reply: 'ok' });

	it('accepts verbatim values', () => {
		const r = groundOrClarify(
			base({ type: 'transfer', chain: null, asset: 'USDC', amount: '50', recipient: ADDR, condition: { kind: 'balance_above', chain: null, asset: 'USDC', amount: '200' } }),
			`Send 50 USDC to ${ADDR} if my balance is above 200`,
			[],
		);
		expect(r.intent.type).toBe('transfer');
	});

	it('rejects a substituted recipient (hallucination / injection)', () => {
		const r = groundOrClarify(
			base({ type: 'transfer', chain: null, asset: 'USDC', amount: '50', recipient: '0x2222222222222222222222222222222222222222', condition: null }),
			`Send 50 USDC to ${ADDR}`,
			[],
		);
		expect(r.intent.type).toBe('clarify');
	});

	it('rejects a changed amount or threshold', () => {
		expect(groundOrClarify(base({ type: 'transfer', chain: null, asset: 'USDC', amount: '500', recipient: ADDR, condition: null }), `Send 50 USDC to ${ADDR}`, []).intent.type).toBe('clarify');
		expect(
			groundOrClarify(
				base({ type: 'alert', condition: { kind: 'price_below', asset: 'SOL', usd: '14' } }),
				'Alert me when SOL is under $140',
				[],
			).intent.type,
		).toBe('clarify');
	});

	it('accepts address-book labels only if the user used them', () => {
		const intent = { type: 'transfer', chain: null, asset: 'USDC', amount: '5', recipient: 'alice', condition: null };
		expect(groundOrClarify(base(intent), 'send 5 USDC to alice', ['alice']).intent.type).toBe('transfer');
		expect(groundOrClarify(base(intent), 'send 5 USDC to bob', ['alice']).intent.type).toBe('clarify');
	});
});

describe('offline rule-based parser (README examples)', () => {
	const p = new RuleBasedIntentParser();
	it.each([
		['Buy 0.1 ETH if it drops below $3200, max 1% slippage, only to my address', { type: 'buy', buy_amount: '0.1', max_slippage_pct: '1', recipient: 'self' }],
		[`Send 50 USDC to ${ADDR} if my balance is above 200`, { type: 'transfer', amount: '50', recipient: ADDR }],
		['Alert me when SOL is under $140', { type: 'alert', condition: { kind: 'price_below', asset: 'SOL', usd: '140' } }],
		['Buy 1 ETH if it drops below $3,200.50', { type: 'buy', condition: { kind: 'price_below', asset: 'ETH', usd: '3200.50' } }],
	])('%s', async (text, expected) => {
		expect((await p.parse(text)).intent).toMatchObject(expected);
	});
});
