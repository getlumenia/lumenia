#!/usr/bin/env bash
# The laptop half of the sponsor's KMS cutover: evidence/SOW2_OPS_NOTE.md section 2.2, steps 2 to 9,
# in one guided run per network. Testnet first, then mainnet.
#
#   bash ops/kms/cutover.sh testnet           # the whole cutover, then a live claim on testnet
#   bash ops/kms/cutover.sh mainnet           # the same on mainnet (asks you to type MAINNET)
#   bash ops/kms/cutover.sh testnet --finish  # step 12, after one real KMS signature has worked:
#   bash ops/kms/cutover.sh mainnet --finish  #   removes the hot key from the Worker
#
# Before it: run ops/kms/cloudshell-setup.sh <network> in AWS CloudShell; it prints the key ARN and
# the access key pair this script asks for. You also need the sponsor account's master secret (for
# the one SetOptions) and the store's REST URL and token (to clear the expected automatic halt).
#
# Every secret is read with a hidden prompt (`read -rs`): nothing is echoed, written to disk, put on
# a command line, or left in the shell after the step that needs it. The script stops at the first
# problem. What it records (the KMS address, the SetOptions file and hash, the times) lands in
# apps/sponsor/.cutover/ (gitignored) for the ops note.
set -euo pipefail

NET="${1:-}"
MODE="${2:-}"
case "$NET" in
  testnet) URL="https://lumenia-sponsor.avakit.workers.dev"; ENVARGS=(); EXPERT="testnet" ;;
  mainnet) URL="https://lumenia-sponsor-mainnet.avakit.workers.dev"; ENVARGS=(--env mainnet); EXPERT="public" ;;
  *) echo "usage: bash ops/kms/cutover.sh testnet|mainnet [--finish]" >&2; exit 2 ;;
esac

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT/apps/sponsor"
mkdir -p .cutover
LOG=".cutover/$NET-cutover.log"
say() { printf '\n== %s\n' "$*"; }
note() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
health() { curl -fsS --max-time 20 "$URL/health"; }
field() {
  python3 -I -c '
import json, sys
v = json.load(sys.stdin)
for k in sys.argv[1].split("."):
    v = v.get(k) if isinstance(v, dict) else None
print("" if v is None else (str(v).lower() if isinstance(v, bool) else v))' "$1"
}

if [ "$MODE" = "--finish" ]; then
  say "Step 12: remove the hot key from the $NET Worker"
  KIND="$(health | field signer.kind)"
  [ "$KIND" = "kms" ] || { echo "/health says signer kind '$KIND', not kms: not removing anything" >&2; exit 1; }
  echo "Only do this after one real transaction signed through KMS has landed on $NET."
  read -r -p "Remove SPONSOR_SECRET from the $NET Worker now? Type yes: " ok
  [ "$ok" = "yes" ] || exit 1
  npx wrangler secret delete SPONSOR_SECRET "${ENVARGS[@]}"
  npx wrangler secret list "${ENVARGS[@]}"
  note "SPONSOR_SECRET removed from the $NET Worker (secret list printed above: keep a screenshot)"
  note "rollback window: the old key stays a signer at weight 1 until $(date -u -v+7d +%Y-%m-%d 2>/dev/null || date -u -d '+7 days' +%Y-%m-%d)"
  exit 0
fi

say "1/8 Reading the $NET sponsor's /health"
H="$(health)"
ACCOUNT="$(printf '%s' "$H" | field account)"
KIND="$(printf '%s' "$H" | field signer.kind)"
SOURCE="$(printf '%s' "$H" | field accountSource)"
echo "account $ACCOUNT, signer kind $KIND, account source $SOURCE"
[ -n "$ACCOUNT" ] || { echo "no account in /health" >&2; exit 1; }
[ "$KIND" != "kms" ] || { echo "already on KMS; nothing to do" >&2; exit 0; }
if [ "$SOURCE" != "SPONSOR_ACCOUNT_ID" ]; then
  echo "The Worker does not name its account yet (SPONSOR_ACCOUNT_ID). KMS mode refuses to start without it." >&2
  echo "Add SPONSOR_ACCOUNT_ID = \"$ACCOUNT\" and KMS_REGION = \"eu-central-1\" to this network's block of" >&2
  echo "apps/sponsor/wrangler.toml, deploy (npx wrangler deploy ${ENVARGS[*]}), then run this again." >&2
  exit 1
fi
if [ "$NET" = "mainnet" ]; then
  read -r -p "This changes the REAL-MONEY sponsor's signers. Type MAINNET to continue: " ok
  [ "$ok" = "MAINNET" ] || exit 1
  export I_UNDERSTAND_MAINNET=1
fi

say "2/8 The KMS key that ops/kms/cloudshell-setup.sh $NET printed"
read -rs -p "KMS key ARN (hidden: it names the AWS account): " KMS_KEY_ID; echo
read -rs -p "AWS access key id (hidden): " AWS_ACCESS_KEY_ID; echo
read -rs -p "AWS secret access key (hidden): " AWS_SECRET_ACCESS_KEY; echo
export KMS_KEY_ID AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
export KMS_REGION="${KMS_REGION:-eu-central-1}"

say "3/8 kms-check: one live KMS signature, verified locally before the key touches any account"
if ! OUT="$(pnpm -s run kms-check 2>&1)"; then
  printf '%s\n' "$OUT"
  echo "kms-check FAILED. Nothing was changed. Send this output to a coding session." >&2
  exit 1
fi
printf '%s\n' "$OUT"
KMS_G="$(printf '%s\n' "$OUT" | sed -n 's/^address  *\(G[A-Z2-7]\{55\}\).*/\1/p' | head -1)"
[ -n "$KMS_G" ] || { echo "kms-check printed no address" >&2; exit 1; }
note "kms-check PASS, KMS address $KMS_G"

say "4/8 The SetOptions that adds $KMS_G as a signer: a dry run first (unsigned, nothing sent)"
FILE=".cutover/$NET-setoptions-$(date -u +%Y%m%dT%H%M%SZ).json"
DRY="$(pnpm -s run add-signer --network "$NET" --account "$ACCOUNT" --signer "$KMS_G" --out "$FILE")"
printf '%s\n' "$DRY"
HASH="$(printf '%s\n' "$DRY" | sed -n 's/^hash  *\([0-9a-f]\{64\}\).*/\1/p' | head -1)"
[ -n "$HASH" ] || { echo "the dry run printed no hash" >&2; exit 1; }
note "SetOptions dry run $FILE hash $HASH"
read -r -p "Submit exactly this SetOptions ($HASH)? Type yes: " ok
[ "$ok" = "yes" ] || exit 1
read -rs -p "The $NET sponsor's master secret, S... (hidden): " SPONSOR_SECRET; echo
export SPONSOR_SECRET
pnpm -s run add-signer --network "$NET" --submit --in "$FILE" --hash "$HASH"
unset SPONSOR_SECRET
note "SetOptions submitted: https://stellar.expert/explorer/$EXPERT/tx/$HASH"

say "5/8 The watchdog should now page and halt $NET (its key-compromise tripwire); waiting up to 20 minutes"
HALTED=""
for _ in $(seq 1 80); do
  HALTED="$(health | field halt.halted || true)"
  [ "$HALTED" = "true" ] && break
  sleep 15
done
if [ "$HALTED" = "true" ]; then
  note "auto-halt observed: $(health | field halt.reason)"
  echo "Clearing the halt (the store's REST URL and token, as in the runbook):"
  read -rs -p "Store REST URL (KV_REST_API_URL, hidden): " KV_REST_API_URL; echo
  read -rs -p "Store token (KV_REST_API_TOKEN, hidden): " KV_REST_API_TOKEN; echo
  for k in "sponsor:halt:$NET" "sponsor:halt:$NET:reason"; do
    curl -fsS -H "authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/$k" >/dev/null
  done
  unset KV_REST_API_TOKEN
  for _ in $(seq 1 12); do [ "$(health | field halt.halted)" = "false" ] && break; sleep 5; done
  note "halt cleared: /health halt.halted=$(health | field halt.halted)"
else
  echo "No halt within 20 minutes. The watchdog should have halted on this SetOptions: note it for the report." >&2
  read -r -p "Continue the cutover anyway? Type yes: " ok
  [ "$ok" = "yes" ] || exit 1
  note "no auto-halt within 20 minutes of the SetOptions"
fi

say "6/8 The credentials and, last, the key id (each secret put deploys the Worker at once)"
printf '%s' "$AWS_ACCESS_KEY_ID" | npx wrangler secret put AWS_ACCESS_KEY_ID "${ENVARGS[@]}"
printf '%s' "$AWS_SECRET_ACCESS_KEY" | npx wrangler secret put AWS_SECRET_ACCESS_KEY "${ENVARGS[@]}"
printf '%s' "$KMS_KEY_ID" | npx wrangler secret put KMS_KEY_ID "${ENVARGS[@]}"
unset KMS_KEY_ID AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

say "7/8 /health from outside"
KIND=""
for _ in $(seq 1 24); do
  H="$(health || true)"
  KIND="$(printf '%s' "$H" | field signer.kind || true)"
  [ "$KIND" = "kms" ] && break
  sleep 5
done
SIGNER="$(printf '%s' "$H" | field signer.publicKey)"
[ "$KIND" = "kms" ] && [ "$SIGNER" = "$KMS_G" ] || { echo "/health: kind '$KIND', signer '$SIGNER' (expected kms, $KMS_G). Roll back per ops note 2.3 if signing fails." >&2; exit 1; }
note "/health signer kind kms, publicKey $KMS_G, account $(printf '%s' "$H" | field account)"

say "8/8 One real signature"
if [ "$NET" = "testnet" ]; then
  (cd "$ROOT/apps/web" && pnpm exec playwright test e2e/claim.spec.ts --reporter=line)
  note "testnet live claim through KMS: passed (claim.spec)"
else
  echo "The next real-money claim (the metric-2 private link) is the first KMS-signed mainnet transaction."
fi
cat <<EOF

Done for $NET. Next:
  - In CloudShell, the CloudTrail lookup that cloudshell-setup.sh printed: keep the Sign entry next to the transaction.
  - After one real transaction has landed through KMS: bash ops/kms/cutover.sh $NET --finish
The record of this run: apps/sponsor/$LOG and $FILE
EOF
