# Implementation plan

Security-first order: build and prove the enforcement points before anything that makes it convenient.

## Phase 0: offline critical path ✅ (this repo)

- [x] Byte-exact encoders (TS) tested against viem / web3.js
- [x] Move policy with on-chain message construction + unit tests (written; **compile next**)
- [x] TS policy mirror, proposal builder, grounding, condition monitor
- [x] Wallet: vault, review, DKG/presign/sign against `@ika.xyz/sdk` 0.5 (typechecked)
- [x] Simulation + `npm run demo` + 31 tests including the attack cases

## Phase 1: Move package on Sui testnet (do first)

1. Install the Sui CLI, then `sui move build --path contracts/policy`.
   - Fix the Ika dependency `subdir`/`rev` in `Move.toml` if the path changed.
   - Confirm `DWalletCap has key, store` and the `coordinator::approve_message` signature.
2. `sui move test --path contracts/policy`. All 20 tests must pass. The encoder vectors prove Move == TS == viem.
3. `sui client publish contracts/policy`, then note the package id.
4. Create the price book: `sui client call --package <pkg> --module oracle --function create` and transfer the returned `OracleCap` to a **separate** oracle key. Note the shared `PriceBook` id.
5. Run a tiny oracle updater (cron: `oracle::set_price` for ETH, USDC, SOL every ~60 s), or go straight to Pyth.

## Phase 2: zero-trust dWallet on Ika testnet {#testnet-bring-up}

```bash
npm run wallet -- init                          # prints owner address; fund with testnet SUI + IKA
# edit wallet.json: packageId, priceBookId, admin (use a different key!)
cp config/policy.rules.example.json config/policy.rules.json   # put the dWallet address in destinations after step 2
npm run wallet -- create-dwallet secp256k1 config/policy.rules.json
npm run wallet -- create-dwallet ed25519        # adds the Solana dWallet to the same policy
npm run wallet -- presign secp256k1
```

The first dWallet address isn't known until DKG finishes. Either create the policy with only third-party destinations and add "self" through the admin timelock flow, or (simpler for testnet) use `rule_timelock_ms = 0` for bring-up and raise it before real use.

Verify on the explorer:
- `Policy` is shared and owns the `DWalletCap` as a dynamic object field.
- No address owns a `DWalletCap`.

## Phase 3: first signed transaction (Sepolia)

1. Fund the dWallet's EVM address with Sepolia ETH.
2. `AGENT_API_TOKEN=$(openssl rand -hex 24) npm run agent -- config/agent.config.json`.
3. Chat: `POST /chat {"text":"Send 0.001 ETH to alice"}`.
4. `npm run wallet -- pending` → `approve <id>` → check the tx on Etherscan.
5. Negative tests on testnet:
   - recipient not on the allow-list → `EDestinationNotAllowed` abort, no Ika sign session created;
   - over the limit → `EDailyUsdLimit`;
   - wrong passphrase → nothing submitted.

## Phase 4: conditions + swaps + Solana

- Arm "buy the dip" on Sepolia (USDC/WETH pool, fee 500) and test the approve + swap sequence.
- Solana devnet transfer via the ed25519 dWallet.
- Webhook notifications (ntfy topic or Slack relay).

## Phase 5: production hardening (before mainnet)

- **Pyth oracle** in `oracle.move` (on-chain verification), dropping `OracleCap`.
- On-chain event indexer: history from `Authorized` events and alerts on rule-change events.
- Mobile/web wallet app: hardware-backed owner key, biometric-gated vault, push notifications, QR/deeplink to a proposal.
- User-share backup via Ika re-encryption to a recovery device.
- Persistent agent store (Postgres) and multi-user isolation.
- Optional on-chain condition checks (price threshold in `authorize_*`).
- Bitcoin: `bitcoin.move` sighash builder + Taproot dWallet.
- External audit, then mainnet with conservative limits.

## Definition of done for v1

- [ ] `sui move test` green
- [ ] DKG → presign → policy-gated sign → broadcast works on Sepolia
- [ ] Every attack in `examples/critical-path.ts` reproduced and blocked on testnet
- [ ] Admin key is not the owner key; timelock ≥ 24h
