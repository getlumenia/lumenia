#!/bin/bash
# Owner-run only: real money on NEAR mainnet. Deploys Lumenia's escrow to lumenia.near and prepares a funder.
# Prerequisite: the deployer (implicit account below, key in ~/.near-credentials/mainnet/) holds at least 4.5 NEAR.
# Every step prints what it will do and the explorer link; stop at any error and tell the agent.
#   bash ops/near-mainnet-owner.sh create     # 1. create lumenia.near with 3.2 NEAR from the deployer (keeps its new key locally)
#   bash ops/near-mainnet-owner.sh deploy     # 2. build the wasm and deploy + init the escrow on lumenia.near (mainnet USDC, root "near")
#   bash ops/near-mainnet-owner.sh register   # 3. register lumenia.near and the deployer on the USDC token (0.00125 NEAR each)
#   bash ops/near-mainnet-owner.sh status     # read-only: balances and config
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
NEAR=${NEAR_BIN:-$HOME/.cargo/bin/near}
DEPLOYER=06627280e284f7785645741ffdcc83195f4e3809423e7081391515e26e202e6c   # implicit mainnet account, key on this Mac
CONTRACT=lumenia.near
USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1       # Circle native USDC on NEAR mainnet
ROOT=near
CRATE=/Users/mericcintosun/faceid-wallet/contracts/lumen-drop-near
WASM=$CRATE/target/near/lumenia_drop/lumenia_drop.wasm
STEP=${1:-status}
case "$STEP" in
  create)
    echo "== creating $CONTRACT with 3.2 NEAR from $DEPLOYER (the new full-access key is saved under ~/.near-credentials/mainnet/)"
    "$NEAR" account create-account fund-myself "$CONTRACT" '3.2 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    ;;
  deploy)
    echo "== building the wasm"
    (cd "$CRATE/contract" && cargo near build non-reproducible-wasm >/dev/null)
    ls -la "$WASM"
    INIT=$(printf '{"owner_id":"%s","token_id":"%s","root_account_id":"%s","key_allowance":"1000000000000000000000000","registration_deposit":"1250000000000000000000","max_expiry_s":604800,"starter_yocto":"50000000000000000000000","min_amount":"100000"}' "$CONTRACT" "$USDC" "$ROOT")
    echo "== deploying to $CONTRACT with init $INIT"
    "$NEAR" contract deploy "$CONTRACT" use-file "$WASM" with-init-call new json-args "$INIT" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-legacy-keychain send
    ;;
  register)
    for A in "$CONTRACT" "$DEPLOYER"; do
      echo "== registering $A on USDC (0.00125 NEAR, paid by $A)"
      "$NEAR" contract call-function as-transaction "$USDC" storage_deposit json-args "$(printf '{"account_id":"%s","registration_only":true}' "$A")" prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$A" network-config mainnet sign-with-legacy-keychain send
    done
    ;;
  status)
    for A in "$DEPLOYER" "$CONTRACT"; do echo "-- $A"; "$NEAR" account view-account-summary "$A" network-config mainnet now 2>&1 | grep -E "Native account balance|does not exist" || true; done
    "$NEAR" contract call-function as-read-only "$CONTRACT" get_config json-args '{}' network-config mainnet now 2>&1 | grep -E "token_id|starter|min_amount|paused" || echo "(contract not deployed yet)"
    for A in "$DEPLOYER" "$CONTRACT"; do printf "USDC %s: " "$A"; "$NEAR" contract call-function as-read-only "$USDC" ft_balance_of json-args "$(printf '{"account_id":"%s"}' "$A")" network-config mainnet now 2>&1 | grep -E '^"' || echo "?"; done
    ;;
  *) echo "usage: $0 create|deploy|register|status"; exit 2;;
esac
