#!/usr/bin/env bash
# Owner only: change the live config of lumenia-drop. Every field is optional,
# pass only the ones to change (amounts are decimal strings in yocto or 6-dp
# USDC units). Signs as $OWNER_ID with the legacy keychain; no key in here.
#
# Usage: set-config.sh '<json>'
#   set-config.sh '{"starter_yocto":"50000000000000000000000"}'      # 0.05 NEAR starter (testnet choice, wallets attach 30 Tgas)
#   set-config.sh '{"min_amount":"100000"}'                          # 0.10 USDC
#   set-config.sh '{"key_allowance":"1000000000000000000000000","registration_deposit":"1250000000000000000000","max_expiry_s":604800}'
# Read the result with scripts/views.sh (get_config).
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
ARGS="${1:?pass the set_config json, e.g. '{\"starter_yocto\":\"50000000000000000000000\"}'}"
"$NEAR_BIN" contract call-function as-transaction "$CONTRACT_ID" set_config \
  json-args "$ARGS" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as "$OWNER_ID" \
  network-config "$NETWORK" sign-with-legacy-keychain send
