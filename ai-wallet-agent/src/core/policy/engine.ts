/**
 * TypeScript mirror of the policy checks in contracts/policy/sources/policy.move.
 *
 * !! NOT A SECURITY BOUNDARY !!
 * The Move contract is the only enforcement point. This mirror exists so that
 *   - the agent can tell the user "this would be rejected because ..." before
 *     anyone spends gas, and
 *   - the offline simulation (src/sim) can run the full flow without a chain.
 * Unlike the contract (which aborts on the first failure) this collects every
 * violation for better feedback.
 */
import type { PolicyErrorName } from '../errors.js';
import type { ChainRef, Payload } from '../types.js';

export const MS_PER_DAY = 86_400_000;
const BPS = 10_000n;

export interface TokenRule {
	chain: ChainRef;
	/** '' = native asset; EVM: 0x-hex address; Solana: base58 mint (v1: native only) */
	address: string;
	oracleSymbol: string;
	decimals: number;
	maxPerTx: bigint;
}

export interface GasRule {
	maxFeePerGas: bigint;
	maxPriorityFeePerGas: bigint;
	maxGasLimit: bigint;
}

export interface Rules {
	maxDailyUsdE8: bigint;
	maxTxPerDay: number;
	maxSlippageBps: number;
	maxPriceAgeMs: number;
	chains: ChainRef[];
	tokens: TokenRule[];
	destinations: { chain: ChainRef; address: string }[];
	routers: { chainId: number; address: string }[];
	evmGas: Record<number, GasRule>;
}

export interface PolicyState {
	owner: string;
	paused: boolean;
	day: number;
	spentUsdE8: bigint;
	txCount: number;
	evmNonces: Record<number, number>;
}

export type Prices = Record<string, { usdE8: bigint; updatedMs: number }>;

export type Evaluation =
	| { ok: true; usdE8: bigint; next: PolicyState }
	| { ok: false; violations: PolicyErrorName[]; usdE8: bigint };

const sameChain = (a: ChainRef, b: ChainRef) => a.kind === b.kind && a.id === b.id;
const norm = (chain: ChainRef, addr: string) => (chain.kind === 'evm' ? addr.toLowerCase() : addr);
const pow10 = (d: number) => 10n ** BigInt(d);

export function evaluate(
	rules: Rules,
	state: PolicyState,
	payload: Payload,
	prices: Prices,
	nowMs: number,
	sender: string,
): Evaluation {
	const v = new Set<PolicyErrorName>();
	const chain: ChainRef =
		payload.chain === 'evm'
			? { kind: 'evm', id: payload.action.chainId }
			: { kind: 'solana', id: payload.action.cluster };

	if (sender !== state.owner) v.add('ENotOwner');
	if (state.paused) v.add('EPaused');
	if (!rules.chains.some((c) => sameChain(c, chain))) v.add('EChainNotAllowed');

	const tokenRule = (address: string) =>
		rules.tokens.find((t) => sameChain(t.chain, chain) && norm(chain, t.address) === norm(chain, address));
	const destinationOk = (address: string) =>
		rules.destinations.some((d) => sameChain(d.chain, chain) && norm(chain, d.address) === norm(chain, address));
	const routerOk = (address: string) =>
		rules.routers.some((r) => r.chainId === chain.id && r.address.toLowerCase() === address.toLowerCase());
	const price = (t: TokenRule): bigint | undefined => {
		const p = prices[t.oracleSymbol];
		if (!p || nowMs > p.updatedMs + rules.maxPriceAgeMs) {
			v.add('EDailyUsdLimit'); // contract aborts in oracle (EStalePrice/EUnknownAsset); surfaced as a limit failure
			return undefined;
		}
		return p.usdE8;
	};
	/** value_usd_e8 in the contract: allow-list + per-tx cap + valuation */
	const valueUsd = (address: string, amount: bigint): bigint => {
		const t = tokenRule(address);
		if (!t) {
			v.add('ETokenNotAllowed');
			return 0n;
		}
		if (amount > t.maxPerTx) v.add('EAmountTooLarge');
		const p = price(t);
		return p === undefined ? 0n : (amount * p) / pow10(t.decimals);
	};

	let usdE8 = 0n;

	if (payload.chain === 'evm') {
		const env = payload.envelope;
		const gas = rules.evmGas[chain.id];
		if (!gas) v.add('EChainNotAllowed');
		else if (
			env.maxFeePerGas > gas.maxFeePerGas ||
			env.maxPriorityFeePerGas > gas.maxPriorityFeePerGas ||
			env.maxPriorityFeePerGas > env.maxFeePerGas ||
			env.gasLimit > gas.maxGasLimit
		)
			v.add('EGasTooHigh');
		if (env.nonce !== (state.evmNonces[chain.id] ?? 0)) v.add('EBadNonce');

		const a = payload.action;
		switch (a.type) {
			case 'evm_transfer':
				if (a.amount <= 0n) v.add('EZeroAmount');
				if (!destinationOk(a.recipient)) v.add('EDestinationNotAllowed');
				usdE8 = valueUsd(a.token ?? '', a.amount);
				break;
			case 'evm_erc20_approve': {
				if (!routerOk(a.spender)) v.add('ERouterNotAllowed');
				const t = tokenRule(a.token);
				if (!t) v.add('ETokenNotAllowed');
				else if (a.amount > t.maxPerTx) v.add('EAmountTooLarge');
				break;
			}
			case 'evm_swap_exact_in': {
				if (a.amountIn <= 0n) v.add('EZeroAmount');
				if (a.tokenIn.toLowerCase() === a.tokenOut.toLowerCase()) v.add('ESameToken');
				if (!routerOk(a.router)) v.add('ERouterNotAllowed');
				if (!destinationOk(a.recipient)) v.add('EDestinationNotAllowed');
				usdE8 = valueUsd(a.tokenIn, a.amountIn);
				const tin = tokenRule(a.tokenIn);
				const tout = tokenRule(a.tokenOut);
				if (!tout) v.add('ETokenNotAllowed');
				if (tin && tout) {
					const pin = price(tin);
					const pout = price(tout);
					if (pin !== undefined && pout !== undefined) {
						const expectedOut = (a.amountIn * pin * pow10(tout.decimals)) / (pout * pow10(tin.decimals));
						if (a.minAmountOut * BPS < expectedOut * (BPS - BigInt(rules.maxSlippageBps))) v.add('ESlippageTooHigh');
					}
				}
				break;
			}
		}
	} else {
		const a = payload.action;
		if (a.lamports <= 0n) v.add('EZeroAmount');
		if (!destinationOk(a.recipient)) v.add('EDestinationNotAllowed');
		usdE8 = valueUsd('', a.lamports);
	}

	// Daily window (same rollover as the contract's `begin`).
	const today = Math.floor(nowMs / MS_PER_DAY);
	const spent = today === state.day ? state.spentUsdE8 : 0n;
	const count = today === state.day ? state.txCount : 0;
	if (count + 1 > rules.maxTxPerDay) v.add('EDailyTxLimit');
	if (spent + usdE8 > rules.maxDailyUsdE8) v.add('EDailyUsdLimit');

	if (v.size > 0) return { ok: false, violations: [...v], usdE8 };

	const next: PolicyState = {
		...state,
		day: today,
		spentUsdE8: spent + usdE8,
		txCount: count + 1,
		evmNonces:
			payload.chain === 'evm'
				? { ...state.evmNonces, [chain.id]: payload.envelope.nonce + 1 }
				: state.evmNonces,
	};
	return { ok: true, usdE8, next };
}

export function formatUsdE8(v: bigint): string {
	const cents = v / 1_000_000n;
	return `$${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
}
