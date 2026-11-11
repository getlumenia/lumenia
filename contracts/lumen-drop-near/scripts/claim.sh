#!/usr/bin/env bash
# Claim a drop to an account, signing AS THE CONTRACT with the link key (the
# function-call key the contract added for the drop). The secret key is the
# link; it is passed on the command line only for this manual demo.
# Usage: claim.sh <account_id> <ed25519:LINK_PUBLIC_KEY> <ed25519:LINK_SECRET_KEY>
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
TARGET="$1"; LINK_PK="$2"; LINK_SK="$3"
"$NEAR_BIN" contract call-function as-transaction "$CONTRACT_ID" claim \
  json-args "$(printf '{"account_id":"%s"}' "$TARGET")" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  sign-as "$CONTRACT_ID" \
  network-config "$NETWORK" \
  sign-with-plaintext-private-key "$LINK_SK" \
  send
