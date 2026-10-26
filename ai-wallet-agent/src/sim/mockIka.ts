/**
 * OFFLINE FLOW SIMULATOR — NOT CRYPTOGRAPHICALLY EQUIVALENT TO IKA. NEVER USE WITH REAL FUNDS.
 *
 * Models the *authorization rules* of the real system so the critical path can
 * be run and tested without Sui/Ika:
 *   - MockPolicyContract  ≙ wallet_policy::policy (same checks via the TS engine,
 *     same message construction via the encoders). It is the only issuer of
 *     MessageApproval objects, which are unforgeable (WeakSet membership,
 *     like a Move resource) and single-use.
 *   - MockIkaNetwork      ≙ the Ika network: holds the network share and only
 *     signs when given (a) a genuine approval for exactly this message and
 *     (b) a valid contribution from the user's share.
 *
 * Simplification: real 2PC-MPC never combines shares. Here the user's
 * contribution carries their share scalar and the mock adds it to the network
 * share to produce a real secp256k1 signature that viem can verify. In real
 * Ika the user sends a zero-knowledge-backed partial signature from which the
 * share cannot be recovered, and the network side is itself threshold-split.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, keccak256 } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import { messageFor } from '../core/encoding/index.js';
import { PolicyViolationError } from '../core/errors.js';
import { evaluate, type PolicyState, type Prices, type Rules } from '../core/policy/engine.js';
import type { Hex, Payload } from '../core/types.js';

const Fn = secp256k1.Point.Fn;
const G = secp256k1.Point.BASE;

/** Opaque, unforgeable approval (≙ Ika `MessageApproval`). */
export interface MessageApproval {
	readonly dwalletId: string;
	readonly digest: Hex;
}

/** What the user's device contributes to a signature (≙ the user's partial signature). */
export interface UserContribution {
	dwalletId: string;
	digest: Hex;
	/** SIMULATION ONLY — see file header. */
	shareScalar: bigint;
}

interface NetworkDWallet {
	networkShare: bigint;
	publicKey: InstanceType<typeof secp256k1.Point>;
}

const issued = new WeakSet<MessageApproval>();
const consumed = new WeakSet<MessageApproval>();

export class MockIkaNetwork {
	private dwallets = new Map<string, NetworkDWallet>();
	private counter = 0;

	/**
	 * DKG. Each side samples its own share; only public points are exchanged.
	 * Returns the user's share to the user's device and keeps the network share.
	 */
	dkg(): { dwalletId: string; userShare: bigint; address: Hex } {
		const userShare = Fn.fromBytes(secp256k1.utils.randomSecretKey());
		const networkShare = Fn.fromBytes(secp256k1.utils.randomSecretKey());
		const publicKey = G.multiply(userShare).add(G.multiply(networkShare)); // X = X_user + X_network
		const dwalletId = `0xdwallet${++this.counter}`;
		this.dwallets.set(dwalletId, { networkShare, publicKey });
		return { dwalletId, userShare, address: publicKeyToAddress(bytesToHex(publicKey.toBytes(false))) };
	}

	/** ≙ coordinator::request_sign. Returns a 64-byte r||s signature over keccak256(message). */
	requestSign(args: { approval: MessageApproval | undefined; message: Uint8Array; user: UserContribution | undefined }): Uint8Array {
		const { approval, message, user } = args;
		if (!approval || !issued.has(approval)) throw new Error('Ika: no valid MessageApproval — refusing to sign');
		if (consumed.has(approval)) throw new Error('Ika: MessageApproval already used');
		const digest = keccak256(message);
		if (approval.digest !== digest) throw new Error('Ika: message does not match the approval');
		const dw = this.dwallets.get(approval.dwalletId);
		if (!dw) throw new Error('Ika: unknown dWallet');
		if (!user || user.dwalletId !== approval.dwalletId || user.digest !== digest) {
			throw new Error("Ika: missing or mismatched user contribution — the user's share is required");
		}
		// "Verify the user's partial": its share must complement ours to the dWallet key.
		if (!G.multiply(user.shareScalar).add(G.multiply(dw.networkShare)).equals(dw.publicKey)) {
			throw new Error('Ika: user contribution does not verify');
		}
		consumed.add(approval);
		const x = Fn.add(user.shareScalar, dw.networkShare);
		return secp256k1.sign(Buffer.from(digest.slice(2), 'hex'), Fn.toBytes(x), { prehash: false });
	}
}

/** ≙ wallet_policy::policy, holding the dWallet cap. */
export class MockPolicyContract {
	constructor(
		public rules: Rules,
		public state: PolicyState,
		private dwalletId: string,
		public prices: Prices,
	) {}

	/** ≙ authorize_*: check every rule, build the message itself, emit an approval. */
	authorize(sender: string, payload: Payload, now: number): { approval: MessageApproval; message: Uint8Array } {
		const ev = evaluate(this.rules, this.state, payload, this.prices, now, sender);
		if (!ev.ok) throw new PolicyViolationError(ev.violations);
		this.state = ev.next;
		const message = messageFor(payload);
		const approval: MessageApproval = Object.freeze({ dwalletId: this.dwalletId, digest: keccak256(message) });
		issued.add(approval);
		return { approval, message };
	}
}

/** The user's device side: holds the share, produces a contribution only after approval. */
export class MockUserDevice {
	constructor(
		private dwalletId: string,
		private share: bigint,
	) {}

	contribute(message: Uint8Array): UserContribution {
		return { dwalletId: this.dwalletId, digest: keccak256(message), shareScalar: this.share };
	}
}
