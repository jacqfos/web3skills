# web3skills

Auto-install Web3 AI skills for Claude Code. MIT License.

## Quick Start

```bash
# Copy web3skills.sh to your project root, then:
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

## License
MIT — use freely, even commercially.
