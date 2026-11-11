#!/usr/bin/env bash
# Build the contract wasm with cargo-near (non-reproducible build; the
# reproducible Docker build is a stretch goal, see the README).
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$REPO_ROOT"
"$HOME/.cargo/bin/cargo" near build non-reproducible-wasm --manifest-path contract/Cargo.toml
ls -la "$WASM"
shasum -a 256 "$WASM"
