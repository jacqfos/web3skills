# Solana / Anchor Skill

## Overview
Solana is a high-performance blockchain using a PoH (Proof of History) + PoS model.
**Anchor** is the leading framework for writing Solana programs (smart contracts) in Rust.

- Anchor Docs: https://www.anchor-lang.com/docs
- Solana Docs: https://docs.solanalabs.com
- Solana Dev Guides: https://solana.com/developers/guides

## Core Concepts

### Account Model
Solana stores ALL state in **accounts** (not inside programs).
Programs are stateless — they only process instructions.

```
Account types:
- Program accounts     → executable code (your deployed program)
- Data accounts        → state storage (created by your program)
- System accounts      → owned by System Program
- Token accounts       → SPL token balances
- PDA accounts         → Program Derived Addresses (no private key)
```

### PDAs (Program Derived Addresses)
PDAs are deterministic addresses derived from seeds — no private key, only the program can sign.

```rust
// Derive PDA
let (pda, bump) = Pubkey::find_program_address(
    &[b"vault", user.key().as_ref()],
    ctx.program_id
);

// In Anchor — automatic
#[account(
    init,
    payer = user,
    space = 8 + Vault::INIT_SPACE,
    seeds = [b"vault", user.key().as_ref()],
    bump,
)]
pub vault: Account<'info, Vault>,
```

## Anchor Program Structure

```rust
use anchor_lang::prelude::*;

declare_id!("YourProgramIdHere...");

#[program]
pub mod my_program {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, data: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.user.key();
        vault.data = data;
        vault.bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn update(ctx: Context<Update>, new_data: u64) -> Result<()> {
        require!(
            ctx.accounts.vault.owner == ctx.accounts.user.key(),
            MyError::Unauthorized
        );
        ctx.accounts.vault.data = new_data;
        Ok(())
    }
}

// Account validation structs
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    
    #[account(
        init,
        payer = user,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", user.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Update<'info> {
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", user.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ MyError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,
}

// State account
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,      // 32
    pub data: u64,          // 8
    pub bump: u8,           // 1
}

// Custom errors
#[error_code]
pub enum MyError {
    #[msg("Unauthorized: you are not the owner")]
    Unauthorized,
    #[msg("Insufficient balance")]
    InsufficientBalance,
}
```

## Client-Side (TypeScript)

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MyProgram } from "../target/types/my_program";

// Setup
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.MyProgram as Program<MyProgram>;

// Find PDA
const [vaultPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), provider.wallet.publicKey.toBuffer()],
    program.programId
);

// Call instruction
await program.methods
    .initialize(new anchor.BN(42))
    .accounts({
        user: provider.wallet.publicKey,
        vault: vaultPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

// Fetch account state
const vaultAccount = await program.account.vault.fetch(vaultPDA);
console.log("data:", vaultAccount.data.toNumber());
```

## Project Structure

```
my-program/
├── Anchor.toml
├── programs/
│   └── my-program/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs          # declare_id! + #[program]
│           ├── instructions/   # instruction handlers
│           │   ├── mod.rs
│           │   ├── initialize.rs
│           │   └── update.rs
│           ├── state/          # account structs
│           │   ├── mod.rs
│           │   └── vault.rs
│           └── errors.rs
├── tests/
│   └── my-program.ts
└── app/                        # optional frontend
```

## Common Anchor Constraints

```rust
#[account(
    init,                           // create account
    payer = user,                   // who pays rent
    space = 8 + MyAccount::INIT_SPACE,
    seeds = [...], bump,            // PDA
    has_one = authority,            // field must match signer
    constraint = x > 0 @ Err::Invalid,  // custom check
    close = receiver,               // close & refund lamports
)]
```

## SPL Tokens

```rust
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer};

pub fn transfer_tokens(ctx: Context<TransferCtx>, amount: u64) -> Result<()> {
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        amount,
    )
}
```

## CLI Commands

```bash
# Setup
anchor init my-project
cd my-project

# Build
anchor build

# Test (starts local validator automatically)
anchor test

# Deploy to devnet
anchor deploy --provider.cluster devnet

# Deploy to mainnet
anchor deploy --provider.cluster mainnet
```

## Compute Budget Optimization

```typescript
// Add compute budget instruction
const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
    units: 300_000,
});
const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 1_000,
});

const tx = new Transaction()
    .add(modifyComputeUnits)
    .add(addPriorityFee)
    .add(yourInstruction);
```

## Common Errors
- `AccountNotInitialized`: PDA not created yet, call init instruction first
- `ConstraintHasOne`: `has_one` field mismatch, check authority/owner
- `AccountOwnedByWrongProgram`: Wrong program owns account
- `InstructionFallbackNotFound`: Method name mismatch between client/program
- `0x1` (Insufficient lamports): Account needs more SOL for rent
- Program size exceeded: Use `solana program extend` or optimize code
