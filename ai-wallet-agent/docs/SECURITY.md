# Security considerations (AI + MPC wallet)

## Invariants

1. **No full key anywhere.** The DKG produces a user share and a network share. Signing is 2PC-MPC. The code never reconstructs a key (except the clearly labeled offline mock).
2. **No signature without the policy.** The `DWalletCap` is wrapped in `Policy` in the DKG transaction itself. `MessageApproval` can only come from `authorize_*`.
3. **No signature without the user.** Zero-trust dWallet: the user's partial signature comes from a share that only the user's root seed can decrypt.
4. **The AI only proposes.** It has no keys, no tools, and no write path to the chain.
5. **Bytes are built, not accepted.** The policy builds the message from typed fields, and the wallet re-derives it independently.

## Threats and mitigations

| # | Threat | Mitigation |
|---|---|---|
| T1 | **Prompt injection or hallucination changes recipient or amount** | The LLM sees only the user's message (no web, balances or tool output → no third-party injection channel). Output is schema-constrained. `grounding.ts` requires every address/amount/threshold to appear verbatim in the user's text. The wallet labels addresses from the user's address book and warns on unknown ones. The on-chain destination allow-list is the backstop |
| T2 | **Compromised agent server** | Holds no key material. It can show a misleading `agentSummary`, but the wallet renders its own summary from the payload. Tampered `messageHex` → the wallet refuses (`ProposalVerificationError`). Even a perfect-looking malicious proposal stays inside the hard limits |
| T3 | **Approval fatigue / social engineering** ("just approve it") | Limits bound the damage per day. Proposals expire (10 min). The review shows *your words* next to the computed action. Unknown addresses produce warnings. Recommended: require WebAuthn/biometric per approval in the app |
| T4 | **Compromised user device** (malware with the vault unlocked) | This is the one place where both the owner key and the share meet, so the policy caps the damage to the daily limits. Loosening rules or withdrawing the cap needs the **admin** key plus a 48h timelock. The owner can veto (`cancel_pending_rules`), pause instantly, and watch `RulesProposed` / `CapWithdrawalRequested` events. Keep the admin key on a hardware wallet or multisig |
| T5 | **Oracle manipulation** (inflate prices to lower the USD value; skew the slippage check) | `OracleCap` lives in a separate updater process, never on the agent server. Staleness bound (`max_price_age_ms`). Oracle-independent per-transaction caps (`max_per_tx` in base units). **Production: replace `set_price` with Pyth pull-oracle verification on-chain** |
| T6 | **Gas griefing** (sign a tx with huge `maxFeePerGas × gasLimit`) | Per-chain `GasRule` caps enforced on-chain. Gas is not counted in the USD limit, so keep the caps tight |
| T7 | **Signed-but-unbroadcast txs, or stockpiled signatures** | Every signature is charged to the daily limits at signing time. The policy tracks EVM nonces (stockpiled future nonces still count against the limit). Ika signatures are public on Sui once produced, so treat "signed" as "spent". Solana blockhashes expire in about 60–90 s |
| T8 | **Slippage / sandwiching** | Exact-input swaps with an on-chain floor: `min_out ≥ oracle_expected × (1 − max_slippage)`. No `sqrtPriceLimit`. Use a private mempool / protected RPC (e.g. Flashbots Protect) to broadcast |
| T9 | **Unlimited ERC-20 approvals** | `authorize_evm_erc20_approve` only allows allow-listed routers and amounts ≤ `max_per_tx`. The builder approves the exact swap amount |
| T10 | **Lost root seed** | The user share can't be decrypted, so the dWallet can't sign. Back up the vault and passphrase. Production: Ika re-encryption (`requestReEncryptUserShareFor`) to a second device or recovery key, and a timelocked admin cap withdrawal for migration |
| T11 | **Vault theft** | scrypt (N=2¹⁷) + AES-256-GCM, file mode 0600, secrets wiped after each flow. A thief still needs the passphrase, and every signature still passes the policy |
| T12 | **Agent API abuse** | Bearer token (constant-time compare), bound to localhost by default, body size limits. The wallet can only set bookkeeping statuses. A stolen token gives no signing ability |
| T13 | **Condition spoofing** (agent fires "price below $3200" when it isn't) | Not verified on-chain in v1. Damage is bounded because the swap must still meet the on-chain oracle slippage floor. Future: optional on-chain condition check in `authorize_*` (e.g. `require oracle(ETH) < threshold`) |
| T14 | **Replay across chains** | EIP-155 chain id is part of the signed bytes, and the chain must be allow-listed. Solana: cluster tag plus blockhash |
| T15 | **Policy bugs** | Small, auditable Move with unit tests (`sui move test`) and byte vectors from reference libraries. Get an external audit before mainnet. Upgrade policy: publish immutable or under a multisig `UpgradeCap` |

## LLM-specific practices used here

- **No tools, no retrieval, no memory of untrusted data** in the parser call. It's a pure function from user text to JSON.
- **Structured outputs + zod re-validation.** Amounts are decimal *strings*, never floats.
- **Grounding check** after parsing (T1). On failure it falls back to "clarify", never a guess.
- The LLM is explicitly told that policy changes, key export and arbitrary signing are out of scope. More importantly, **no code path exists** for them on the agent side.
- Refusal handling (`stop_reason: "refusal"` → clarify) and a server-side fallback model so a classifier decline doesn't break the chat.

## Things you must do before mainnet

- Compile and test the Move package. Verify the Ika dependency path and that `DWalletCap` has `store`.
- Replace the oracle with Pyth (or similar) verified on-chain.
- External audit of `contracts/policy` and `src/wallet`.
- Move the owner key into a hardware-backed keystore (Secure Enclave / StrongBox / WebAuthn). Gate the vault with biometrics.
- Set up an event watcher that alerts on `RulesProposed`, `CapWithdrawalRequested`, `PausedChanged`, and every `Authorized`.
- Set up user-share backup/recovery via Ika re-encryption.
