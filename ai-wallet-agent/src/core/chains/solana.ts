import { base58Decode, base58Encode } from '../encoding/base58.js';
import { solanaSignedTx } from '../encoding/solana.js';
import { SOLANA_CLUSTER, type SolanaAction, type SolanaEnvelope } from '../types.js';
import type { SolanaAdapter } from './adapter.js';

const RPC: Record<number, string> = {
	[SOLANA_CLUSTER.mainnet]: 'https://api.mainnet-beta.solana.com',
	[SOLANA_CLUSTER.testnet]: 'https://api.testnet.solana.com',
	[SOLANA_CLUSTER.devnet]: 'https://api.devnet.solana.com',
};

/** Minimal JSON-RPC Solana adapter (native SOL only in v1). */
export class RpcSolanaAdapter implements SolanaAdapter {
	readonly kind = 'solana' as const;
	private url: string;

	constructor(
		readonly id: number,
		rpcUrl?: string,
	) {
		const url = rpcUrl ?? RPC[id];
		if (!url) throw new Error(`unknown Solana cluster ${id}`);
		this.url = url;
	}

	private async rpc<T>(method: string, params: unknown[]): Promise<T> {
		const res = await fetch(this.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		});
		const body = (await res.json()) as { result?: T; error?: { message: string } };
		if (body.error) throw new Error(`Solana RPC ${method}: ${body.error.message}`);
		return body.result as T;
	}

	async balance({ address, token }: { address: string; token: string }): Promise<bigint> {
		if (token) throw new Error('SPL tokens are not supported in v1');
		const r = await this.rpc<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
		return BigInt(r.value);
	}

	async prepareEnvelope(_from: string, _action: SolanaAction): Promise<SolanaEnvelope> {
		const r = await this.rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'finalized' }]);
		return { recentBlockhash: r.value.blockhash };
	}

	async finalize(message: Uint8Array, signature: Uint8Array): Promise<string> {
		return Buffer.from(solanaSignedTx(message, signature)).toString('base64');
	}

	async broadcast(rawTx: string): Promise<string> {
		return this.rpc<string>('sendTransaction', [rawTx, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
	}

	explorerUrl(sig: string) {
		const cluster = this.id === SOLANA_CLUSTER.mainnet ? '' : `?cluster=${this.id === SOLANA_CLUSTER.devnet ? 'devnet' : 'testnet'}`;
		return `https://explorer.solana.com/tx/${sig}${cluster}`;
	}
}

export const isSolanaAddress = (s: string) => {
	try {
		return base58Encode(base58Decode(s, 32)) === s;
	} catch {
		return false;
	}
};
