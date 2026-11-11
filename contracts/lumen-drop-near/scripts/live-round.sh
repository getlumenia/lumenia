#!/usr/bin/env bash
# One real create -> claim round on testnet: the funder escrows USDC for a
# fresh link key, then the link key claims to a fresh implicit account that
# does not exist yet. Needs USDC on $FUNDER_ID (faucet.circle.com).
# Keys are generated into scripts/.keys (gitignored) and printed ONLY as the
# account ids and public keys; the secret keys stay in that folder.
# Usage: live-round.sh [amount-raw-6dp]   (default 1000000 = 1 USDC)
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
AMOUNT="${1:-1000000}"
KEYS="$REPO_ROOT/scripts/.keys/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$KEYS"

gen() { # writes <implicit>.json into $1, prints the file path
  "$NEAR_BIN" account create-account fund-later use-auto-generation save-to-folder "$1" >/dev/null 2>&1
  ls -t "$1"/*.json | head -1
}
LINK_FILE=$(gen "$KEYS/link")
RECIPIENT_FILE=$(gen "$KEYS/recipient")
LINK_PK=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["public_key"])' "$LINK_FILE")
LINK_SK=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["private_key"])' "$LINK_FILE")
RECIPIENT=$(basename "$RECIPIENT_FILE" .json)
echo "link public key : $LINK_PK"
echo "recipient       : $RECIPIENT (implicit, must not exist yet)"
echo "funder USDC     : $("$NEAR_BIN" contract call-function as-read-only "$USDC_ID" ft_balance_of json-args "$(printf '{"account_id":"%s"}' "$FUNDER_ID")" network-config "$NETWORK" now 2>/dev/null | tail -1)"

echo "== 1. create the drop (funder -> USDC.ft_transfer_call)"
"$REPO_ROOT/scripts/create-drop.sh" "$AMOUNT" "$LINK_PK" 604800 "hackathon demo" 2>&1 | grep -E 'Transaction ID|EVENT_JSON|rror|panicked|return value' || true
echo "== 2. get_drop"
"$NEAR_BIN" contract call-function as-read-only "$CONTRACT_ID" get_drop json-args "$(printf '{"public_key":"%s"}' "$LINK_PK")" network-config "$NETWORK" now 2>&1 | grep -v '^\s*$' | tail -14
echo "== 3. claim with the link key to the fresh implicit account"
"$REPO_ROOT/scripts/claim.sh" "$RECIPIENT" "$LINK_PK" "$LINK_SK" 2>&1 | grep -E 'Transaction ID|EVENT_JSON|rror|panicked|reopened|return value|Gas burned' || true
echo "== 4. recipient after the claim"
"$NEAR_BIN" account view-account-summary "$RECIPIENT" network-config "$NETWORK" now 2>&1 | grep -E 'Native account balance|Storage used|access key|FullAccess' | head -5 || true
"$NEAR_BIN" contract call-function as-read-only "$USDC_ID" ft_balance_of json-args "$(printf '{"account_id":"%s"}' "$RECIPIENT")" network-config "$NETWORK" now 2>&1 | tail -1
"$NEAR_BIN" contract call-function as-read-only "$CONTRACT_ID" get_drop json-args "$(printf '{"public_key":"%s"}' "$LINK_PK")" network-config "$NETWORK" now 2>&1 | grep -E 'status|claimed_to'
echo "keys kept in $KEYS (gitignored)"
