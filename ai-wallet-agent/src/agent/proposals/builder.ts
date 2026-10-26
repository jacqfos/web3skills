/**
 * Intent -> Proposal(s).
 *
 * The builder only produces typed payloads + the bytes it *expects* to be
 * signed. It holds no keys and cannot authorize anything; a wrong or malicious
 * proposal here is caught by the wallet review and the on-chain policy.
 */
import { randomUUID } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import type { AdapterRegistry } from '../../core/chains/adapter.js';
import { isSolanaAddress } from '../../core/chains/solana.js';
import { messageHexFor } from '../../core/encoding/index.js';
import { evaluate, type PolicyState, type Prices, type Rules } from '../../core/policy/engine.js';
import type { ChainRef, EvmAction, Hex, Payload, Proposal } from '../../core/types.js';
import { CHAINS, SWAP_ROUTERS, type AssetRegistry } from '../assets.js';
import type { BuyIntent, TransferIntent } from '../intent/schema.js';
import { toUsdE8, type PriceSource } from '../prices.js';

/** What the agent knows about the on-chain policy (read-only). */
export interface PolicySnapshotSource {
	snapshot(): Promise<{ rules: Rules; state: PolicyState; prices: Prices }>;
}

export interface WalletAddresses {
	/** Sui address that owns the policy (the user's device key). */
	owner: string;
	evm?: Hex;
	solana?: string;
}

export interface BuilderDeps {
	assets: AssetRegistry;
	adapters: AdapterRegistry;
	policy: PolicySnapshotSource;
	prices: PriceSource;
	wallet: WalletAddresses;
	addressBook: Record<string, string>; // label -> address
	defaultChain: ChainRef;
	proposalTtlMs: number;
	defaultSlippageBps: number;
	now?: () => number;
}

export class ProposalBuilder {
	constructor(private d: BuilderDeps) {}

	private now() {
		return (this.d.now ?? Date.now)();
	}

	async fromTransfer(intent: TransferIntent, userText: string): Promise<Proposal[]> {
		const chain = intent.chain ? CHAINS[intent.chain] : this.d.assets.defaultChainFor(intent.asset, this.d.defaultChain);
		const asset = this.d.assets.require(intent.asset, chain);
		const amount = this.d.assets.toBaseUnits(asset, intent.amount);
		const recipient = this.resolveRecipient(intent.recipient, chain);

		if (chain.kind === 'evm') {
			const action: EvmAction = {
				type: 'evm_transfer',
				chainId: chain.id,
				token: asset.address ? getAddress(asset.address) : null,
				recipient: recipient as Hex,
				amount,
			};
			return this.evmSequence([action], userText, `Send ${intent.amount} ${asset.symbol} to ${intent.recipient}`);
		}
		const from = this.requireAddress('solana');
		const action = { type: 'solana_transfer' as const, cluster: chain.id, recipient, lamports: amount };
		const envelope = await this.d.adapters.solana(chain.id).prepareEnvelope(from, action);
		const snap = await this.d.policy.snapshot();
		return [this.finish({ chain: 'solana', action, envelope }, snap, userText, `Send ${intent.amount} SOL to ${intent.recipient}`).proposal];
	}

	/**
	 * "Buy X of A" as an exact-input swap that spends at most X·price·(1+s) of
	 * the pay asset and requires at least X of A out. With the policy's oracle
	 * check this passes iff s <= max_slippage.
	 */
	async fromBuy(intent: BuyIntent, userText: string): Promise<Proposal[]> {
		const chain = intent.chain ? CHAINS[intent.chain] : this.d.defaultChain;
		if (chain.kind !== 'evm') throw new Error('Swaps are EVM-only in v1');
		const buySymbol = intent.buy_asset.toUpperCase() === 'ETH' ? 'WETH' : intent.buy_asset; // v1: router pays out WETH
		const buy = this.d.assets.require(buySymbol, chain);
		const pay = this.d.assets.require(intent.pay_asset ?? 'USDC', chain);
		const router = SWAP_ROUTERS[chain.id];
		if (!router) throw new Error(`No swap router configured for chain ${chain.id}`);
		const from = this.requireAddress('evm') as Hex;
		const recipient = this.resolveRecipient(intent.recipient, chain) as Hex;

		const snap = await this.d.policy.snapshot();
		const slippageBps = intent.max_slippage_pct
			? Math.round(Number(intent.max_slippage_pct) * 100)
			: Math.min(this.d.defaultSlippageBps, snap.rules.maxSlippageBps);

		const px = await this.d.prices.usd([buy.priceSymbol, pay.priceSymbol]);
		const pBuy = px[buy.priceSymbol];
		const pPay = px[pay.priceSymbol];
		if (!pBuy || !pPay) throw new Error('Price unavailable; not preparing a swap blind.');
		const buyAmount = this.d.assets.toBaseUnits(buy, intent.buy_amount);
		const num = buyAmount * toUsdE8(pBuy) * 10n ** BigInt(pay.decimals) * BigInt(10_000 + slippageBps);
		const den = toUsdE8(pPay) * 10n ** BigInt(buy.decimals) * 10_000n;
		const amountIn = (num + den - 1n) / den; // round up

		const actions: EvmAction[] = [];
		const allowance = await this.d.adapters.evm(chain.id).allowance(from, pay.address as Hex, router);
		if (allowance < amountIn) {
			actions.push({ type: 'evm_erc20_approve', chainId: chain.id, token: getAddress(pay.address), spender: router, amount: amountIn });
		}
		actions.push({
			type: 'evm_swap_exact_in',
			chainId: chain.id,
			router,
			tokenIn: getAddress(pay.address),
			tokenOut: getAddress(buy.address),
			feeTier: 500,
			recipient,
			amountIn,
			minAmountOut: buyAmount,
		});
		return this.evmSequence(actions, userText, `Buy ${intent.buy_amount} ${intent.buy_asset} with ≤${(slippageBps / 100).toFixed(2)}% slippage`);
	}

	/** Build consecutive-nonce EVM proposals and pre-check them in order. */
	private async evmSequence(actions: EvmAction[], userText: string, summary: string): Promise<Proposal[]> {
		const from = this.requireAddress('evm') as Hex;
		const chainId = actions[0]!.chainId;
		const adapter = this.d.adapters.evm(chainId);
		let snap = await this.d.policy.snapshot();
		const policyNonce = snap.state.evmNonces[chainId] ?? 0;
		const chainNonce = await adapter.pendingNonce(from);
		if (policyNonce !== chainNonce) {
			throw new Error(
				`Policy nonce ${policyNonce} != chain nonce ${chainNonce}: a signed tx was likely never broadcast. Resync from the wallet (policy::set_evm_nonce).`,
			);
		}
		const out: Proposal[] = [];
		for (const [i, action] of actions.entries()) {
			const envelope = await adapter.prepareEnvelope(from, action, policyNonce + i);
			const step = actions.length > 1 ? `${summary} (step ${i + 1}/${actions.length}: ${action.type})` : summary;
			const { proposal, next } = this.finish({ chain: 'evm', action, envelope }, snap, userText, step);
			out.push(proposal);
			// Later steps are checked against the state after earlier ones (spend, tx count, nonce).
			if (next) snap = { ...snap, state: next };
		}
		return out;
	}

	private finish(
		payload: Payload,
		snap: { rules: Rules; state: PolicyState; prices: Prices },
		userText: string,
		summary: string,
	): { proposal: Proposal; next?: PolicyState } {
		const now = this.now();
		const ev = evaluate(snap.rules, snap.state, payload, snap.prices, now, this.d.wallet.owner);
		const proposal: Proposal = {
			id: randomUUID(),
			createdAt: now,
			expiresAt: now + this.d.proposalTtlMs,
			userText,
			agentSummary: summary,
			payload,
			messageHex: messageHexFor(payload, this.d.wallet.solana),
			precheck: { ok: ev.ok, violations: ev.ok ? [] : ev.violations, usdE8: ev.usdE8.toString() },
			status: ev.ok ? 'pending_approval' : 'rejected_by_policy',
		};
		return { proposal, next: ev.ok ? ev.next : undefined };
	}

	private resolveRecipient(r: string, chain: ChainRef): string {
		if (r === 'self') return this.requireAddress(chain.kind);
		const label = Object.keys(this.d.addressBook).find((k) => k.toLowerCase() === r.toLowerCase());
		const addr = label ? this.d.addressBook[label]! : r;
		if (chain.kind === 'evm') {
			if (!isAddress(addr, { strict: false })) throw new Error(`"${r}" is not a valid EVM address`);
			return getAddress(addr);
		}
		if (!isSolanaAddress(addr)) throw new Error(`"${r}" is not a valid Solana address`);
		return addr;
	}

	private requireAddress(kind: 'evm' | 'solana'): string {
		const a = kind === 'evm' ? this.d.wallet.evm : this.d.wallet.solana;
		if (!a) throw new Error(`No ${kind} dWallet yet — create one from the wallet app first.`);
		return a;
	}
}
