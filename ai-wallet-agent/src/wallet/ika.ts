/**
 * Ika / Sui client setup and transaction execution helpers (user device).
 */
import { getNetworkConfig, IkaClient, type Network } from '@ika.xyz/sdk';
import type { Keypair } from '@mysten/sui/cryptography';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Transaction } from '@mysten/sui/transactions';
import { explainMoveAbort } from '../core/errors.js';

export interface IkaContext {
	network: Network;
	sui: SuiGrpcClient;
	ika: IkaClient;
}

export async function createIkaContext(network: Network = 'testnet', fullnodeUrl?: string): Promise<IkaContext> {
	const sui = new SuiGrpcClient({
		baseUrl: fullnodeUrl ?? `https://fullnode.${network}.sui.io:443`,
		network,
	});
	const ika = new IkaClient({
		suiClient: sui,
		config: getNetworkConfig(network),
		cache: true,
		encryptionKeyOptions: { autoDetect: true },
	});
	await ika.initialize();
	return { network, sui, ika };
}

export interface ExecutedTx {
	digest: string;
	events: { eventType: string; bcs: Uint8Array }[];
	createdObjects: { objectId: string; type?: string }[];
}

/** Sign with the owner key, execute, and surface Move aborts as readable policy errors. */
export async function execute(sui: SuiGrpcClient, signer: Keypair, transaction: Transaction): Promise<ExecutedTx> {
	const res = await sui.core.signAndExecuteTransaction({
		transaction,
		signer,
		include: { events: true, effects: true, objectTypes: true },
	});
	const tx = res.Transaction ?? res.FailedTransaction;
	if (res.$kind === 'FailedTransaction' || !tx.status.success) {
		const raw = JSON.stringify(tx.status.success ? 'unknown failure' : tx.status.error);
		throw new Error(explainMoveAbort(raw) ?? `Sui transaction failed: ${raw}`);
	}
	await sui.core.waitForTransaction({ digest: tx.digest });
	const types = tx.objectTypes ?? {};
	return {
		digest: tx.digest,
		events: tx.events.map((e) => ({ eventType: e.eventType, bcs: e.bcs })),
		createdObjects: tx.effects.changedObjects
			.filter((o) => o.idOperation === 'Created')
			.map((o) => ({ objectId: o.objectId, type: types[o.objectId] })),
	};
}

/** Pick the owner's largest IKA coin for Ika protocol fees. */
export async function largestIkaCoin(ctx: IkaContext, owner: string): Promise<string> {
	const coinType = `${ctx.ika.ikaConfig.packages.ikaPackage}::ika::IKA`;
	const { objects } = await ctx.sui.core.listCoins({ owner, coinType });
	const best = [...objects].sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1))[0];
	if (!best) throw new Error(`No IKA coins for ${owner}. Get testnet IKA from the Ika faucet first.`);
	return best.objectId;
}
