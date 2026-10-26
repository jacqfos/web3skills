/**
 * Natural language -> structured Intent.
 *
 * Security posture: the LLM is treated as an untrusted text transformer.
 *   - It sees ONLY the user's current message and the static system prompt.
 *     No balances, prices, web content or tool results enter its context, so
 *     there is no channel for third-party prompt injection.
 *   - It has no tools. Its only output is a schema-constrained JSON object.
 *   - Output is re-validated with zod and grounded against the user's text.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { groundingProblems } from './grounding.js';
import { ParseResult, type Intent } from './schema.js';

export interface IntentParser {
	parse(userText: string): Promise<ParseResult>;
}

const SYSTEM_PROMPT = `You convert a wallet owner's chat message into one structured intent for a non-custodial wallet.

You never execute anything. Your output becomes a *proposal* the owner reviews and approves on their own device, and an on-chain policy enforces hard limits. Precision matters more than helpfulness:
- Copy addresses character-for-character. Never complete, shorten, or "fix" an address.
- Copy numbers exactly as written ("0.1", not "0.10" or 0.1). Slippage is a percentage string ("1" for 1%).
- "my address", "me", "my wallet" => recipient "self".
- If anything needed for a transaction is missing or ambiguous (amount, asset, recipient), return type "clarify" with a short question instead of guessing.
- "drops below"/"under" => price_below; "above"/"over" => price_above. Balance conditions refer to the owner's own balance.
- Chains: "ethereum"/"mainnet" => ethereum; "sepolia"; "solana"; "solana devnet" => solana-devnet. Use null if not stated.
- Requests to change wallet limits/policies, export keys or seeds, or sign arbitrary data are out of scope: return "clarify" explaining that only the owner can change the on-chain policy from their admin key.`;

export class ClaudeIntentParser implements IntentParser {
	constructor(
		private client = new Anthropic(),
		private addressBookLabels: string[] = [],
		private model = 'claude-opus-5-5',
	) {}

	async parse(userText: string): Promise<ParseResult> {
		const response = await this.client.beta.messages.parse({
			model: this.model,
			max_tokens: 16000,
			// Parsing is a short, well-specified task: low effort keeps latency down.
			output_config: { effort: 'low', format: betaZodOutputFormat(ParseResult) },
			// On a safety-classifier refusal, let the API retry on a fallback model.
			betas: ['server-side-fallback-2026-07-01'],
			fallbacks: 'default',
			system: SYSTEM_PROMPT,
			messages: [{ role: 'user', content: userText }],
		});

		if (response.stop_reason === 'refusal') {
			return clarify("I can't help with that request.");
		}
		const parsed = response.parsed_output;
		if (!parsed) return clarify("Sorry, I couldn't understand that. Could you rephrase?");
		return groundOrClarify(ParseResult.parse(parsed), userText, this.addressBookLabels);
	}
}

export function groundOrClarify(result: ParseResult, userText: string, labels: string[]): ParseResult {
	const problems = groundingProblems(result.intent, userText, labels);
	if (problems.length === 0) return result;
	return clarify(`I want to double-check before preparing anything: ${problems.join('; ')}. Can you restate it?`);
}

function clarify(question: string): ParseResult {
	const intent: Intent = { type: 'clarify', question };
	return { intent, reply: question };
}

/**
 * Deterministic parser for offline demos/tests (no API key needed). Handles the
 * README example phrasings; anything else becomes a clarify.
 */
export class RuleBasedIntentParser implements IntentParser {
	constructor(private addressBookLabels: string[] = []) {}

	async parse(text: string): Promise<ParseResult> {
		const t = text.trim();
		const chain = /\bsepolia\b/i.test(t) ? 'sepolia' : /\bdevnet\b/i.test(t) ? 'solana-devnet' : null;
		const price = (s: string) => s.replace(/[$,]/g, '');
		let m: RegExpMatchArray | null;

		if ((m = t.match(/^alert me when (\w+) is (under|below|above|over) \$?(\d[\d,]*(?:\.\d+)?)/i))) {
			const kind = /under|below/i.test(m[2]!) ? 'price_below' : 'price_above';
			return this.ground({ intent: { type: 'alert', condition: { kind, asset: m[1]!.toUpperCase(), usd: price(m[3]!) } }, reply: `I'll alert you when ${m[1]!.toUpperCase()} is ${m[2]} $${price(m[3]!)}.` }, t);
		}
		if ((m = t.match(/^buy ([\d.]+) (\w+)(?: with (\w+))? if it (?:drops below|is under|falls below) \$?(\d[\d,]*(?:\.\d+)?)(?:,? max ([\d.]+)% slippage)?(?:,? only to (my address|0x[0-9a-fA-F]{40}))?/i))) {
			return this.ground({
				intent: {
					type: 'buy', chain, buy_asset: m[2]!.toUpperCase(), buy_amount: m[1]!, pay_asset: m[3]?.toUpperCase() ?? null,
					max_slippage_pct: m[5] ?? null, recipient: !m[6] || /my address/i.test(m[6]) ? 'self' : m[6],
					condition: { kind: 'price_below', asset: m[2]!.toUpperCase(), usd: price(m[4]!) },
				},
				reply: `I'll buy ${m[1]} ${m[2]!.toUpperCase()} once it drops below $${price(m[4]!)} and ask you to approve.`,
			}, t);
		}
		if ((m = t.match(/^send ([\d.]+) (\w+) to (\S+?)(?: if my balance is above ([\d.]+))?(?: on \w+)?\.?$/i))) {
			const asset = m[2]!.toUpperCase();
			return this.ground({
				intent: {
					type: 'transfer', chain, asset, amount: m[1]!, recipient: m[3]!,
					condition: m[4] ? { kind: 'balance_above', chain, asset, amount: m[4] } : null,
				},
				reply: `Preparing to send ${m[1]} ${asset} to ${m[3]}${m[4] ? ` once your balance is above ${m[4]}` : ''}.`,
			}, t);
		}
		if (/portfolio|balance/i.test(t)) return { intent: { type: 'portfolio' }, reply: 'Here are your balances.' };
		if (/history/i.test(t)) return { intent: { type: 'history' }, reply: 'Here is your transaction history.' };
		return clarify('Sorry, I only understand a few phrasings in offline mode. Try "Send 50 USDC to 0x... if my balance is above 200".');
	}

	private ground(r: ParseResult, text: string) {
		return groundOrClarify(r, text, this.addressBookLabels);
	}
}
