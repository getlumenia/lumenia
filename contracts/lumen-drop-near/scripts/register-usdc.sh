#!/usr/bin/env bash
# Register an account on the USDC token (storage_deposit, 0.00125 NEAR) so it
# can hold USDC. Usage: register-usdc.sh [account-id]  (default: the contract)
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
ACCOUNT="${1:-$CONTRACT_ID}"
"$NEAR_BIN" contract call-function as-transaction "$USDC_ID" storage_deposit \
  json-args "$(printf '{"account_id":"%s","registration_only":true}' "$ACCOUNT")" \
  prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' \
  sign-as "$ACCOUNT" \
  network-config "$NETWORK" sign-with-legacy-keychain send
