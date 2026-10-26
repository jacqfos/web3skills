import { bytesToHex, createPublicClient, erc20Abi, http, type Chain, type PublicClient } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { attachEvmSignature, evmCallFor } from '../encoding/evm.js';
import type { EvmAction, EvmEnvelope, Hex } from '../types.js';
import { FALLBACK_GAS, type EvmAdapter } from './adapter.js';

const CHAINS: Record<number, Chain> = { 1: mainnet, 11155111: sepolia };

export class ViemEvmAdapter implements EvmAdapter {
	readonly kind = 'evm' as const;
	private client: PublicClient;

	constructor(
		readonly id: number,
		rpcUrl?: string,
		/** Safety margins. Keep the results below the policy's gas caps. */
		private opts = { gasBufferPct: 20n, feeMultiplierPct: 120n },
	) {
		const chain = CHAINS[id];
		if (!chain) throw new Error(`unsupported EVM chain ${id}`);
		this.client = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
	}

	async balance({ address, token }: { address: string; token: string }): Promise<bigint> {
		if (!token) return this.client.getBalance({ address: address as Hex });
		return this.client.readContract({ address: token as Hex, abi: erc20Abi, functionName: 'balanceOf', args: [address as Hex] });
	}

	pendingNonce(from: Hex) {
		return this.client.getTransactionCount({ address: from, blockTag: 'pending' });
	}

	allowance(owner: Hex, token: Hex, spender: Hex) {
		return this.client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] });
	}

	async prepareEnvelope(from: Hex, action: EvmAction, nonce: number): Promise<EvmEnvelope> {
		const { to, value, data } = evmCallFor(action);
		const [gas, fees] = await Promise.all([
			this.client
				.estimateGas({ account: from, to, value, data: bytesToHex(data) })
				.then((g) => (g * (100n + this.opts.gasBufferPct)) / 100n)
				.catch(() => FALLBACK_GAS[action.type]),
			this.client.estimateFeesPerGas(),
		]);
		return {
			nonce,
			gasLimit: gas,
			maxFeePerGas: (fees.maxFeePerGas * this.opts.feeMultiplierPct) / 100n,
			maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
		};
	}

	finalize(message: Uint8Array, signature: Uint8Array, from: string): Promise<string> {
		return attachEvmSignature(message, signature, from as Hex);
	}

	broadcast(rawTx: string): Promise<string> {
		return this.client.sendRawTransaction({ serializedTransaction: rawTx as Hex });
	}

	explorerUrl(txHash: string) {
		return `${CHAINS[this.id]?.blockExplorers?.default.url ?? ''}/tx/${txHash}`;
	}
}
