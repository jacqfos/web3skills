#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════╗
# ║           web3skills — by IPO / IkaVault             ║
# ║   Auto-install Web3 AI skills for Claude Code        ║
# ║   MIT License — freely usable, even commercially     ║
# ╚═══════════════════════════════════════════════════════╝

set -euo pipefail

SKILLS_VERSION="0.1.0"
SKILLS_DIR=".claude/skills"
CLAUDE_MD="CLAUDE.md"
REGISTRY_BASE="https://raw.githubusercontent.com/jacqfos/web3skills/main/skills"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# Parse flags
DRY_RUN=false
YES=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        -y|--yes) YES=true ;;
        -h|--help)
            echo "Usage: web3skills [options]"
            echo ""
            echo "Options:"
            echo "  -y, --yes     Skip confirmation prompt"
            echo "  --dry-run     Show what would be installed without installing"
            echo "  -h, --help    Show this help message"
            exit 0
            ;;
    esac
done

# ── Banner ──────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}"
echo "  ╦ ╦╔═╗╔╗ ╔═╗ ╔═╗╦╔═╦╦  ╦  ╔═╗"
echo "  ║║║║╣ ╠╩╗╔═╝ ╚═╗╠╩╗║║  ║  ╚═╗"
echo "  ╚╩╝╚═╝╚═╝╚═╝ ╚═╝╩ ╩╩╩═╝╩═╝╚═╝"
echo -e "${RESET}${DIM}  Web3 AI skills for Claude Code — v${SKILLS_VERSION}${RESET}"
echo ""

# ── Detection ───────────────────────────────────────────
declare -A DETECTED=()

detect_stack() {
    # Sui / Move
    if [[ -f "Move.toml" ]]; then
        DETECTED["sui-move"]="Move.toml found"
    fi
    if grep -q '"@mysten/sui"' package.json 2>/dev/null || \
       grep -q "'@mysten/sui'" package.json 2>/dev/null || \
       grep -q "@mysten/dapp-kit" package.json 2>/dev/null; then
        DETECTED["sui-move"]="@mysten/sui in package.json"
    fi

    # Ika / dWallet
    if grep -q "ika\|dwallet\|dWallet\|2pc-mpc" Move.toml 2>/dev/null || \
       grep -q "@ika-network\|ika-sdk\|dwallet" package.json 2>/dev/null || \
       grep -q "ika\|dwallet" Cargo.toml 2>/dev/null; then
        DETECTED["ika"]="Ika/dWallet dependency found"
    fi

    # Walrus
    if grep -q "@mysten/walrus\|walrus-sdk" package.json 2>/dev/null || \
       grep -q "walrus\b" Move.toml 2>/dev/null || \
       grep -q "walrus" Cargo.toml 2>/dev/null || \
       grep -q "walrus\|PUBLISHER\|AGGREGATOR" src/**/*.ts 2>/dev/null || \
       grep -rq "walrus\|blobId\|blob_id" src/ 2>/dev/null; then
        DETECTED["walrus"]="Walrus dependency/usage found"
    fi

    # Solana / Anchor
    if [[ -f "Anchor.toml" ]]; then
        DETECTED["solana-anchor"]="Anchor.toml found"
    fi
    if grep -q "@coral-xyz/anchor\|@solana/web3.js" package.json 2>/dev/null; then
        DETECTED["solana-anchor"]="Anchor/Solana in package.json"
    fi
    if grep -q '\[dependencies\]' Cargo.toml 2>/dev/null && \
       grep -q 'anchor-lang\|solana-program' Cargo.toml 2>/dev/null; then
        DETECTED["solana-anchor"]="anchor-lang in Cargo.toml"
    fi

    # SuiNS
    if grep -q "@mysten/suins\|suins" package.json 2>/dev/null || \
       grep -q "suins" Move.toml 2>/dev/null; then
        DETECTED["suins"]="SuiNS dependency found"
    fi

    # Additional heuristics
    if [[ -d "programs" ]] && [[ -f "Anchor.toml" ]]; then
        DETECTED["solana-anchor"]="Anchor workspace structure"
    fi
    if [[ -d "sources" ]] && [[ -f "Move.toml" ]]; then
        DETECTED["sui-move"]="Sui Move package structure"
    fi
}

# ── Skill metadata ───────────────────────────────────────
declare -A SKILL_NAMES=(
    ["sui-move"]="Sui / Move Smart Contracts"
    ["ika"]="Ika / dWallet 2PC-MPC"
    ["walrus"]="Walrus Decentralized Storage"
    ["solana-anchor"]="Solana / Anchor Framework"
    ["suins"]="SuiNS — Sui Name Service"
)

declare -A SKILL_FILES=(
    ["sui-move"]="sui-move.md"
    ["ika"]="ika.md"
    ["walrus"]="walrus.md"
    ["solana-anchor"]="solana-anchor.md"
    ["suins"]="suins.md"
)

# ── Run detection ────────────────────────────────────────
echo -e "${BOLD}◆ Scanning project...${RESET}"
detect_stack

if [[ ${#DETECTED[@]} -eq 0 ]]; then
    echo -e "${YELLOW}  No Web3 stack detected automatically.${RESET}"
    echo -e "${DIM}  Showing all available skills for manual selection.${RESET}"
    echo ""
    # Add all skills as candidates
    for key in "${!SKILL_NAMES[@]}"; do
        DETECTED["$key"]="Manual selection"
    done
fi

echo ""
echo -e "${BOLD}◆ Detected technologies:${RESET}"
for key in "${!DETECTED[@]}"; do
    echo -e "  ${GREEN}✔${RESET} ${SKILL_NAMES[$key]} ${DIM}(${DETECTED[$key]})${RESET}"
done

echo ""
echo -e "${BOLD}◆ Skills to install (${#DETECTED[@]} found):${RESET}"
for key in "${!DETECTED[@]}"; do
    echo -e "  ${CYAN}→${RESET} ${SKILL_FILES[$key]}"
done

if $DRY_RUN; then
    echo ""
    echo -e "${YELLOW}  Dry run — no files written.${RESET}"
    exit 0
fi

echo ""
if ! $YES; then
    read -r -p "$(echo -e "${BOLD}Install these skills? [Y/n]${RESET} ")" confirm
    confirm=${confirm:-Y}
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo -e "${RED}  Cancelled.${RESET}"
        exit 0
    fi
fi

# ── Install ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}◆ Installing skills...${RESET}"

mkdir -p "$SKILLS_DIR"
INSTALLED=()

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$SCRIPT_DIR/skills" ]]; then
    LOCAL_SKILLS="$SCRIPT_DIR/skills"
else
    LOCAL_SKILLS="$SCRIPT_DIR"
fi

for key in "${!DETECTED[@]}"; do
    filename="${SKILL_FILES[$key]}"
    target="$SKILLS_DIR/$filename"

    # Try local first, then registry URL
    if [[ -f "$LOCAL_SKILLS/$filename" ]]; then
        cp "$LOCAL_SKILLS/$filename" "$target"
        echo -e "  ${GREEN}✔${RESET} Installed ${BOLD}$filename${RESET} ${DIM}(local)${RESET}"
    else
        echo -e "  ${YELLOW}↓${RESET} Downloading ${BOLD}$filename${RESET}..."
        if curl -fsSL "$REGISTRY_BASE/$filename" -o "$target" 2>/dev/null; then
            echo -e "  ${GREEN}✔${RESET} Installed ${BOLD}$filename${RESET}"
        else
            echo -e "  ${RED}✗${RESET} Failed to download $filename — skipping"
            continue
        fi
    fi

    INSTALLED+=("$filename")
done

# ── Write skills-lock.json ───────────────────────────────
LOCK_FILE="$SKILLS_DIR/skills-lock.json"
LOCK_CONTENT='{"version":"'"$SKILLS_VERSION"'","installed":['
FIRST=true
for f in "${INSTALLED[@]}"; do
    $FIRST || LOCK_CONTENT+=','
    HASH=$(md5sum "$SKILLS_DIR/$f" 2>/dev/null | cut -d' ' -f1 || echo "n/a")
    LOCK_CONTENT+='{"file":"'"$f"'","hash":"'"$HASH"'"}'
    FIRST=false
done
LOCK_CONTENT+=']}'
echo "$LOCK_CONTENT" > "$LOCK_FILE"

# ── Update CLAUDE.md ─────────────────────────────────────
SKILLS_SUMMARY=""
for f in "${INSTALLED[@]}"; do
    key=""
    for k in "${!SKILL_FILES[@]}"; do
        [[ "${SKILL_FILES[$k]}" == "$f" ]] && key="$k" && break
    done
    SKILLS_SUMMARY+="- **${SKILL_NAMES[$key]:-$f}**: \`.claude/skills/$f\`"$'\n'
done

if [[ -f "$CLAUDE_MD" ]]; then
    # Remove old web3skills block if present
    sed -i '/<!-- web3skills:start -->/,/<!-- web3skills:end -->/d' "$CLAUDE_MD"
fi

cat >> "$CLAUDE_MD" << EOF

<!-- web3skills:start -->
## Web3 AI Skills (installed by web3skills v${SKILLS_VERSION})

The following skill files provide Claude Code with deep context for this project's Web3 stack:

${SKILLS_SUMMARY}
Read these files for API patterns, best practices, common errors, and code examples.
<!-- web3skills:end -->
EOF

# ── Done ─────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}◆ Done!${RESET} ${#INSTALLED[@]} skill(s) installed to ${CYAN}$SKILLS_DIR/${RESET}"
echo -e "${DIM}  CLAUDE.md updated with skill references.${RESET}"
echo -e "${DIM}  Lock file written to $LOCK_FILE${RESET}"
echo ""
