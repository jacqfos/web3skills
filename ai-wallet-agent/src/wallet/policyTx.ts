/**
 * PTB builders for the wallet_policy Move package.
 *
 * `authorize()` is the only way this codebase obtains an Ika MessageApproval:
 * there is deliberately no helper that calls `coordinator::approve_message`
 * directly — the DWalletCap lives inside the Policy object, so that would fail
 * anyway.
 */
import type { IkaClient } from '@ika.xyz/sdk';
import { bcs } from '@mysten/sui/bcs';
import type { Transaction, TransactionArgument, TransactionObjectArgument } from '@mysten/sui/transactions';
import { hexToBytes } from 'viem';
import { base58Decode } from '../core/encoding/base58.js';
import type { Rules } from '../core/policy/engine.js';
import type { Payload } from '../core/types.js';

export interface PolicyConfig {
	packageId: string;
	policyId: string;
	priceBookId: string;
}

const CLOCK = '0x6';
const KIND = { evm: 0, solana: 1 } as const;
export const CURVE_ID = { SECP256K1: 0, ED25519: 2 } as const;

const bytes = (tx: Transaction, b: Uint8Array) => tx.pure(bcs.vector(bcs.u8()).serialize(b));
const addrBytes = (kind: 'evm' | 'solana', a: string): Uint8Array =>
	a === '' ? new Uint8Array() : kind === 'evm' ? hexToBytes(a as `0x${string}`) : base58Decode(a, 32);

/** Build a `Rules` value inside the PTB from the TS description. */
export function buildRules(tx: Transaction, pkg: string, r: Rules): TransactionArgument {
	const f = (name: string) => `${pkg}::policy::${name}`;
	const rules = tx.moveCall({
		target: f('new_rules'),
		arguments: [
			tx.pure.u64(r.maxDailyUsdE8),
			tx.pure.u64(r.maxTxPerDay),
			tx.pure.u64(r.maxSlippageBps),
			tx.pure.u64(r.maxPriceAgeMs),
		],
	});
	for (const c of r.chains) {
		if (c.kind === 'evm') {
			const g = r.evmGas[c.id];
			if (!g) throw new Error(`EVM chain ${c.id} needs gas caps`);
			tx.moveCall({
				target: f('rules_allow_evm_chain'),
				arguments: [rules, tx.pure.u64(c.id), tx.pure.u256(g.maxFeePerGas), tx.pure.u256(g.maxPriorityFeePerGas), tx.pure.u256(g.maxGasLimit)],
			});
		} else {
			tx.moveCall({ target: f('rules_allow_solana_cluster'), arguments: [rules, tx.pure.u64(c.id)] });
		}
	}
	for (const t of r.tokens) {
		tx.moveCall({
			target: f('rules_add_token'),
			arguments: [
				rules,
				tx.pure.u8(KIND[t.chain.kind]),
				tx.pure.u64(t.chain.id),
				bytes(tx, addrBytes(t.chain.kind, t.address)),
				bytes(tx, new TextEncoder().encode(t.oracleSymbol)),
				tx.pure.u8(t.decimals),
				tx.pure.u256(t.maxPerTx),
			],
		});
	}
	for (const d of r.destinations) {
		tx.moveCall({
			target: f('rules_add_destination'),
			arguments: [rules, tx.pure.u8(KIND[d.chain.kind]), tx.pure.u64(d.chain.id), bytes(tx, addrBytes(d.chain.kind, d.address))],
		});
	}
	for (const rt of r.routers) {
		tx.moveCall({
			target: f('rules_add_router'),
			arguments: [rules, tx.pure.u64(rt.chainId), bytes(tx, addrBytes('evm', rt.address))],
		});
	}
	return rules;
}

/** `policy::create` -> `add_dwallet(cap)` -> `share`, all in the DKG transaction. */
export function createPolicyWithCap(
	tx: Transaction,
	a: { pkg: string; owner: string; admin: string; priceBookId: string; rules: Rules; timelockMs: number; cap: TransactionObjectArgument; curve: number },
) {
	const rules = buildRules(tx, a.pkg, a.rules);
	const policy = tx.moveCall({
		target: `${a.pkg}::policy::create`,
		arguments: [tx.pure.address(a.owner), tx.pure.address(a.admin), tx.object(a.priceBookId), rules, tx.pure.u64(a.timelockMs)],
	});
	tx.moveCall({ target: `${a.pkg}::policy::add_dwallet`, arguments: [policy, a.cap, tx.pure.u32(a.curve)] });
	tx.moveCall({ target: `${a.pkg}::policy::share`, arguments: [policy] });
}

export function addDWalletToPolicy(tx: Transaction, cfg: PolicyConfig, cap: TransactionObjectArgument, curve: number) {
	tx.moveCall({ target: `${cfg.packageId}::policy::add_dwallet`, arguments: [tx.object(cfg.policyId), cap, tx.pure.u32(curve)] });
}

export function setChainAddress(tx: Transaction, cfg: PolicyConfig, curve: number, address: Uint8Array) {
	tx.moveCall({
		target: `${cfg.packageId}::policy::set_chain_address`,
		arguments: [tx.object(cfg.policyId), tx.pure.u32(curve), bytes(tx, address)],
	});
}

/**
 * POLICY CHECK. Adds the `authorize_*` call for `payload` and returns the
 * resulting MessageApproval. If any rule fails, the Move call aborts and the
 * whole PTB (including the Ika sign request after it) is reverted.
 */
export function authorize(
	tx: Transaction,
	ika: IkaClient,
	cfg: PolicyConfig,
	payload: Payload,
	proposalId: string,
): TransactionObjectArgument {
	const coord = ika.ikaConfig.objects.ikaDWalletCoordinator;
	const common = [
		tx.object(cfg.policyId),
		tx.sharedObjectRef({ objectId: coord.objectID, initialSharedVersion: coord.initialSharedVersion, mutable: true }),
		tx.object(cfg.priceBookId),
	];
	const pid = bytes(tx, new TextEncoder().encode(proposalId));
	const f = (name: string) => `${cfg.packageId}::policy::${name}`;

	if (payload.chain === 'solana') {
		const a = payload.action;
		return tx.moveCall({
			target: f('authorize_solana_transfer'),
			arguments: [
				...common,
				tx.pure.u64(a.cluster),
				bytes(tx, base58Decode(a.recipient, 32)),
				tx.pure.u64(a.lamports),
				bytes(tx, base58Decode(payload.envelope.recentBlockhash, 32)),
				pid,
				tx.object(CLOCK),
			],
		});
	}

	const e = payload.envelope;
	const a = payload.action;
	const envelope = [
		tx.pure.u64(a.chainId),
		tx.pure.u64(e.nonce),
		tx.pure.u256(e.maxPriorityFeePerGas),
		tx.pure.u256(e.maxFeePerGas),
		tx.pure.u256(e.gasLimit),
	];
	const h = (x: string) => bytes(tx, hexToBytes(x as `0x${string}`));
	switch (a.type) {
		case 'evm_transfer':
			return tx.moveCall({
				target: f('authorize_evm_transfer'),
				arguments: [...common, ...envelope, bytes(tx, a.token ? hexToBytes(a.token) : new Uint8Array()), h(a.recipient), tx.pure.u256(a.amount), pid, tx.object(CLOCK)],
			});
		case 'evm_erc20_approve':
			return tx.moveCall({
				target: f('authorize_evm_erc20_approve'),
				arguments: [...common, ...envelope, h(a.token), h(a.spender), tx.pure.u256(a.amount), pid, tx.object(CLOCK)],
			});
		case 'evm_swap_exact_in':
			return tx.moveCall({
				target: f('authorize_evm_swap_exact_in'),
				arguments: [
					...common,
					...envelope,
					h(a.router),
					h(a.tokenIn),
					h(a.tokenOut),
					tx.pure.u32(a.feeTier),
					h(a.recipient),
					tx.pure.u256(a.amountIn),
					tx.pure.u256(a.minAmountOut),
					pid,
					tx.object(CLOCK),
				],
			});
	}
}
