/**
 * Human-friendly policy rules file -> engine `Rules` (base units, e8 USD).
 * See config/policy.rules.example.json.
 */
import { getAddress, parseUnits } from 'viem';
import type { Rules } from './engine.js';

export interface RulesFile {
	maxDailyUsd: number;
	maxTxPerDay: number;
	maxSlippagePct: number;
	maxPriceAgeSec: number;
	evm?: {
		chainId: number;
		maxFeeGwei: number;
		maxPriorityGwei: number;
		maxGasLimit: number;
		tokens: { address: string; symbol: string; decimals: number; maxPerTx: string }[];
		destinations: string[];
		routers?: string[];
	}[];
	solana?: { cluster: number; maxPerTxSol: string; destinations: string[] }[];
}

export function rulesFromFile(f: RulesFile): Rules {
	const rules: Rules = {
		maxDailyUsdE8: BigInt(Math.round(f.maxDailyUsd * 100)) * 1_000_000n,
		maxTxPerDay: f.maxTxPerDay,
		maxSlippageBps: Math.round(f.maxSlippagePct * 100),
		maxPriceAgeMs: f.maxPriceAgeSec * 1000,
		chains: [],
		tokens: [],
		destinations: [],
		routers: [],
		evmGas: {},
	};
	for (const c of f.evm ?? []) {
		const chain = { kind: 'evm' as const, id: c.chainId };
		rules.chains.push(chain);
		rules.evmGas[c.chainId] = {
			maxFeePerGas: parseUnits(String(c.maxFeeGwei), 9),
			maxPriorityFeePerGas: parseUnits(String(c.maxPriorityGwei), 9),
			maxGasLimit: BigInt(c.maxGasLimit),
		};
		for (const t of c.tokens) {
			rules.tokens.push({
				chain,
				address: t.address ? getAddress(t.address) : '',
				oracleSymbol: t.symbol === 'WETH' ? 'ETH' : t.symbol,
				decimals: t.decimals,
				maxPerTx: parseUnits(t.maxPerTx, t.decimals),
			});
		}
		for (const d of c.destinations) rules.destinations.push({ chain, address: getAddress(d) });
		for (const r of c.routers ?? []) rules.routers.push({ chainId: c.chainId, address: getAddress(r) });
	}
	for (const s of f.solana ?? []) {
		const chain = { kind: 'solana' as const, id: s.cluster };
		rules.chains.push(chain);
		rules.tokens.push({ chain, address: '', oracleSymbol: 'SOL', decimals: 9, maxPerTx: parseUnits(s.maxPerTxSol, 9) });
		for (const d of s.destinations) rules.destinations.push({ chain, address: d });
	}
	if (rules.maxSlippageBps >= 10_000) throw new Error('maxSlippagePct must be < 100');
	return rules;
}
