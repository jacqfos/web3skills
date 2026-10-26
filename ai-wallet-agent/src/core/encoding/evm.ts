/**
 * Byte-exact TypeScript port of contracts/policy/sources/{rlp,evm}.move.
 *
 * The wallet uses this to recompute — independently of the agent — the exact
 * bytes the policy will approve, and to render them for the user.
 * test/encoding.test.ts checks it against viem's serializer.
 */
import { bytesToHex, hexToBytes, keccak256, parseTransaction, recoverAddress, serializeTransaction } from 'viem';
import type { EvmAction, EvmEnvelope, Hex } from '../types.js';

// ---- RLP (mirrors rlp.move) ----

function minBigEndian(v: bigint): Uint8Array {
	if (v < 0n) throw new Error('negative integer');
	const out: number[] = [];
	while (v > 0n) {
		out.unshift(Number(v & 0xffn));
		v >>= 8n;
	}
	return Uint8Array.from(out);
}

function encodeLength(len: number, offset: number): Uint8Array {
	if (len < 56) return Uint8Array.of(offset + len);
	const lb = minBigEndian(BigInt(len));
	return concat(Uint8Array.of(offset + 55 + lb.length), lb);
}

export function rlpBytes(b: Uint8Array): Uint8Array {
	if (b.length === 1 && b[0]! < 0x80) return b;
	return concat(encodeLength(b.length, 0x80), b);
}

export function rlpUint(v: bigint): Uint8Array {
	return rlpBytes(minBigEndian(v));
}

export function rlpList(items: Uint8Array[]): Uint8Array {
	const payload = concat(...items);
	return concat(encodeLength(payload.length, 0xc0), payload);
}

// ---- Calldata (mirrors evm.move) ----

const SEL_ERC20_TRANSFER = hexToBytes('0xa9059cbb');
const SEL_ERC20_APPROVE = hexToBytes('0x095ea7b3');
/** SwapRouter02 exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) */
const SEL_EXACT_INPUT_SINGLE = hexToBytes('0x04e45aaf');

function wordAddress(addr: Hex): Uint8Array {
	const b = hexToBytes(addr);
	if (b.length !== 20) throw new Error(`bad address ${addr}`);
	return concat(new Uint8Array(12), b);
}

function wordUint(v: bigint): Uint8Array {
	const out = new Uint8Array(32);
	for (let i = 31; i >= 0; i--) {
		out[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return out;
}

export function erc20TransferCalldata(recipient: Hex, amount: bigint): Uint8Array {
	return concat(SEL_ERC20_TRANSFER, wordAddress(recipient), wordUint(amount));
}

export function erc20ApproveCalldata(spender: Hex, amount: bigint): Uint8Array {
	return concat(SEL_ERC20_APPROVE, wordAddress(spender), wordUint(amount));
}

export function exactInputSingleCalldata(a: {
	tokenIn: Hex;
	tokenOut: Hex;
	feeTier: number;
	recipient: Hex;
	amountIn: bigint;
	minAmountOut: bigint;
}): Uint8Array {
	if (a.feeTier < 0 || a.feeTier >= 1 << 24) throw new Error('bad fee tier');
	return concat(
		SEL_EXACT_INPUT_SINGLE,
		wordAddress(a.tokenIn),
		wordAddress(a.tokenOut),
		wordUint(BigInt(a.feeTier)),
		wordAddress(a.recipient),
		wordUint(a.amountIn),
		wordUint(a.minAmountOut),
		wordUint(0n),
	);
}

// ---- Transactions ----

/** `0x02 || rlp([chainId, nonce, maxPriorityFee, maxFee, gasLimit, to, value, data, []])` */
export function eip1559Unsigned(
	chainId: number,
	env: EvmEnvelope,
	to: Hex,
	value: bigint,
	data: Uint8Array,
): Uint8Array {
	const toBytes = hexToBytes(to);
	if (toBytes.length !== 20) throw new Error(`bad address ${to}`);
	return concat(
		Uint8Array.of(0x02),
		rlpList([
			rlpUint(BigInt(chainId)),
			rlpUint(BigInt(env.nonce)),
			rlpUint(env.maxPriorityFeePerGas),
			rlpUint(env.maxFeePerGas),
			rlpUint(env.gasLimit),
			rlpBytes(toBytes),
			rlpUint(value),
			rlpBytes(data),
			rlpList([]),
		]),
	);
}

/** The (to, value, data) of an action — exactly what the policy's `check_evm_*` functions build. */
export function evmCallFor(a: EvmAction): { to: Hex; value: bigint; data: Uint8Array } {
	switch (a.type) {
		case 'evm_transfer':
			return a.token === null
				? { to: a.recipient, value: a.amount, data: new Uint8Array() }
				: { to: a.token, value: 0n, data: erc20TransferCalldata(a.recipient, a.amount) };
		case 'evm_erc20_approve':
			return { to: a.token, value: 0n, data: erc20ApproveCalldata(a.spender, a.amount) };
		case 'evm_swap_exact_in':
			return { to: a.router, value: 0n, data: exactInputSingleCalldata(a) };
	}
}

/** The message the policy builds (and Ika signs, hash = KECCAK256) for this action. */
export function evmMessage(action: EvmAction, env: EvmEnvelope): Uint8Array {
	const { to, value, data } = evmCallFor(action);
	return eip1559Unsigned(action.chainId, env, to, value, data);
}

/**
 * Attach an Ika ECDSA signature (64-byte r||s) to the unsigned tx. Ika does not
 * return a recovery id, so try both parities and keep the one that recovers to
 * the dWallet's address.
 */
export async function attachEvmSignature(unsigned: Uint8Array, rs: Uint8Array, expectedFrom: Hex): Promise<Hex> {
	if (rs.length !== 64) throw new Error(`expected 64-byte signature, got ${rs.length}`);
	const tx = parseTransaction(bytesToHex(unsigned));
	const r = bytesToHex(rs.slice(0, 32));
	const s = bytesToHex(rs.slice(32));
	const hash = keccak256(unsigned);
	for (const yParity of [0, 1] as const) {
		const addr = await recoverAddress({ hash, signature: { r, s, yParity } });
		if (addr.toLowerCase() === expectedFrom.toLowerCase()) {
			return serializeTransaction(tx, { r, s, yParity });
		}
	}
	throw new Error('signature does not recover to the dWallet address');
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
