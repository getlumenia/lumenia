#!/usr/bin/env bash
# Re-deploy lumenia-drop over an existing state: deploy + `migrate` in one
# transaction. `migrate` is #[private] + #[init(ignore_state)]: it keeps every
# drop and counter and adds the config fields introduced after the first
# deploy (starter_yocto, min_amount). Signs with the legacy keychain key of
# $CONTRACT_ID (a transaction of the account itself, as #[private] requires).
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
MIGRATE_ARGS=$(printf '{"starter_yocto":"%s","min_amount":"%s"}' "$STARTER_YOCTO" "$MIN_AMOUNT")
echo "migrate args: $MIGRATE_ARGS"
"$NEAR_BIN" contract deploy "$CONTRACT_ID" \
  use-file "$WASM" \
  with-init-call migrate json-args "$MIGRATE_ARGS" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-legacy-keychain send
