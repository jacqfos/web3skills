# Walrus Decentralized Storage Skill

## What is Walrus?
Walrus is a decentralized blob storage protocol built on Sui by Mysten Labs.
It uses RedStuff (2D erasure coding) for ~4.5x replication with Byzantine fault tolerance.
Mainnet live since March 2025.

- Docs: https://docs.wal.app
- SDK: https://sdk.mystenlabs.com/walrus
- Publishers/Aggregators list: https://docs.wal.app/usage/web-api.html

## Core Concepts

### Blob Storage Model
- Data is split into **slivers** across storage nodes
- Content-addressed: blob ID is deterministic from content
- Reads work with up to 2/3 nodes offline
- Writes tolerate up to 1/3 unavailable nodes
- Storage paid in WAL tokens, tracked on Sui as objects

### Epochs
- Each epoch has a fixed storage committee
- Blobs must be renewed before epoch expiry (specify `epochs` on upload)
- Storage resources are Sui objects: ownable, transferable, splittable

### Blob ID
- Deterministic SHA-256-based identifier
- Any change to content = new blob ID
- Use blob ID for retrieval, Sui object ID for ownership management

## TypeScript SDK Usage

```typescript
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { walrus } from '@mysten/walrus';

// Setup client
const client = new SuiGrpcClient({
  network: 'mainnet', // or 'testnet'
  baseUrl: 'https://fullnode.mainnet.sui.io:443',
}).$extend(walrus());

// Upload a blob
const blobId = await client.walrus.writeBlob({
  blob: uint8ArrayData,
  epochs: 3,          // storage duration in epochs
  deletable: true,    // allow deletion later
  signer: keypair,
});

// Upload multiple files (quilt)
const results = await client.walrus.writeFiles({
  files: [file1, file2],
  epochs: 3,
  signer: keypair,
});

// Read a blob
const data = await client.walrus.readBlob({ blobId });

// Read files
const files = await client.walrus.getFiles({ ids: [blobId] });
```

## HTTP API (Publisher/Aggregator) — Simpler for most apps

```typescript
const PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';
const AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';

// Upload via HTTP (publisher handles signing)
async function uploadToWalrus(data: Uint8Array, epochs = 3): Promise<string> {
  const response = await fetch(
    `${PUBLISHER}/v1/blobs?epochs=${epochs}`,
    { method: 'PUT', body: data }
  );
  const result = await response.json();
  return result.newlyCreated?.blobObject?.blobId 
      ?? result.alreadyCertified?.blobId;
}

// Download via HTTP aggregator
async function downloadFromWalrus(blobId: string): Promise<Uint8Array> {
  const response = await fetch(`${AGGREGATOR}/v1/blobs/${blobId}`);
  return new Uint8Array(await response.arrayBuffer());
}
```

## JSON Storage Pattern (for dApps)

```typescript
// Store JSON data
async function storeJSON(data: object): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return uploadToWalrus(bytes, 5); // 5 epochs
}

// Retrieve JSON data
async function loadJSON<T>(blobId: string): Promise<T> {
  const bytes = await downloadFromWalrus(blobId);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
```

## Walrus Sites (Frontend Hosting)
```bash
# Install Walrus Sites CLI
cargo install --git https://github.com/MystenLabs/walrus-sites walrus-sites-publisher

# Deploy a site
walrus-sites publish ./dist --epochs 10
```

## Common Patterns

### Encrypted Storage (with Seal)
```typescript
// Encrypt before upload, decrypt after download
// Seal handles encryption, Walrus handles storage
import { SealClient } from '@mysten/seal';
const sealClient = new SealClient({ suiClient });

const encrypted = await sealClient.encrypt({ data, allowlist });
const blobId = await uploadToWalrus(encrypted);
```

### On-chain Blob Reference
```move
// Store blob ID in a Sui object
public struct MyData has key {
    id: UID,
    walrus_blob_id: vector<u8>, // 32-byte blob ID
    created_at: u64,
}
```

## Mainnet Publishers (free tier)
- Staketab: `https://wal-publisher-mainnet.staketab.org`
- Mysten: `https://publisher.walrus.space`
- Check docs.wal.app for full list and rate limits

## Testnet Config
- Publisher: `https://publisher.walrus-testnet.walrus.space`
- Aggregator: `https://aggregator.walrus-testnet.walrus.space`

## Common Errors
- `BlobNotFound`: Blob expired or not yet certified, check epochs
- `InsufficientWAL`: Need more WAL tokens for storage fees
- `StorageNodeTimeout`: Retry, nodes may be temporarily unavailable
- `CertificationFailed`: Not enough nodes confirmed, retry upload
- HTTP 413: Blob too large for publisher free tier, use SDK directly
