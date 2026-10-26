/**
 * Shared domain types.
 *
 * A `Payload` is a fully-typed transaction description. It is the ONLY thing
 * that crosses from the (untrusted) agent to the (trusted) wallet: the wallet
 * re-derives the bytes to sign from it, and the on-chain policy derives them
 * again. Raw tx bytes are never accepted from the agent.
 */

export type Hex = `0x${string}`;

export type ChainKind = 'evm' | 'solana';

/** EVM: `id` = EIP-155 chain id. Solana: `id` = cluster tag (101 mainnet-beta, 102 testnet, 103 devnet). */
export interface ChainRef {
	kind: ChainKind;
	id: number;
}

export const SOLANA_CLUSTER = { mainnet: 101, testnet: 102, devnet: 103 } as const;

// ---- Actions (mirror the policy's authorize_* functions 1:1) ----

export interface EvmTransfer {
	type: 'evm_transfer';
	chainId: number;
	/** null = native ETH */
	token: Hex | null;
	recipient: Hex;
	amount: bigint;
}

export interface EvmErc20Approve {
	type: 'evm_erc20_approve';
	chainId: number;
	token: Hex;
	spender: Hex;
	amount: bigint;
}

export interface EvmSwapExactIn {
	type: 'evm_swap_exact_in';
	chainId: number;
	router: Hex;
	tokenIn: Hex;
	tokenOut: Hex;
	feeTier: number;
	recipient: Hex;
	amountIn: bigint;
	minAmountOut: bigint;
}

export interface SolanaTransfer {
	type: 'solana_transfer';
	cluster: number;
	/** base58 pubkey */
	recipient: string;
	lamports: bigint;
}

export type EvmAction = EvmTransfer | EvmErc20Approve | EvmSwapExactIn;
export type SolanaAction = SolanaTransfer;

/** Chain-specific fields the policy needs that do not come from the user's intent. */
export interface EvmEnvelope {
	nonce: number;
	maxFeePerGas: bigint;
	maxPriorityFeePerGas: bigint;
	gasLimit: bigint;
}

export interface SolanaEnvelope {
	/** base58 blockhash; it expires after ~150 slots, which bounds the signing window */
	recentBlockhash: string;
}

export type Payload =
	| { chain: 'evm'; action: EvmAction; envelope: EvmEnvelope }
	| { chain: 'solana'; action: SolanaAction; envelope: SolanaEnvelope };

// ---- Proposals ----

export type ProposalStatus =
	| 'pending_approval'
	| 'rejected_by_user'
	| 'rejected_by_policy'
	| 'signed'
	| 'broadcast'
	| 'failed'
	| 'expired';

export interface Proposal {
	id: string;
	createdAt: number;
	/** The wallet refuses to sign after this. Keeps stale proposals from being approved later. */
	expiresAt: number;
	/** The user's own words that produced this proposal. */
	userText: string;
	/** Agent-written description. Display-only; the wallet renders its own summary from `payload`. */
	agentSummary: string;
	payload: Payload;
	/** Message the agent expects to be signed. The wallet recomputes it and refuses on mismatch. */
	messageHex: Hex;
	/** Result of the agent's off-chain policy pre-check (UX only, not a security boundary). */
	precheck: { ok: boolean; violations: string[]; usdE8: string };
	status: ProposalStatus;
	txHash?: string;
	error?: string;
}
