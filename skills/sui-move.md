# Sui Move Smart Contract Skill

## Overview
Sui uses the Move language with an **object-centric model**.
Every piece of state is an Object with a globally unique ID.
Transactions can run in parallel when they touch different objects.

- Docs: https://docs.sui.io
- Move Best Practices: https://docs.sui.io/guides/developer/move-best-practices
- SDK: `@mysten/sui` (TypeScript), `sui-sdk` (Rust)

## Object Model

### Object Types
```move
// Owned object — belongs to an address
public struct MyNFT has key, store {
    id: UID,
    name: String,
}

// Shared object — accessible by anyone
public struct Registry has key {
    id: UID,
    entries: Table<address, String>,
}

// Immutable object — read-only for everyone
public struct Config has key {
    id: UID,
    version: u64,
}
```

### Object Ownership Patterns
```move
// Transfer to address
transfer::transfer(nft, recipient);

// Share publicly
transfer::share_object(registry);

// Freeze (make immutable)
transfer::freeze_object(config);
```

## Module Structure Best Practices

```move
module myproject::vault {
    use sui::object::{Self, UID};
    use sui::tx_context::TxContext;
    use sui::transfer;
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;

    // Capability pattern for access control
    public struct AdminCap has key, store { id: UID }
    
    public struct Vault has key {
        id: UID,
        balance: Balance<SUI>,
    }

    // Always provide separate new() and share() for shared objects
    public fun new(ctx: &mut TxContext): Vault {
        Vault {
            id: object::new(ctx),
            balance: balance::zero(),
        }
    }

    public fun share(vault: Vault) {
        transfer::share_object(vault);
    }

    // Entry functions for transactions
    entry fun deposit(vault: &mut Vault, coin: Coin<SUI>) {
        balance::join(&mut vault.balance, coin::into_balance(coin));
    }
}
```

## Programmable Transaction Blocks (PTBs)

```typescript
import { Transaction } from '@mysten/sui/transactions';

const tx = new Transaction();

// Chain up to 1024 Move calls
const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(1_000_000)]);
const result = tx.moveCall({
    target: `${PACKAGE_ID}::vault::deposit`,
    arguments: [tx.object(VAULT_ID), coin],
});

await suiClient.signAndExecuteTransaction({ transaction: tx, signer });
```

## Events

```move
public struct DepositEvent has copy, drop {
    vault_id: ID,
    amount: u64,
    sender: address,
}

// Emit in functions
event::emit(DepositEvent { vault_id, amount, sender });
```

```typescript
// Subscribe to events
const events = await suiClient.queryEvents({
    query: { MoveEventType: `${PACKAGE_ID}::vault::DepositEvent` },
});
```

## Error Handling

```move
// Define error codes as constants
const ENotOwner: u64 = 0;
const EInsufficientBalance: u64 = 1;
const EInvalidAmount: u64 = 2;

// Use abort with error codes
public fun withdraw(vault: &mut Vault, cap: &AdminCap, amount: u64) {
    assert!(balance::value(&vault.balance) >= amount, EInsufficientBalance);
    // ...
}
```

## Testing

```move
#[test_only]
module myproject::vault_tests {
    use sui::test_scenario;
    
    #[test]
    fun test_deposit() {
        let mut scenario = test_scenario::begin(@0xALICE);
        {
            let ctx = test_scenario::ctx(&mut scenario);
            // test logic
        };
        test_scenario::end(scenario);
    }
}
```

## Deployment

```bash
# Build
sui move build

# Test
sui move test

# Deploy to testnet
sui client publish --gas-budget 100000000

# Deploy to mainnet
sui client switch --env mainnet
sui client publish --gas-budget 100000000
```

## dapp-kit (React Integration)

```typescript
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';

function MyComponent() {
    const account = useCurrentAccount();
    const { mutate: signAndExecute } = useSignAndExecuteTransaction();
    
    const handleClick = () => {
        const tx = new Transaction();
        tx.moveCall({ target: `${PACKAGE}::module::function`, arguments: [] });
        
        signAndExecute(
            { transaction: tx },
            {
                onSuccess: (result) => console.log('tx:', result.digest),
                onError: (err) => console.error(err),
            }
        );
    };
}
```

## Enoki zkLogin (Google OAuth → Sui wallet)

```typescript
import { EnokiFlow } from '@mysten/enoki';

const enokiFlow = new EnokiFlow({
    apiKey: process.env.ENOKI_API_KEY!,
});

// Login with Google
await enokiFlow.login({ provider: 'google' });

// Get keypair for transactions
const keypair = await enokiFlow.getKeypair({ network: 'testnet' });
```

## Common Pitfalls
- `crypto.subtle` breaks if Sui Wallet browser extension is active → use `js-sha256` instead
- `mutateAsync` from dapp-kit may return undefined → use callback-based `mutate`
- Google OAuth requires `localhost` not IP addresses in redirect URIs
- Shared objects need explicit `&mut` in PTBs — pass with `tx.object(id)`
- Always check object ownership before calling admin functions

## Package IDs (Mainnet)
- Sui Framework: `0x2`
- Sui System: `0x3`
- DeepBook: `0x000000000000000000000000000000000000000000000000000000000000dee9`
