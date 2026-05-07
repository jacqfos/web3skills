# SuiNS — Sui Name Service Skill

## Overview
SuiNS is a decentralized naming service on Sui that maps human-readable `.sui` names
to wallet addresses and other on-chain data.

- Docs: https://docs.suins.io
- SDK: `@mysten/suins` (npm)
- Dashboard: https://suins.io

## Core Concepts

### Name Types
- **SLD (Second-Level Domain)**: `myname.sui` — registered, costs SUI/NS/USDC
- **Subnames (Node)**: `sub.myname.sui` — free to create, has NFT
- **Subnames (Leaf)**: lightweight, no NFT, controlled by parent
- Max nesting depth: 8 levels (10 total with SLD + TLD)

### Resolution
- **Forward**: `.sui` name → address
- **Reverse**: address → primary `.sui` name
- **Off-chain (dApps)**: via RPC calls
- **On-chain (Move)**: via smart contract integration

## SDK Setup

```typescript
import { SuinsClient } from '@mysten/suins';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';

// Create Sui client (reuse your existing one!)
const suiClient = new SuiClient({ url: getFullnodeUrl('mainnet') });

// Create SuiNS client — only ONE instance per app
const suinsClient = new SuinsClient({
    client: suiClient,
    network: 'mainnet', // or 'testnet'
});
```

## Querying (Off-chain Resolution)

```typescript
// Resolve name → address
const nameRecord = await suinsClient.getNameRecord('alice.sui');
console.log(nameRecord?.targetAddress); // '0xabc...'

// Resolve address → primary name
const name = await suinsClient.getName('0xabc...');
console.log(name); // 'alice.sui'

// Get pricing info
const price = await suinsClient.getPrice({ name: 'alice.sui', years: 1 });

// Get renewal cost
const renewalCost = await suinsClient.getRenewalPrice({ name: 'alice.sui', years: 1 });
```

## Building Transactions (SuinsTransaction)

```typescript
import { SuinsClient, SuinsTransaction } from '@mysten/suins';
import { Transaction } from '@mysten/sui/transactions';

// Register a name
const register = async (name: string, years: number) => {
    const tx = new Transaction();
    const suinsTx = new SuinsTransaction(suinsClient, tx);

    const coinConfig = suinsClient.config.coins.USDC; // SUI | NS | USDC
    const coin = tx.splitCoins(tx.gas, [tx.pure.u64(price)]);

    const nft = suinsTx.register({
        domain: name,
        years,
        coinConfig,
        coin,
    });

    tx.transferObjects([nft], tx.pure.address(myAddress));
    await signAndExecute({ transaction: tx });
};

// Create a subname
const createSubname = async (parentName: string, label: string) => {
    const tx = new Transaction();
    const suinsTx = new SuinsTransaction(suinsClient, tx);

    suinsTx.createSubname({
        parentName,
        name: `${label}.${parentName}`,
        // optional: expirationMs, targetAddress
    });

    await signAndExecute({ transaction: tx });
};

// Set target address for a name
const setTargetAddress = async (name: string, targetAddress: string) => {
    const tx = new Transaction();
    const suinsTx = new SuinsTransaction(suinsClient, tx);

    suinsTx.setTargetAddress({ name, targetAddress });
    await signAndExecute({ transaction: tx });
};
```

## React Integration

```typescript
import { SuinsClient } from '@mysten/suins';
import { createContext, useContext } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';

// Context pattern — create once, use everywhere
const SuinsContext = createContext<SuinsClient | null>(null);

export function SuinsProvider({ children }) {
    const suiClient = useSuiClient();
    const suinsClient = new SuinsClient({ client: suiClient, network: 'mainnet' });
    return <SuinsContext.Provider value={suinsClient}>{children}</SuinsContext.Provider>;
}

export const useSuins = () => useContext(SuinsContext)!;

// Usage in component
function WalletDisplay({ address }) {
    const suins = useSuins();
    const [name, setName] = useState<string | null>(null);

    useEffect(() => {
        suins.getName(address).then(setName);
    }, [address]);

    return <span>{name ?? address.slice(0, 8) + '...'}</span>;
}
```

## On-chain Resolution (Move)

```move
// Resolve a .sui name in a Move contract
use suins::suins_registration::SuinsRegistration;
use suins::registry::Registry;

public fun get_address_for_name(
    registry: &Registry,
    name: vector<u8>,
): Option<address> {
    suins::registry::lookup(registry, name)
}
```

## Move Registry (MVR)

MVR allows using `.sui` names for Move package references in PTBs:

```typescript
import { createMvrPlugin } from '@mysten/mvr';

const mvrPlugin = createMvrPlugin();
const tx = new Transaction();
tx.addPlugin(mvrPlugin);

// Use MVR name instead of package ID
tx.moveCall({ target: 'mypackage@myname.sui::module::function' });
```

## Important Notes
- Keep only **one** `SuinsClient` instance per app (use Context/singleton)
- Always keep `@mysten/suins` **up to date** — constants change and outdated versions cause failed txns
- Check `docs.suins.io/developer` for latest active package IDs before hardcoding
- Testnet and mainnet have different package IDs — always use `network` param

## Mainnet Package IDs (verify at docs.suins.io)
- Core: `0xd22b24490e0bae52676651b4f56660a5ff8022a2f280bf6cb9de7dac2d1cc2f3`
- Registry: check docs for latest

## Common Errors
- `NameExpired`: Name NFT has expired, needs renewal
- `InvalidDomain`: Name format invalid (only lowercase alphanumeric + hyphens)
- `NameUnavailable`: Already registered
- `PriceInfoExpired`: Refresh `priceInfoObjectId` (needed for SUI/NS payments)
- Stale constants: Update `@mysten/suins` package version
