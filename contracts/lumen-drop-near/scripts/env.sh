#!/usr/bin/env bash
# Shared settings for the lumenia-drop testnet scripts. No secrets here: the
# signing key lives in the near-cli-rs legacy keychain (~/.near-credentials).
set -euo pipefail

export NEAR_BIN="${NEAR_BIN:-$HOME/.cargo/bin/near}"
export NETWORK="${NETWORK:-testnet}"
export CONTRACT_ID="${CONTRACT_ID:-lumenia-near.testnet}"
export OWNER_ID="${OWNER_ID:-lumenia-near.testnet}"
export FUNDER_ID="${FUNDER_ID:-lumenia-funder.testnet}"
# Circle testnet USDC on NEAR testnet (6 decimals). Mainnet native USDC is
# 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 (not used).
export USDC_ID="${USDC_ID:-3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af}"
# The root linkdrop account that creates named accounts: `testnet` / `near`.
export ROOT_ID="${ROOT_ID:-testnet}"
# 1 NEAR gas allowance per link key, 0.00125 NEAR USDC registration, 7 days.
export KEY_ALLOWANCE="${KEY_ALLOWANCE:-1000000000000000000000000}"
export REGISTRATION_DEPOSIT="${REGISTRATION_DEPOSIT:-1250000000000000000000}"
export MAX_EXPIRY_S="${MAX_EXPIRY_S:-604800}"
# 0.01 NEAR handed to every account a claim creates; 0.10 USDC smallest drop.
export STARTER_YOCTO="${STARTER_YOCTO:-10000000000000000000000}"
export MIN_AMOUNT="${MIN_AMOUNT:-100000}"

# Paths. This crate is a Cargo workspace of its own inside the Lumenia monorepo:
#   <monorepo>/contracts/lumen-drop-near/{Cargo.toml,contract,test-usdc,test-root,scripts}
# Everything is resolved from the location of this file, so the scripts work from
# any working directory and survive a move of the crate.
CRATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONOREPO_ROOT="$(cd "$CRATE_ROOT/../.." && pwd)"
# REPO_ROOT is the name the scripts have always read: it is the crate root above (the
# workspace with the Cargo.lock and the target/ dir), not the monorepo root.
REPO_ROOT="$CRATE_ROOT"
export CRATE_ROOT MONOREPO_ROOT REPO_ROOT
# cargo-near writes the workspace's wasm here (scripts/build.sh runs it from CRATE_ROOT).
export WASM="${WASM:-$CRATE_ROOT/target/near/lumenia_drop/lumenia_drop.wasm}"
