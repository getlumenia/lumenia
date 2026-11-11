#!/usr/bin/env bash
# The funder escrows USDC for SEVERAL links in one transaction.
# Usage: create-batch.sh <total-amount-raw-6dp> '<msg json>'
# where msg = {"drops":[{"public_key":"ed25519:...","amount":"100000","memo":"optional"},...],"expires_in_s":604800}
# The amounts must sum exactly to the total; at most 30 drops; attach 300 Tgas.
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
TOTAL="$1"; MSG="$2"
ARGS=$(printf '{"receiver_id":"%s","amount":"%s","msg":%s}' "$CONTRACT_ID" "$TOTAL" "$(printf '%s' "$MSG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")
"$NEAR_BIN" contract call-function as-transaction "$USDC_ID" ft_transfer_call \
  json-args "$ARGS" \
  prepaid-gas '300 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as "$FUNDER_ID" \
  network-config "$NETWORK" sign-with-legacy-keychain send
