/**
 * Structured intent the LLM must produce. Amounts are decimal STRINGS (never
 * floats) and addresses are copied verbatim — grounding.ts then checks both
 * against the user's literal text.
 */
import { z } from 'zod';

export const ChainName = z.enum(['ethereum', 'sepolia', 'solana', 'solana-devnet']);
export type ChainName = z.infer<typeof ChainName>;

const Decimal = z.string().describe('Decimal number exactly as written by the user, e.g. "0.1" or "50"');

export const Condition = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('price_below'), asset: z.string(), usd: Decimal }),
	z.object({ kind: z.literal('price_above'), asset: z.string(), usd: Decimal }),
	z.object({ kind: z.literal('balance_above'), chain: ChainName.nullable(), asset: z.string(), amount: Decimal }),
	z.object({ kind: z.literal('balance_below'), chain: ChainName.nullable(), asset: z.string(), amount: Decimal }),
]);
export type Condition = z.infer<typeof Condition>;

export const TransferIntent = z.object({
	type: z.literal('transfer'),
	chain: ChainName.nullable().describe('null if the user did not say'),
	asset: z.string().describe('Token symbol, e.g. "USDC", "ETH", "SOL"'),
	amount: Decimal,
	recipient: z.string().describe('Address copied character-for-character, or "self", or an address-book label the user used'),
	condition: Condition.nullable(),
});

export const BuyIntent = z.object({
	type: z.literal('buy'),
	chain: ChainName.nullable(),
	buy_asset: z.string(),
	buy_amount: Decimal,
	pay_asset: z.string().nullable().describe('What to pay with; null if unstated'),
	max_slippage_pct: Decimal.nullable(),
	recipient: z.string().describe('"self" unless the user named an address'),
	condition: Condition.nullable(),
});

export const Intent = z.discriminatedUnion('type', [
	TransferIntent,
	BuyIntent,
	z.object({ type: z.literal('alert'), condition: Condition }),
	z.object({ type: z.literal('portfolio') }),
	z.object({ type: z.literal('history') }),
	z.object({ type: z.literal('list_watches') }),
	z.object({ type: z.literal('cancel_watch'), watch_id: z.string().nullable() }),
	z.object({ type: z.literal('clarify'), question: z.string() }),
]);
export type Intent = z.infer<typeof Intent>;
export type TransferIntent = z.infer<typeof TransferIntent>;
export type BuyIntent = z.infer<typeof BuyIntent>;

export const ParseResult = z.object({
	intent: Intent,
	reply: z.string().describe('One short sentence to the user confirming what you understood'),
});
export type ParseResult = z.infer<typeof ParseResult>;
