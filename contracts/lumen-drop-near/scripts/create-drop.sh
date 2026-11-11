#!/usr/bin/env bash
# The funder escrows USDC for a link. Usage: create-drop.sh <amount-raw-6dp> <ed25519:PUBLIC_KEY> [expires_in_s] [memo]
# Generate the key pair first (the SECRET key is the link; never store it here):
#   near account create-account fund-later use-auto-generation save-to-folder /tmp/lumenia-link
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
AMOUNT="$1"; PK="$2"; EXP="${3:-604800}"; MEMO="${4:-}"
MSG=$(printf '{"public_key":"%s","expires_in_s":%s,"memo":"%s"}' "$PK" "$EXP" "$MEMO")
ARGS=$(printf '{"receiver_id":"%s","amount":"%s","msg":%s}' "$CONTRACT_ID" "$AMOUNT" "$(printf '%s' "$MSG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")
echo "args: $ARGS"
"$NEAR_BIN" contract call-function as-transaction "$USDC_ID" ft_transfer_call \
  json-args "$ARGS" \
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as "$FUNDER_ID" \
  network-config "$NETWORK" sign-with-legacy-keychain send
