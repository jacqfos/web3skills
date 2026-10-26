# web3skills

Auto-install Web3 AI skills for Claude Code. MIT License.

## Quick Start

One-liner (run from your project root):

```bash
curl -fsSL https://raw.githubusercontent.com/jacqfos/web3skills/main/web3skills.sh | bash
```

Or download first, then run:

```bash
curl -fsSLO https://raw.githubusercontent.com/jacqfos/web3skills/main/web3skills.sh
bash web3skills.sh

# Options
bash web3skills.sh --dry-run   # preview only
bash web3skills.sh -y          # skip confirmation
```

## Supported stacks (auto-detected)
| Stack | Detection signals |
|---|---|
| Sui / Move | `Move.toml`, `@mysten/sui`, `@mysten/dapp-kit` |
| Ika / dWallet | `@ika-network/*`, `ika` in Move.toml/Cargo.toml |
| Walrus | `@mysten/walrus`, `walrus` in deps, `blobId` usage |
| Solana / Anchor | `Anchor.toml`, `@coral-xyz/anchor`, `anchor-lang` |
| SuiNS | `@mysten/suins`, `suins` in deps |

## Output
- `.claude/skills/*.md` — skill files Claude Code reads
- `.claude/skills/skills-lock.json` — installed skill hashes
- `CLAUDE.md` — updated with skill references

## Example project
[`ai-wallet-agent/`](ai-wallet-agent/): a personal AI wallet agent on Ika zero-trust dWallets. The AI proposes, a Sui Move policy enforces hard limits, the user approves with their share, and Ika signs (Ethereum + Solana).

## License
MIT — use freely, even commercially.
