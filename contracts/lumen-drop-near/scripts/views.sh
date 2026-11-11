#!/usr/bin/env bash
# Read-only checks: config, stats, USDC registration and balances.
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
view() { "$NEAR_BIN" contract call-function as-read-only "$1" "$2" json-args "$3" network-config "$NETWORK" now; }
echo "== get_config";  view "$CONTRACT_ID" get_config '{}'
echo "== get_stats";   view "$CONTRACT_ID" get_stats '{}'
for a in "$CONTRACT_ID" "$FUNDER_ID"; do
  echo "== USDC storage_balance_of $a"; view "$USDC_ID" storage_balance_of "$(printf '{"account_id":"%s"}' "$a")"
  echo "== USDC ft_balance_of $a";      view "$USDC_ID" ft_balance_of "$(printf '{"account_id":"%s"}' "$a")"
done
if [ -n "${1:-}" ]; then
  echo "== get_drop $1"; view "$CONTRACT_ID" get_drop "$(printf '{"public_key":"%s"}' "$1")"
fi
