#!/usr/bin/env bash
# The retirement switch's dress rehearsal on the DEPLOYED testnet Worker, evidence/SOW2_OPS_NOTE.md
# section 1.3 steps 1 to 11, in one guided run. Testnet only; mainnet is never touched.
#
#   bash ops/rehearsal/run-testnet-rehearsal.sh
#
# What it does, in order: deploys the testnet Worker with PILOT_MODE=1 (allowlist on), probes the
# gate, asks for the store's REST URL and token (hidden) to approve the first throwaway wallet,
# probes the approval, redeploys without PILOT_MODE (allowlist off), probes the open state,
# redeploys with SPONSOR_HALT=1, probes the halt, redeploys normally, probes the resume, and takes
# every rehearsal deposit back. Each `wrangler deploy` replaces the previous deploy's vars, so the
# `--var` flag is the whole switch; wrangler.toml is not edited. It always ends with a plain
# `npx wrangler deploy`, so the testnet Worker is left in its normal configuration even if a probe
# fails.
#
# Run it outside about 09:00-13:00 UTC (when the nightly claim regression starts) and after 00:00 UTC
# if this connection already used its testnet onboarding share today. The log lands in
# apps/sponsor/adversarial-out/rehearsal-deployed-<date>/rehearsal-log.md (gitignored); its rows go
# into ops note section 1.4.
set -euo pipefail

TARGET="https://lumenia-sponsor.avakit.workers.dev"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT/apps/sponsor"
OUT="$ROOT/apps/sponsor/adversarial-out/rehearsal-deployed-$(date -u +%Y%m%d)"
mkdir -p "$OUT"
git check-ignore -q "$OUT" || { echo "$OUT is not ignored by git; stop" >&2; exit 1; }

say() { printf '\n== %s\n' "$*"; }
probe() { pnpm -s --filter @lumenia/sponsor rehearse -- --target "$TARGET" --out "$OUT" --phase "$1"; }
restore() { say "Leaving the testnet Worker in its normal configuration"; npx wrangler deploy >/dev/null; }
trap restore EXIT

say "1/11 Allowlist ON (PILOT_MODE=1)";        npx wrangler deploy --var PILOT_MODE:1 >/dev/null
say "2/11 Probe the gate";                     probe gated
W1="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["w1Public"])' "$OUT/rehearsal-keys.json" 2>/dev/null || true)"
if [ -z "$W1" ]; then read -r -p "Wallet W1's address (the gated phase printed it): " W1; fi
say "3/11 Approve W1 ($W1) on testnet"
read -rs -p "Store REST URL (KV_REST_API_URL, hidden): " KV_REST_API_URL; echo
read -rs -p "Store token (KV_REST_API_TOKEN, hidden): " KV_REST_API_TOKEN; echo
STELLAR_NETWORK=testnet KV_REST_API_URL="$KV_REST_API_URL" KV_REST_API_TOKEN="$KV_REST_API_TOKEN" pnpm -s run pilot approve "$W1"
unset KV_REST_API_TOKEN
say "4/11 Probe the approval";                 probe approved
say "5/11 Allowlist OFF";                      npx wrangler deploy >/dev/null
say "6/11 Probe the open state";               probe open
say "7/11 Halt by environment (SPONSOR_HALT=1)"; npx wrangler deploy --var SPONSOR_HALT:1 >/dev/null
say "8/11 Probe the halt";                     probe halted
say "9/11 Resume";                             npx wrangler deploy >/dev/null
say "10/11 Probe the resume";                  probe resumed
say "11/11 Take every rehearsal deposit back (each expires two minutes after it was made)"
sleep 130
probe reclaim || { sleep 60; probe reclaim; }
trap - EXIT
say "Done. Log: $OUT/rehearsal-log.md (paste its rows into evidence/SOW2_OPS_NOTE.md section 1.4)"
