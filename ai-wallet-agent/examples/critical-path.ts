/**
 * Minimal working example of the critical path, fully offline:
 *
 *   chat -> AI intent -> watch -> condition met -> proposal
 *        -> wallet review -> user approval -> policy check -> user share + network share -> signature
 *
 * plus the attacks the design has to stop.  Run:  npm run demo
 *
 * Uses the real agent / builder / encoders / review / policy logic, with the
 * chain and Ika network replaced by src/sim mocks (see src/sim/mockIka.ts for
 * what the mock does and does not model). For the live testnet path see
 * src/wallet/sign.ts and docs/IMPLEMENTATION_PLAN.md.
 */
import { parseUnits } from 'viem';
import { stringify, parse } from '../src/core/json.js';
import type { Proposal } from '../src/core/types.js';
import { ALICE, ATTACKER, createSimulation } from '../src/sim/scenario.js';

const log = (s = '') => console.log(s);
const step = (s: string) => log(`\n━━ ${s} ${'━'.repeat(Math.max(0, 70 - s.length))}`);
const expectFail = async (what: string, fn: () => unknown) => {
	try {
		await fn();
		log(`   ✖ UNEXPECTED: ${what} succeeded`);
		process.exitCode = 1;
	} catch (e) {
		log(`   ✔ blocked: ${(e as Error).message}`);
	}
};

const sim = createSimulation((s) => log(`   ${s}`));
log(`dWallet (zero-trust, from DKG): ${sim.dw.address}`);
log('User share: on the user device.  Network share: inside MockIkaNetwork.  Full key: nowhere.');

// ─────────────────────────────────────────────────────────────
step('1. User: "Send 50 USDC to alice if my balance is above 200"');
let r = await sim.agent.handle(`Send 50 USDC to alice if my balance is above 200`);
log(`   agent: ${r.text}`);

await sim.monitor.tick();
log('   (balance is 150 USDC — nothing happens)');
sim.sepolia.setBalance(sim.dw.address, sim.usdc.address, parseUnits('250', 6));
await sim.monitor.tick();

let pending = sim.store.pending();
const transfer = pending[0]!;

step('2. Wallet: independent review + explicit approval');
const signed = await sim.walletApprove(transfer);
log(`   ✔ policy approved, user share + network share signed`);
log(`   ✔ signature recovers to ${signed.signer}  (dWallet: ${sim.dw.address})`);
log(`   raw tx: ${signed.raw.slice(0, 66)}…`);

// ─────────────────────────────────────────────────────────────
step('3. User: "Buy 0.1 ETH if it drops below $3200, max 1% slippage, only to my address"');
r = await sim.agent.handle('Buy 0.1 ETH if it drops below $3200, max 1% slippage, only to my address');
log(`   agent: ${r.text}`);
await sim.monitor.tick();
log('   (ETH is $3300 — nothing happens)');
sim.feed.prices.ETH = 3150;
await sim.monitor.tick();
pending = sim.store.pending();
log(`   ${pending.length} proposals (ERC-20 approve + swap, consecutive nonces)`);
for (const p of pending) await sim.walletApprove(p);
log(`   ✔ both signed; policy spend today: $${Number(sim.policy.state.spentUsdE8) / 1e8}`);

// ─────────────────────────────────────────────────────────────
step('4. User: "Alert me when SOL is under $140"');
r = await sim.agent.handle('Alert me when SOL is under $140');
log(`   agent: ${r.text}`);
sim.feed.prices.SOL = 139;
await sim.monitor.tick();

// ─────────────────────────────────────────────────────────────
step('ATTACK A: hallucinated / injected recipient');
r = await sim.agent.handle(`Send 50 USDC to ${ATTACKER}`);
log(`   agent: ${r.text}`);
log('   → the agent pre-check already says no. Suppose a compromised agent sends it anyway:');
const bad = r.proposals[0]!;
bad.status = 'pending_approval';
await expectFail('signing to non-allow-listed address', () => sim.walletApprove(bad));

step('ATTACK B: compromised agent swaps the bytes but keeps a benign description');
const [benign] = (await sim.agent.handle(`Send 10 USDC to ${ALICE}`)).proposals;
const tampered = parse<Proposal>(stringify(benign));
tampered.messageHex = bad.messageHex; // bytes for the attacker transfer
await expectFail('signing tampered bytes', () => sim.walletApprove(tampered));
sim.store.updateStatus(benign!.id, 'rejected_by_user');

step('ATTACK C: agent asks the Ika network to sign directly, without the policy');
await expectFail('network signing without approval', () =>
	sim.network.requestSign({ approval: undefined, message: new Uint8Array([1, 2, 3]), user: undefined }),
);

step('ATTACK D: approval obtained, but the user share is not provided');
const [p2] = (await sim.agent.handle(`Send 5 USDC to ${ALICE}`)).proposals;
const { approval, message } = sim.policy.authorize(sim.policy.state.owner, p2!.payload, Date.now());
await expectFail('network signing without user share', () => sim.network.requestSign({ approval, message, user: undefined }));

step('ATTACK E: AI tries to exceed the daily USD limit ($500/day)');
sim.sepolia.nonce = sim.policy.state.evmNonces[11155111] ?? 0; // resync after D consumed a nonce
r = await sim.agent.handle(`Send 0.2 ETH to ${ALICE}`);
log(`   agent: ${r.text}`);
const over = r.proposals[0]!;
over.status = 'pending_approval';
await expectFail('exceeding daily limit', () => sim.walletApprove(over));

step('User declines');
const [p3] = (await sim.agent.handle(`Send 1 USDC to ${ALICE}`)).proposals;
await expectFail('signing a declined proposal', () => sim.walletApprove(p3!, () => false));

step('History');
log((await sim.agent.handle('show history')).text);
