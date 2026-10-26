# Architecture

## 1. Components and trust boundaries

| Layer | Runs where | Trusted? | Holds | Can |
|---|---|---|---|---|
| **AI agent** (`src/agent`) | Server / cloud | ❌ No | Anthropic key, RPC URLs, webhook URL | Chat, parse intent, watch conditions, build *proposals* |
| **Wallet** (`src/wallet`) | User's device | ✅ Yes | Encrypted vault: root seed (→ user-share keys) + owner key | Review, get user approval, build and sign the Sui PTB |
| **Policy contract** (`contracts/policy`) | Sui | ✅ Code is law | The `DWalletCap` (wrapped), rules, spend counters | Issue `MessageApproval` *only* for compliant, self-built messages |
| **Ika network** | Ika validators | ✅ Threshold | Network share (split across validators) | Sign only with approval + valid user partial signature |
| **Admin key** | Hardware wallet / multisig | ✅ Cold | — | Loosen rules (48h timelock), unpause, migrate the cap |
| **Oracle updater** | Separate process | ⚠️ Semi | `OracleCap` | Push USD prices (replace with Pyth for production) |

The agent never holds any key. A compromised agent can at worst:
- propose things, which you see and can reject;
- fire a watch early, but the policy's oracle-based slippage and value checks still apply;
- go quiet, so you miss an alert.

## 2. The signing sequence (critical path)

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant A as AI agent (untrusted)
    participant W as Wallet (user device)
    participant P as Policy (Sui Move)
    participant C as Ika coordinator (Sui)
    participant N as Ika network
    participant X as Ethereum / Solana

    U->>A: "Send 50 USDC to alice if my balance is above 200"
    A->>A: Claude → Intent (structured output) → grounding checks
    A->>A: watch armed … balance 250 → condition met
    A->>A: build typed payload + expected bytes; pre-check vs live policy
    A-->>U: push: "transaction ready for approval" (id only)
    U->>W: open wallet
    W->>A: GET /proposals/:id
    W->>W: re-derive bytes from payload, compare, render own summary
    W->>U: show review
    U->>W: APPROVE + passphrase
    W->>W: vault → root seed → UserShareEncryptionKeys
    Note over W: ONE Sui PTB signed by the owner key
    W->>P: authorize_evm_transfer(params…)
    P->>P: owner? paused? chain/token/dest/caps/USD/day/slippage/gas/nonce
    P->>P: build EIP-1559 bytes itself
    P->>C: approve_message(cap, ECDSA, KECCAK256, bytes)
    C-->>P: MessageApproval
    W->>C: request_sign(approval, presign, USER PARTIAL SIGNATURE)
    Note over W,C: partial sig computed locally from the decrypted user share
    C->>N: sign session
    N->>N: verify approval == message, verify user partial, add network share
    N-->>C: signature (Sign object → Completed)
    W->>C: poll signature
    W->>X: attach signature, broadcast
    W->>A: POST /proposals/:id/status {broadcast, txHash}
```

If step 13 aborts, nothing reaches step 16. That's how the Sui PTB works: all commands succeed or none do.

## 3. DKG (zero-trust dWallet creation)

```mermaid
sequenceDiagram
    participant W as Wallet (device)
    participant S as Sui / Ika coordinator
    participant N as Ika network
    W->>W: root seed → UserShareEncryptionKeys (class-groups key + ed25519)
    W->>S: register_encryption_key (once per curve)
    W->>W: prepareDKGAsync → user public share + ZK proof,<br/>user secret share ENCRYPTED to own key, plaintext share (kept local)
    W->>S: PTB: request_dwallet_dkg → DWalletCap ⟶ policy::create ⟶ add_dwallet(cap) ⟶ share
    S->>N: DKG session
    N-->>S: network share generated; dWallet = AwaitingKeyHolderSignature
    W->>S: accept_encrypted_user_share (signs public output)
    S-->>W: dWallet Active → public key → EVM address / Solana pubkey
    W->>S: policy::set_chain_address
    W->>W: zero the plaintext share
```

After DKG:
- **Network share:** with Ika validators, itself threshold-shared.
- **User share:** on-chain, encrypted to a key only the user's root seed can derive.
- **Full key:** never existed anywhere.
- **Signing needs:** a policy approval, plus the user's device decrypting its share to produce a partial signature, plus the network.

## 4. Why the policy builds the bytes

If the policy accepted `message: vector<u8>` from the caller, it would have to parse RLP/ABI to know what it's approving, and a parsing bug would let anything through. Instead, each `authorize_*` takes **typed fields** (chain id, token, recipient, amount, gas, nonce …) and builds the message itself with `evm.move` / `solana.move`. The same builders exist in TypeScript (`src/core/encoding`) and are tested byte-for-byte against viem and `@solana/web3.js`. So:

- the agent's expected bytes,
- the wallet's re-derived bytes,
- the policy's on-chain bytes

are three independent computations that must agree. The Ika network additionally checks that the user's partial signature and the approval are for the same message.

## 5. Recommended tech stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (Node ≥ 20) everywhere off-chain | One language for agent, wallet and encoders; the Ika SDK is TS |
| MPC | `@ika.xyz/sdk` 0.5 (zero-trust dWallets, 2PC-MPC) | User share + network share, programmable via Move |
| Policy chain | **Sui Move** | Ika's coordinator lives on Sui, so the policy and `approve_message` share one atomic PTB. A Solana policy would need a bridge hop, which breaks atomicity |
| Sui client | `@mysten/sui` v2 (`SuiGrpcClient`) | Required by the current Ika SDK |
| EVM | `viem` | Encoding, gas/fees, broadcast, signature recovery |
| Solana | Plain JSON-RPC + own encoder (`@solana/web3.js` only in tests) | Tiny surface, no heavy deps |
| LLM | Claude (`claude-opus-5-5`) via `@anthropic-ai/sdk`, structured outputs (`betaZodOutputFormat`) with server-side refusal fallback | Schema-constrained JSON, no tools, low effort |
| Validation | `zod` | Shared schema for the LLM output and runtime validation |
| Prices | CoinGecko (agent), on-chain `PriceBook` (policy), **Pyth** recommended for production | Agent prices are advisory; the policy uses its own |
| Notifications | Webhook (ntfy / Slack relay), console; mobile push next | Carry only a proposal id, never approval capability |
| Frontend (next) | React Native or a web PWA with WebAuthn-gated vault; Sui dApp Kit for the owner key | The CLI is the v1 approval UI |
| Tests | `vitest`; `sui move test` | |

## 6. Folder structure

```
ai-wallet-agent/
├── contracts/policy/            Sui Move package `wallet_policy`
│   ├── sources/policy.move      rules, authorize_*, timelock, cap custody
│   ├── sources/evm.move         EIP-1559 + ERC-20 + Uniswap calldata builders
│   ├── sources/rlp.move         minimal RLP
│   ├── sources/solana.move      legacy-message SOL transfer builder
│   ├── sources/oracle.move      PriceBook + staleness
│   └── tests/policy_tests.move  vectors from viem + limit tests
├── src/
│   ├── core/                    shared, side-effect-free
│   │   ├── types.ts             Payload / Proposal
│   │   ├── encoding/            TS mirror of the Move builders
│   │   ├── policy/engine.ts     TS mirror of the policy checks (pre-check only)
│   │   ├── policy/onchain.ts    read the live Policy object (BCS)
│   │   ├── policy/rulesFile.ts  human-friendly rules → Rules
│   │   ├── chains/              adapters (EVM via viem, Solana via RPC)
│   │   └── errors.ts            Move abort codes ⇄ messages
│   ├── agent/                   UNTRUSTED
│   │   ├── intent/              schema, Claude parser, grounding, offline parser
│   │   ├── conditions/monitor.ts
│   │   ├── proposals/builder.ts
│   │   ├── agent.ts, server.ts, main.ts, notify.ts, prices.ts, assets.ts, store.ts
│   ├── wallet/                  TRUSTED (user device)
│   │   ├── vault.ts             scrypt + AES-GCM vault for the root seed
│   │   ├── ika.ts               clients, execute(), fee coins
│   │   ├── dkg.ts               zero-trust DKG + cap → policy
│   │   ├── presign.ts
│   │   ├── policyTx.ts          PTB builders for the Move package
│   │   ├── review.ts            independent verification
│   │   ├── sign.ts              the signing flow
│   │   └── cli.ts               v1 approval UI
│   └── sim/                     offline mocks of chain + Ika (demo/tests only)
├── examples/critical-path.ts
├── config/*.example.json
└── test/
```

## 7. Adding a chain

1. **Move:** add a builder module (e.g. `bitcoin.move` producing a BIP-143/341 sighash from typed inputs), plus an `authorize_<chain>_*` that calls `approve(…)` with the right curve/algorithm/hash ids (Ika: secp256k1 + Taproot/SHA256 or ECDSA/DoubleSHA256 for Bitcoin).
2. **TS:** mirror the builder in `src/core/encoding`, add a variant to `Payload`, add an adapter in `src/core/chains`, and add a `case` in `policyTx.authorize`, `engine.evaluate` and `review.ts`.
3. **Tests:** byte vectors from the chain's reference library in both TS and Move tests.
