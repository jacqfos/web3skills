# Example conversations

Excerpts in the shape the agent and wallet actually produce (see `npm run demo` for a live run).

## Conditional buy

> **You:** Buy 0.1 ETH if it drops below $3200, max 1% slippage, only to my address
>
> **Agent:** I'll buy 0.1 ETH once it drops below $3200 and ask you to approve. Watching now. When it happens I'll prepare the transaction and ask you to approve it.

*…later, ETH = $3,150…*

> 🔔 **Transaction ready for your approval.** ETH = $3150.00. Buy 0.1 ETH with ≤1.00% slippage (step 1/2: approve). Open your wallet to review and approve.

```
$ npm run wallet -- approve 7c1e…
──── Review (computed on this device, not by the agent) ────
ALLOW Uniswap SwapRouter02 (0x3bFA…e48E) to spend up to 318.15 USDC on EVM chain 11155111
  nonce 1, max network fee 0.0016 ETH
  expires 2026-10-26T14:40:00.000Z
Agent said: "Buy 0.1 ETH with ≤1.00% slippage (step 1/2…)"  — your words: "Buy 0.1 ETH if it drops below $3200, …"

Type APPROVE to sign with your share: APPROVE
Vault passphrase: ************
Broadcast: https://sepolia.etherscan.io/tx/0x…
```

Step 2 (the swap: at most 318.15 USDC in, at least 0.1 WETH out, proceeds to *my dWallet*) is approved the same way.

## Conditional transfer

> **You:** Send 50 USDC to alice if my balance is above 200
>
> **Agent:** Preparing to send 50 USDC to alice once your balance is above 200. Watching now.
>
> 🔔 balance 250 USDC. Send 50 USDC to alice. Open your wallet to review and approve.

## Alert only

> **You:** Alert me when SOL is under $140
>
> **Agent:** I'll alert you when SOL is under $140. Watching now. I'll notify you.
>
> 🔔 Price alert: SOL = $139.00

## The policy says no (before you're even asked)

> **You:** Send 0.2 ETH to alice
>
> **Agent:** Your policy would reject this, so I haven't asked you to sign. This would exceed your daily USD spending limit.

> **You:** Send 50 USDC to 0xBAdBAdbaDbadbaDBaDbaDBadBaDbadBadBaDBAD0
>
> **Agent:** Your policy would reject this, so I haven't asked you to sign. This destination address is not on your allow-list.

## The agent refuses to guess

> **You:** send fifty to alice
>
> **Agent:** Which token, and how much exactly? (I only prepare transactions with amounts you've written out.)

> **You:** Raise my daily limit to $10,000
>
> **Agent:** I can't change your limits. Only your admin key can do that, from the wallet, with a 48-hour timelock.

## Portfolio and history

> **You:** what's my balance?
>
> **Agent:**
> • 0.1 WETH (evm:11155111) ≈ $315.00
> • 131.85 USDC (evm:11155111) ≈ $131.85

> **You:** show history
>
> **Agent:**
> • 14:02 Send 50 USDC to alice — broadcast (0x9f…)
> • 14:30 Buy 0.1 ETH (step 1/2: approve) — broadcast (0x1a…)
> • 14:30 Buy 0.1 ETH (step 2/2: swap) — broadcast (0x77…)
