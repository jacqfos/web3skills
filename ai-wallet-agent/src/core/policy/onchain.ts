/**
 * Read the live Policy object from Sui and convert it to the TS engine's types,
 * so the agent's pre-check sees the real nonce, spend-so-far, pause flag and
 * allow-lists. The BCS layout mirrors `struct Policy` in policy.move — keep
 * them in sync.
 */
import { bcs, type BcsType } from '@mysten/sui/bcs';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { bytesToHex, getAddress } from 'viem';
import { base58Encode } from '../encoding/base58.js';
import type { ChainRef } from '../types.js';
import type { PolicyState, Rules } from './engine.js';

/** Sui `VecMap<K, V>` is BCS-encoded as `vector<Entry { key: K, value: V }>`; `VecSet<K>` as `vector<K>`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vecMap = (k: BcsType<any>, v: BcsType<any>) => bcs.vector(bcs.struct('Entry', { key: k, value: v }));

const ChainKey = bcs.struct('ChainKey', { kind: bcs.u8(), id: bcs.u64() });
const ChainAddress = bcs.struct('ChainAddress', { chain: ChainKey, address: bcs.vector(bcs.u8()) });
const TokenRule = bcs.struct('TokenRule', { oracle_symbol: bcs.vector(bcs.u8()), decimals: bcs.u8(), max_per_tx: bcs.u256() });
const GasRule = bcs.struct('GasRule', { max_fee_per_gas: bcs.u256(), max_priority_fee_per_gas: bcs.u256(), max_gas_limit: bcs.u256() });
const RulesBcs = bcs.struct('Rules', {
	max_daily_usd_e8: bcs.u64(),
	max_tx_per_day: bcs.u64(),
	max_slippage_bps: bcs.u64(),
	max_price_age_ms: bcs.u64(),
	chains: bcs.vector(ChainKey), // VecSet
	tokens: vecMap(ChainAddress, TokenRule),
	destinations: bcs.vector(ChainAddress),
	routers: bcs.vector(ChainAddress),
	evm_gas: vecMap(bcs.u64(), GasRule),
});
const PolicyBcs = bcs.struct('Policy', {
	id: bcs.Address,
	owner: bcs.Address,
	admin: bcs.Address,
	price_book: bcs.Address,
	rules: RulesBcs,
	paused: bcs.bool(),
	rule_timelock_ms: bcs.u64(),
	pending_rules: bcs.option(bcs.struct('PendingRules', { rules: RulesBcs, effective_ms: bcs.u64() })),
	pending_withdrawal: bcs.option(bcs.struct('PendingWithdrawal', { curve: bcs.u32(), effective_ms: bcs.u64() })),
	day: bcs.u64(),
	spent_usd_e8: bcs.u64(),
	tx_count: bcs.u64(),
	evm_nonces: vecMap(bcs.u64(), bcs.u64()),
	dwallets: vecMap(bcs.u32(), bcs.struct('DWalletInfo', { chain_address: bcs.option(bcs.vector(bcs.u8())) })),
});

const chainRef = (c: { kind: number; id: string }): ChainRef => ({ kind: c.kind === 0 ? 'evm' : 'solana', id: Number(c.id) });
const addrStr = (chain: ChainRef, b: number[]) =>
	b.length === 0 ? '' : chain.kind === 'evm' ? getAddress(bytesToHex(Uint8Array.from(b))) : base58Encode(Uint8Array.from(b));

export interface OnchainPolicy {
	rules: Rules;
	state: PolicyState;
	admin: string;
	pendingRulesEffectiveMs?: number;
}

export async function readPolicy(client: ClientWithCoreApi, policyId: string): Promise<OnchainPolicy> {
	const { object } = await client.core.getObject({ objectId: policyId, include: { content: true } });
	const p = PolicyBcs.parse(object.content) as unknown as PolicyRaw;
	const r = p.rules;
	const rules: Rules = {
		maxDailyUsdE8: BigInt(r.max_daily_usd_e8),
		maxTxPerDay: Number(r.max_tx_per_day),
		maxSlippageBps: Number(r.max_slippage_bps),
		maxPriceAgeMs: Number(r.max_price_age_ms),
		chains: r.chains.map(chainRef),
		tokens: r.tokens.map(({ key, value }) => {
			const chain = chainRef(key.chain);
			return {
				chain,
				address: addrStr(chain, key.address),
				oracleSymbol: new TextDecoder().decode(Uint8Array.from(value.oracle_symbol)),
				decimals: value.decimals,
				maxPerTx: BigInt(value.max_per_tx),
			};
		}),
		destinations: r.destinations.map((d) => {
			const chain = chainRef(d.chain);
			return { chain, address: addrStr(chain, d.address) };
		}),
		routers: r.routers.map((d) => ({ chainId: Number(d.chain.id), address: addrStr(chainRef(d.chain), d.address) })),
		evmGas: Object.fromEntries(
			r.evm_gas.map(({ key, value }) => [
				Number(key),
				{ maxFeePerGas: BigInt(value.max_fee_per_gas), maxPriorityFeePerGas: BigInt(value.max_priority_fee_per_gas), maxGasLimit: BigInt(value.max_gas_limit) },
			]),
		),
	};
	return {
		rules,
		admin: p.admin,
		pendingRulesEffectiveMs: p.pending_rules ? Number(p.pending_rules.effective_ms) : undefined,
		state: {
			owner: p.owner,
			paused: p.paused,
			day: Number(p.day),
			spentUsdE8: BigInt(p.spent_usd_e8),
			txCount: Number(p.tx_count),
			evmNonces: Object.fromEntries(p.evm_nonces.map(({ key, value }) => [Number(key), Number(value)])),
		},
	};
}

// Parsed shape (bcs returns u64/u256 as strings).
interface ChainKeyRaw { kind: number; id: string }
interface ChainAddressRaw { chain: ChainKeyRaw; address: number[] }
interface RulesRaw {
	max_daily_usd_e8: string;
	max_tx_per_day: string;
	max_slippage_bps: string;
	max_price_age_ms: string;
	chains: ChainKeyRaw[];
	tokens: { key: ChainAddressRaw; value: { oracle_symbol: number[]; decimals: number; max_per_tx: string } }[];
	destinations: ChainAddressRaw[];
	routers: ChainAddressRaw[];
	evm_gas: { key: string; value: { max_fee_per_gas: string; max_priority_fee_per_gas: string; max_gas_limit: string } }[];
}
interface PolicyRaw {
	owner: string;
	admin: string;
	rules: RulesRaw;
	paused: boolean;
	pending_rules: { effective_ms: string } | null;
	day: string;
	spent_usd_e8: string;
	tx_count: string;
	evm_nonces: { key: string; value: string }[];
}
