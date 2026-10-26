/**
 * Independent proposal verification — runs on the user's device BEFORE the
 * user is asked to approve.
 *
 * The agent is untrusted, so nothing it says is shown as fact:
 *   - the message bytes are recomputed here from the typed payload and must
 *     equal the agent's `messageHex` (and, on-chain, the policy rebuilds them
 *     a third time);
 *   - the human-readable summary is rendered here from the payload, not taken
 *     from `agentSummary`;
 *   - every address is checked against the user's own labels.
 */
import { bytesToHex, formatUnits } from 'viem';
import { messageFor } from '../core/encoding/index.js';
import { ProposalVerificationError } from '../core/errors.js';
import type { Proposal } from '../core/types.js';

export interface TokenLabel {
	chain: 'evm' | 'solana';
	chainId: number;
	address: string; // '' = native
	symbol: string;
	decimals: number;
}

export interface ReviewContext {
	now: number;
	/** The dWallet's Solana address (fee payer), if a Solana dWallet exists. */
	solanaFrom?: string;
	tokens: TokenLabel[];
	/** User-maintained address book: address -> label. */
	addressBook: Record<string, string>;
}

export interface Review {
	message: Uint8Array;
	lines: string[];
	warnings: string[];
}

export function reviewProposal(p: Proposal, ctx: ReviewContext): Review {
	if (ctx.now > p.expiresAt) throw new ProposalVerificationError('Proposal expired; ask the agent for a fresh one.');

	const message = messageFor(p.payload, ctx.solanaFrom);
	if (bytesToHex(message) !== p.messageHex.toLowerCase()) {
		throw new ProposalVerificationError(
			'The bytes the agent wants signed do not match the transaction it describes. Refusing to sign.',
		);
	}

	const warnings: string[] = [];
	const label = (addr: string) => {
		const key = Object.keys(ctx.addressBook).find((k) => k.toLowerCase() === addr.toLowerCase());
		if (!key) {
			warnings.push(`Address ${addr} is not in your address book.`);
			return addr;
		}
		return `${ctx.addressBook[key]} (${addr})`;
	};
	const amount = (chain: 'evm' | 'solana', chainId: number, token: string, v: bigint) => {
		const t = ctx.tokens.find(
			(x) => x.chain === chain && x.chainId === chainId && x.address.toLowerCase() === token.toLowerCase(),
		);
		if (!t) {
			warnings.push(`Unknown token ${token || 'native'}; showing raw base units.`);
			return `${v} base units of ${token || 'native'}`;
		}
		return `${formatUnits(v, t.decimals)} ${t.symbol}`;
	};

	const lines: string[] = [];
	if (p.payload.chain === 'evm') {
		const a = p.payload.action;
		const e = p.payload.envelope;
		const net = `EVM chain ${a.chainId}`;
		switch (a.type) {
			case 'evm_transfer':
				lines.push(`SEND ${amount('evm', a.chainId, a.token ?? '', a.amount)} on ${net}`, `  to ${label(a.recipient)}`);
				break;
			case 'evm_erc20_approve':
				lines.push(`ALLOW ${label(a.spender)} to spend up to ${amount('evm', a.chainId, a.token, a.amount)} on ${net}`);
				break;
			case 'evm_swap_exact_in':
				lines.push(
					`SWAP ${amount('evm', a.chainId, a.tokenIn, a.amountIn)} for at least ${amount('evm', a.chainId, a.tokenOut, a.minAmountOut)} on ${net}`,
					`  via router ${label(a.router)} (fee tier ${a.feeTier / 10_000}%)`,
					`  proceeds to ${label(a.recipient)}`,
				);
				break;
		}
		const maxFeeEth = formatUnits(e.maxFeePerGas * e.gasLimit, 18);
		lines.push(`  nonce ${e.nonce}, max network fee ${maxFeeEth} ETH`);
	} else {
		const a = p.payload.action;
		lines.push(`SEND ${amount('solana', a.cluster, '', a.lamports)} on Solana (cluster ${a.cluster})`, `  to ${label(a.recipient)}`);
	}
	lines.push(`  expires ${new Date(p.expiresAt).toISOString()}`);
	if (!p.precheck.ok) warnings.push(`Agent pre-check expects the policy to reject this: ${p.precheck.violations.join(', ')}`);
	return { message, lines, warnings };
}
