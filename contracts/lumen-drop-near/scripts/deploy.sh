#!/usr/bin/env bash
# FIRST deploy of lumenia-drop to $CONTRACT_ID: deploy + `new` in one
# transaction. For an account that already holds a lumenia-drop state use
# migrate.sh instead (`new` panics when state exists).
# Signs with the legacy keychain key of $CONTRACT_ID.
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
INIT_ARGS=$(printf '{"owner_id":"%s","token_id":"%s","root_account_id":"%s","key_allowance":"%s","registration_deposit":"%s","max_expiry_s":%s,"starter_yocto":"%s","min_amount":"%s"}' \
  "$OWNER_ID" "$USDC_ID" "$ROOT_ID" "$KEY_ALLOWANCE" "$REGISTRATION_DEPOSIT" "$MAX_EXPIRY_S" "$STARTER_YOCTO" "$MIN_AMOUNT")
echo "init args: $INIT_ARGS"
"$NEAR_BIN" contract deploy "$CONTRACT_ID" \
  use-file "$WASM" \
  with-init-call new json-args "$INIT_ARGS" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-legacy-keychain send
