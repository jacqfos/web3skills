import { parseUnits } from 'viem';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from '../src/core/json.js';
import type { Proposal } from '../src/core/types.js';
import { ALICE, ATTACKER, createSimulation } from '../src/sim/scenario.js';

describe('critical path: proposal -> policy -> user approval -> signature', () => {
	it('conditional transfer fires, is approved and signed by the dWallet', async () => {
		const sim = createSimulation();
		await sim.agent.handle('Send 50 USDC to alice if my balance is above 200');
		await sim.monitor.tick();
		expect(sim.store.pending()).toHaveLength(0);

		sim.sepolia.setBalance(sim.dw.address, sim.usdc.address, parseUnits('250', 6));
		await sim.monitor.tick();
		const [p] = sim.store.pending();
		expect(p?.payload.action).toMatchObject({ type: 'evm_transfer', recipient: ALICE, amount: 50_000_000n });

		const { signer } = await sim.walletApprove(p!);
		expect(signer).toBe(sim.dw.address);
		expect(sim.store.proposals.get(p!.id)?.status).toBe('broadcast');
		expect(sim.policy.state.spentUsdE8).toBe(50n * 100_000_000n);
	});

	it('buy-the-dip produces approve + swap with consecutive nonces, both within slippage', async () => {
		const sim = createSimulation();
		await sim.agent.handle('Buy 0.1 ETH if it drops below $3200, max 1% slippage, only to my address');
		sim.feed.prices.ETH = 3150;
		await sim.monitor.tick();
		const ps = sim.store.pending();
		expect(ps.map((p) => p.payload.action.type)).toEqual(['evm_erc20_approve', 'evm_swap_exact_in']);
		expect(ps.map((p) => (p.payload.chain === 'evm' ? p.payload.envelope.nonce : -1))).toEqual([0, 1]);
		const swap = ps[1]!.payload.action;
		if (swap.type !== 'evm_swap_exact_in') throw new Error();
		expect(swap.minAmountOut).toBe(parseUnits('0.1', 18));
		expect(swap.recipient).toBe(sim.dw.address);
		for (const p of ps) await sim.walletApprove(p);
	});

	it('policy rejects a non-allow-listed destination even if the agent pushes it', async () => {
		const sim = createSimulation();
		const r = await sim.agent.handle(`Send 50 USDC to ${ATTACKER}`);
		const p = r.proposals[0]!;
		expect(p.precheck.violations).toContain('EDestinationNotAllowed');
		await expect(sim.walletApprove({ ...p, status: 'pending_approval' })).rejects.toThrow(/allow-list/);
	});

	it('wallet refuses bytes that do not match the described payload', async () => {
		const sim = createSimulation();
		const good = (await sim.agent.handle(`Send 10 USDC to ${ALICE}`)).proposals[0]!;
		const evil = (await sim.agent.handle(`Send 10 USDC to ${ATTACKER}`)).proposals[0]!;
		const tampered = parse<Proposal>(stringify(good));
		tampered.messageHex = evil.messageHex;
		await expect(sim.walletApprove(tampered)).rejects.toThrow(/do not match/);
	});

	it('network will not sign without a policy approval', () => {
		const sim = createSimulation();
		expect(() => sim.network.requestSign({ approval: undefined, message: new Uint8Array(1), user: undefined })).toThrow(/MessageApproval/);
		const forged = Object.freeze({ dwalletId: sim.dw.dwalletId, digest: '0x00' as const });
		expect(() => sim.network.requestSign({ approval: forged, message: new Uint8Array(1), user: undefined })).toThrow(/MessageApproval/);
	});

	it('network will not sign without the user share, and approvals are single-use and message-bound', async () => {
		const sim = createSimulation();
		const p = (await sim.agent.handle(`Send 5 USDC to ${ALICE}`)).proposals[0]!;
		const { approval, message } = sim.policy.authorize(sim.policy.state.owner, p.payload, Date.now());
		expect(() => sim.network.requestSign({ approval, message, user: undefined })).toThrow(/user's share is required/);
		expect(() => sim.network.requestSign({ approval, message: new Uint8Array([9]), user: sim.device.contribute(new Uint8Array([9])) })).toThrow(/does not match/);
		sim.network.requestSign({ approval, message, user: sim.device.contribute(message) });
		expect(() => sim.network.requestSign({ approval, message, user: sim.device.contribute(message) })).toThrow(/already used/);
	});

	it('only the owner can authorize', async () => {
		const sim = createSimulation();
		const p = (await sim.agent.handle(`Send 5 USDC to ${ALICE}`)).proposals[0]!;
		expect(() => sim.policy.authorize('0xagent', p.payload, Date.now())).toThrow(/owner/);
	});

	it('daily USD limit and per-tx caps hold', async () => {
		const sim = createSimulation();
		const r = await sim.agent.handle(`Send 0.2 ETH to ${ALICE}`); // $660 > $500/day
		expect(r.proposals[0]!.precheck.violations).toContain('EDailyUsdLimit');
		const big = await sim.agent.handle(`Send 401 USDC to ${ALICE}`); // > 400 per tx
		expect(big.proposals[0]!.precheck.violations).toContain('EAmountTooLarge');
	});

	it('user rejection stops the flow before the share is used', async () => {
		const sim = createSimulation();
		const p = (await sim.agent.handle(`Send 1 USDC to ${ALICE}`)).proposals[0]!;
		await expect(sim.walletApprove(p, () => false)).rejects.toThrow(/rejected/);
		expect(sim.policy.state.txCount).toBe(0);
	});

	it('expired proposals are refused', async () => {
		const sim = createSimulation();
		const p = (await sim.agent.handle(`Send 1 USDC to ${ALICE}`)).proposals[0]!;
		sim.advance(11 * 60_000);
		await expect(sim.walletApprove(p)).rejects.toThrow(/expired/);
	});
});
