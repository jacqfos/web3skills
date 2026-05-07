# Ika / dWallet Skill

## What is Ika?
Ika is a Zero-Trust threshold signature network built on Sui, implementing the 2PC-MPC protocol.
It powers the **dWallet primitive** — programmable, transferable, non-collusive signing that enables
native multi-chain interoperability without bridges.

- Docs: https://docs.ika.xyz
- GitHub: https://github.com/dwallet-labs/ika

## Core Concepts

### 2PC-MPC Protocol
- "Nested MPC": user + network both ALWAYS required to sign (non-collusive by design)
- Supports ECDSA, Schnorr, EdDSA
- Presign generation is non-interactive, O(1) for the user
- Supports hundreds/thousands of validators

### dWallet Object Model
- dWallets are controlled by `DWalletCap` objects on Sui
- Creation involves DKG (Distributed Key Generation) → user share + network share
- Programmable: attach Move logic to control signing conditions
- Transferable: ownership can be passed like any Sui object

### IKA Token
- Used for gas payment and delegated stake on validators
- Native token on Sui: `0x...` (check latest from docs.ika.xyz)

## SDK Usage Patterns

```typescript
import { IkaClient } from '@ika-network/ika-sdk';

// Initialize client
const ikaClient = new IkaClient({ network: 'testnet' });

// Create dWallet (DKG)
const { dWalletId, dWalletCapId } = await ikaClient.createDWallet({
  signer: keypair,
});

// Sign a message
const signature = await ikaClient.sign({
  dWalletCapId,
  message: messageBytes,
  signer: keypair,
});
```

## Common Patterns

### Presign + Sign flow
1. Create dWallet (DKG) → store `dWalletCapId`
2. Generate presigns (batch, reusable)
3. Use presign + user sign to complete signature

### Integration with Sui Move
```move
// dWallet controlled by Move logic
public fun approve_and_sign(
    dwallet_cap: &DWalletCap,
    // your conditions here
    ctx: &mut TxContext
) {
    // only signs if Move logic allows
    ika::dwallet::approve(dwallet_cap, ...);
}
```

### Error Handling
- Always handle network timeouts (MPC protocol has multiple rounds)
- DKG can fail if network is unstable — retry logic essential
- Presigns are one-time use — track consumed presigns

## Security Best Practices
- NEVER expose user share (stored client-side)
- dWalletCap is the "key" — protect like a private key
- Use `sign_future_transaction` for pre-authorized cross-chain ops
- Always verify dWalletId on-chain before signing

## Testnet Config
```typescript
const IKA_TESTNET = {
  rpcUrl: 'https://api.testnet.ika.xyz',
  suiRpcUrl: 'https://fullnode.testnet.sui.io',
  packageId: '0x...', // check docs.ika.xyz for latest
};
```

## Common Errors
- `DKGFailed`: Network instability, retry DKG
- `PresignConsumed`: Presign already used, generate new
- `InvalidDWalletCap`: Cap doesn't match dWallet, verify IDs
- `SignatureVerificationFailed`: Message mismatch, check encoding
