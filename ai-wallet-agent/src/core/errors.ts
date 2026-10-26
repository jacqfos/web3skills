/**
 * Error types with user-facing messages. Policy error codes match the abort
 * codes in contracts/policy/sources/policy.move so an on-chain abort can be
 * translated back to the same explanation the pre-check gives.
 */

export const POLICY_ERRORS = {
	0: ['ENotOwner', 'Only the wallet owner can authorize transactions.'],
	1: ['ENotAdmin', 'Only the admin key can do this.'],
	2: ['EPaused', 'The wallet is paused.'],
	3: ['EChainNotAllowed', 'This chain is not enabled in your policy.'],
	4: ['ETokenNotAllowed', 'This token is not on your allow-list.'],
	5: ['EDestinationNotAllowed', 'This destination address is not on your allow-list.'],
	6: ['EAmountTooLarge', 'Amount exceeds the per-transaction limit for this token.'],
	7: ['EDailyUsdLimit', 'This would exceed your daily USD spending limit.'],
	8: ['EDailyTxLimit', 'Daily transaction count limit reached.'],
	9: ['ESlippageTooHigh', 'Minimum output is below your maximum slippage setting.'],
	10: ['EGasTooHigh', 'Gas settings exceed your policy caps.'],
	11: ['EBadNonce', 'Transaction nonce does not match the policy (resync needed).'],
	12: ['ERouterNotAllowed', 'This swap router / spender is not allow-listed.'],
	13: ['ENoDWallet', 'No dWallet registered for this curve.'],
	14: ['EDWalletExists', 'A dWallet for this curve is already registered.'],
	15: ['ETimelockActive', 'This change is still timelocked.'],
	16: ['ENothingPending', 'Nothing pending.'],
	17: ['EZeroAmount', 'Amount must be greater than zero.'],
	18: ['EWrongPriceBook', 'Wrong price oracle object.'],
	19: ['ENotTightening', 'That change would loosen the policy; use the timelocked admin flow.'],
	20: ['ESameToken', 'Cannot swap a token for itself.'],
	21: ['EAddressAlreadySet', 'Chain address already set.'],
	22: ['EAddressNotSet', 'Chain address for this dWallet is not set yet.'],
	23: ['EBadSlippageRule', 'Invalid slippage rule.'],
} as const satisfies Record<number, readonly [string, string]>;

export type PolicyErrorName = (typeof POLICY_ERRORS)[keyof typeof POLICY_ERRORS][0];

export function policyErrorMessage(name: PolicyErrorName): string {
	for (const [n, msg] of Object.values(POLICY_ERRORS)) if (n === name) return msg;
	return name;
}

/** Map a Move abort (`... MoveAbort(..., <code>) in wallet_policy::policy ...`) to a readable message. */
export function explainMoveAbort(errorText: string): string | undefined {
	const m = /MoveAbort\(.*?(\d+)\)/.exec(errorText);
	if (!m || !errorText.includes('policy')) return undefined;
	const entry = POLICY_ERRORS[Number(m[1]) as keyof typeof POLICY_ERRORS];
	return entry ? `${entry[0]}: ${entry[1]}` : undefined;
}

export class PolicyViolationError extends Error {
	constructor(readonly violations: PolicyErrorName[]) {
		super(violations.map(policyErrorMessage).join(' '));
		this.name = 'PolicyViolationError';
	}
}

/** The wallet's independent verification failed: never sign. */
export class ProposalVerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProposalVerificationError';
	}
}

export class UserRejectedError extends Error {
	constructor() {
		super('User rejected the proposal.');
		this.name = 'UserRejectedError';
	}
}
