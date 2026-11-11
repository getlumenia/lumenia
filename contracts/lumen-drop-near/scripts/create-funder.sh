#!/usr/bin/env bash
# Create the demo funder account with the testnet faucet and save its key to
# the legacy keychain. Then register it on USDC with register-usdc.sh.
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
"$NEAR_BIN" account create-account sponsor-by-faucet-service "$FUNDER_ID" \
  autogenerate-new-keypair save-to-legacy-keychain \
  network-config "$NETWORK" create
