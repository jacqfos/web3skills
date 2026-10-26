import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { bytesToHex, encodeFunctionData, erc20Abi, parseAbi, serializeTransaction, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import {
	base58Decode,
	base58Encode,
	eip1559Unsigned,
	erc20ApproveCalldata,
	erc20TransferCalldata,
	exactInputSingleCalldata,
	systemTransferMessage,
} from '../src/core/encoding/index.js';
import type { EvmEnvelope, Hex } from '../src/core/types.js';

const env: EvmEnvelope = { nonce: 7, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_500_000_000n, gasLimit: 21_000n };
const to: Hex = '0x1111111111111111111111111111111111111111';
const usdc: Hex = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const weth: Hex = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const router: Hex = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

describe('EVM encoder matches viem', () => {
	it.each([
		['native transfer', 1, to, 100_000_000_000_000_000n, '0x' as Hex],
		['zero nonce/value edge', 11155111, to, 0n, '0x' as Hex],
		['erc20 transfer', 1, usdc, 0n, bytesToHex(erc20TransferCalldata(to, 50_000_000n))],
	])('%s', (_name, chainId, txTo, value, data) => {
		const ours = eip1559Unsigned(chainId, { ...env, nonce: chainId === 1 ? 7 : 0 }, txTo, value, Buffer.from(data.slice(2), 'hex'));
		const viem = serializeTransaction({
			type: 'eip1559',
			chainId,
			nonce: chainId === 1 ? 7 : 0,
			maxFeePerGas: env.maxFeePerGas,
			maxPriorityFeePerGas: env.maxPriorityFeePerGas,
			gas: env.gasLimit,
			to: txTo,
			value,
			data,
		});
		expect(bytesToHex(ours)).toBe(viem);
	});

	it('handles long (>55 byte) payloads', () => {
		const data = exactInputSingleCalldata({ tokenIn: usdc, tokenOut: weth, feeTier: 500, recipient: to, amountIn: 320_000_000n, minAmountOut: 99n });
		const ours = eip1559Unsigned(1, env, router, 0n, data);
		const viem = serializeTransaction({
			type: 'eip1559', chainId: 1, nonce: env.nonce, maxFeePerGas: env.maxFeePerGas,
			maxPriorityFeePerGas: env.maxPriorityFeePerGas, gas: env.gasLimit, to: router, value: 0n, data: bytesToHex(data),
		});
		expect(bytesToHex(ours)).toBe(viem);
	});

	it('ERC-20 calldata matches the ABI', () => {
		expect(bytesToHex(erc20TransferCalldata(to, 50_000_000n))).toBe(
			encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, 50_000_000n] }),
		);
		expect(bytesToHex(erc20ApproveCalldata(router, 1n))).toBe(
			encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [router, 1n] }),
		);
	});

	it('exactInputSingle calldata matches SwapRouter02 ABI', () => {
		const abi = parseAbi([
			'struct P { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
			'function exactInputSingle(P params) payable returns (uint256)',
		]);
		expect(toFunctionSelector(abi[0]!)).toBe('0x04e45aaf');
		const expected = encodeFunctionData({
			abi,
			functionName: 'exactInputSingle',
			args: [{ tokenIn: usdc, tokenOut: weth, fee: 500, recipient: to, amountIn: 320_000_000n, amountOutMinimum: 99n, sqrtPriceLimitX96: 0n }],
		});
		const ours = exactInputSingleCalldata({ tokenIn: usdc, tokenOut: weth, feeTier: 500, recipient: to, amountIn: 320_000_000n, minAmountOut: 99n });
		expect(bytesToHex(ours)).toBe(expected);
	});
});

describe('Solana encoder matches @solana/web3.js', () => {
	it('system transfer message', () => {
		const from = Keypair.generate().publicKey;
		const dest = Keypair.generate().publicKey;
		const blockhash = base58Encode(Keypair.generate().publicKey.toBytes());
		const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash }).add(
			SystemProgram.transfer({ fromPubkey: from, toPubkey: dest, lamports: 123_456_789n }),
		);
		const expected = tx.serializeMessage();
		const ours = systemTransferMessage(from.toBytes(), dest.toBytes(), 123_456_789n, base58Decode(blockhash));
		expect(Buffer.from(ours).toString('hex')).toBe(expected.toString('hex'));
	});

	it('base58 round-trips', () => {
		for (let i = 0; i < 20; i++) {
			const pk = Keypair.generate().publicKey;
			expect(base58Encode(pk.toBytes())).toBe(pk.toBase58());
			expect(new PublicKey(base58Decode(pk.toBase58())).equals(pk)).toBe(true);
		}
		expect(base58Encode(new Uint8Array(32))).toBe(SystemProgram.programId.toBase58());
	});
});
