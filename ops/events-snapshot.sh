#!/bin/sh
# Snapshot both sponsors' /events/summary into docs/ (local, gitignored) with a UTC timestamp.
# Run it right before the first tester on Day 1 and again at submission; the event's numbers are
# the difference between the two files. Read-only: two GETs, no keys.
#   sh ops/events-snapshot.sh [label]
set -eu
cd "$(dirname "$0")/.."
label="${1:-snapshot}"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="docs/events-snapshot-${ts}-${label}.json"
{
  printf '{"taken_at_utc":"%s","label":"%s",\n' "$ts" "$label"
  printf '"testnet":'
  curl -sS -m 20 https://lumenia-sponsor.avakit.workers.dev/events/summary || printf 'null'
  printf ',\n"mainnet":'
  curl -sS -m 20 https://lumenia-sponsor-mainnet.avakit.workers.dev/events/summary || printf 'null'
  printf '}\n'
} > "$out"
python3 -c "import json,sys; d=json.load(open('$out')); print('wrote $out'); [print(' ', n, 'claimed', (d[n] or {}).get('funnel',{}).get('claimed'), 'referral', (d[n] or {}).get('funnel',{}).get('referral'), 'seeded claimed', ((d[n] or {}).get('seeded') or {}).get('claimed')) for n in ('testnet','mainnet')]"
