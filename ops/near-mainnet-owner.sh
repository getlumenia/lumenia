#!/bin/bash
# Owner-run only: REAL MONEY on NEAR mainnet. A coding agent prepares these commands; the owner runs them.
# Purpose: prove Lumenia's escrow on mainnet with a few dollars: one link claimed into a brand-new named
# .near account and one claimed to an existing account (claim-to also takes a NEAR Intents deposit address,
# which sends the dollars to another network). Every step prints what it does and the transaction id.
#
# Prerequisite: the deployer (implicit account below; its key is in ~/.near-credentials/mainnet/) holds
# about 6 NEAR and, after `register`, about 5 USDC (Circle native USDC on NEAR).
#
#   bash ops/near-mainnet-owner.sh status                  read-only: balances, config, registration
#   bash ops/near-mainnet-owner.sh unwrap <near>           only if wNEAR arrived instead of NEAR (near_withdraw on wrap.near)
#   bash ops/near-mainnet-owner.sh create                  create lumenia.near with 4 NEAR from the deployer
#   bash ops/near-mainnet-owner.sh deploy                  build the wasm, deploy + init the escrow on lumenia.near with the mainnet
#                                                          values: key_allowance 0.25 NEAR per link key, starter 0 NEAR (testnet runs
#                                                          1 NEAR and 0.05 NEAR); OWNER_ID=<account> sets owner_id (default lumenia.near).
#                                                          owner_id is fixed at init (no transfer method), and `lock` refuses while it is
#                                                          lumenia.near: pick another existing account here if you will ever lock
#   bash ops/near-mainnet-owner.sh register                register lumenia.near and the deployer on USDC
#   bash ops/near-mainnet-owner.sh redeploy                rebuild the escrow from this source and deploy it WITHOUT an init call (the
#                                                          state and every open link stay); signed by lumenia.near's full-access key.
#                                                          It brings mainnet level with testnet: the pool-reserve guard and the return
#                                                          timer (arm_return / return_expired). Run it before `return-proof` and before any `lock`
#   bash ops/near-mainnet-owner.sh link <usdc> <label> [s] lock <usdc> in a new link (key saved under ~/.lumenia-near/mainnet-links/<label>/);
#                                                          [s] = its life in seconds (default 604800, the escrow's minimum is 60)
#   bash ops/near-mainnet-owner.sh reclaim <label>         take back the newest Open link of <label> once it has expired (the deployer is its funder)
#   bash ops/near-mainnet-owner.sh reclaim-proof           a sender reclaim on mainnet: swap 0.1 NEAR to USDC on Rhea, lock 0.10 USDC behind a
#                                                          60-second link, wait for its expiry, take it back (about 2 minutes, about $0.40)
#   bash ops/near-mainnet-owner.sh arm <label>             arm the return timer of link <label> (ops/near-arm-return.mjs, gas sized to its life):
#                                                          after the expiry its USDC comes back to the deployer with nobody signing anything
#   bash ops/near-mainnet-owner.sh wait-home <label>       wait (at most 10 minutes) until link <label> is back with its funder; prints when
#   bash ops/near-mainnet-owner.sh return-proof            the money comes home by itself on mainnet (needs `redeploy` first): swap 0.1 NEAR to
#                                                          USDC on Rhea, lock 0.10 USDC behind a 60-second link, arm its timer, then sign NOTHING
#                                                          while NEAR sends it back (about 4 minutes, about $0.40)
#   bash ops/near-mainnet-owner.sh fund <account> <near>   send <near> NEAR from the deployer to an existing account (e.g. lumenia-first.near 0.02)
#   bash ops/near-mainnet-owner.sh set-starter <near>      owner only: set the NEAR each new account gets at the claim (at most 0.05); a starter
#                                                          above 0 can be farmed by self-claims, at the pool's expense
#   bash ops/near-mainnet-owner.sh claim-named <label> <name>   claim link <label> into a NEW account <name>.near (the link key signs; the recipient pays nothing)
#   bash ops/near-mainnet-owner.sh quote <usdc> <stellarG>      ask NEAR Intents (1Click) for a deposit address that delivers Stellar USDC to <stellarG> (needs a USDC trustline)
#   bash ops/near-mainnet-owner.sh quote-dry <usdc> <stellarG>  the same quote without a deposit address (read-only)
#   bash ops/near-mainnet-owner.sh claim-to <label> <account>   claim link <label> to an existing NEAR account (e.g. the Intents deposit address)
#   bash ops/near-mainnet-owner.sh intents-status <depositAddress>
#   bash ops/near-mainnet-owner.sh swap-usdc <near>             swap <near> NEAR into USDC on NEAR through NEAR Intents (same-chain, usually under
#                                                               a minute); waits until the swap is final and stops unless it succeeded
#   bash ops/near-mainnet-owner.sh wait-swap [depositAddress]   wait for the newest (or the given) swap to be final; succeeds only on SUCCESS
#   bash ops/near-mainnet-owner.sh swap-rhea <near>             fallback when NEAR Intents is stuck: swap <near> NEAR into USDC on Rhea (the Ref
#                                                               exchange v2.ref-finance.near, pool RHEA_POOL, default 5515), 1% slippage; a failed
#                                                               swap refunds the wNEAR to the deployer. Stop a waiting `rest` before running it
#   bash ops/near-mainnet-owner.sh rest <name> <to>             resume `all` after its swap step: wait for the swap if needed, then the two proof
#                                                               links, the deployer's leftover USDC and the rest of its NEAR to <to> (run it once)
#   bash ops/near-mainnet-owner.sh send-usdc-rest <to>          send all USDC left on the deployer to <to> (registers <to> on USDC first if needed)
#   bash ops/near-mainnet-owner.sh send-rest <keep> <to>        send everything above <keep> NEAR from the deployer to <to>
#   bash ops/near-mainnet-owner.sh lock                         IRREVERSIBLE: delete every full-access key of lumenia.near, so nobody can
#                                                               ever redeploy the escrow; its pool NEAR is then spent only by claims.
#                                                               Refuses unless owner_id is another existing account and CONFIRM_LOCK=yes
#                                                               (without it, prints the plan and sends nothing). Never part of `all`.
#   bash ops/near-mainnet-owner.sh all <name> <to>              the whole proof in one go: create, deploy, register, swap 1.5 NEAR to USDC,
#                                                               a 2 USDC link claimed into the NEW account <name>.near, a 1 USDC link claimed
#                                                               to <to>, then the deployer's leftover USDC and the rest of its NEAR to <to> (stops at the first error;
#                                                               OWNER_ID, when set, reaches its deploy step; it does not lock). If it stopped
#                                                               after the swap step, finish with `rest <name> <to>` instead of running `all` again
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.nvm/versions/node/v24.21.0/bin:/opt/homebrew/bin:$PATH"
NEAR=${NEAR_BIN:-$HOME/.cargo/bin/near}
DEPLOYER=06627280e284f7785645741ffdcc83195f4e3809423e7081391515e26e202e6c
CONTRACT=lumenia.near
USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
STELLAR_USDC=nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu
ROOT=near
CRATE="$(cd "$(dirname "$0")/.." && pwd)/contracts/lumen-drop-near"
WASM=$CRATE/target/near/lumenia_drop/lumenia_drop.wasm
LINKS="$HOME/.lumenia-near/mainnet-links"
X=https://nearblocks.io/txns
RPC_MAINNET=${RPC_MAINNET:-https://rpc.mainnet.fastnear.com}
# One read-only JSON-RPC `query` on mainnet (params as JSON); prints the raw answer.
rpcq() { curl -sS -m 20 -A "Mozilla/5.0 (lumenia-ops)" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":$1}" "$RPC_MAINNET"; }
# Prints yes / no / error: whether a mainnet account exists (read-only).
account_exists() {
  rpcq "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}" | python3 -c "import json,sys
d=json.load(sys.stdin)
print('yes' if 'result' in d else ('no' if 'UNKNOWN_ACCOUNT' in json.dumps(d.get('error', {})) else 'error: ' + json.dumps(d.get('error'))[:200]))"
}
# Prints three lines for an account's access keys: its full-access keys (comma-separated), the function-call keys
# that can do more than a link key (anything but claim + claim_to_new_account on the escrow itself), the number
# of function-call keys (read-only).
key_summary() {
  rpcq "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$1\"}" | python3 -c "import json,sys
acct=sys.argv[1]; ks=json.load(sys.stdin)['result']['keys']
fa=[k['public_key'] for k in ks if k['access_key']['permission']=='FullAccess']
fc=[k for k in ks if k['access_key']['permission']!='FullAccess']
odd=[k['public_key'] for k in fc if k['access_key']['permission']['FunctionCall']['receiver_id']!=acct or sorted(k['access_key']['permission']['FunctionCall']['method_names'])!=['claim','claim_to_new_account']]
print(','.join(fa)); print(','.join(odd)); print(len(fc))" "$1"
}
units() { python3 -c "import sys,decimal;print(int(decimal.Decimal(sys.argv[1])*1000000))" "$1"; }
keyfield() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2"; }
genkey() { local f; mkdir -p "$1"; chmod 700 "$1"; "$NEAR" account create-account fund-later use-auto-generation save-to-folder "$1" </dev/null >/dev/null 2>&1; f=$(ls -t "$1"/*.json | head -1); chmod 600 "$f"; echo "$f"; }
# Base64 of a JSON argument object for a read-only call (one line on macOS and Linux).
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
# Prints the USDC units an account holds on mainnet (read-only); prints nothing when the RPC did not answer.
usdc_units() {
  rpcq "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$USDC\",\"method_name\":\"ft_balance_of\",\"args_base64\":\"$(b64 "{\"account_id\":\"$1\"}")\"}" 2>/dev/null | python3 -c "import json,sys
r=json.load(sys.stdin).get('result') or {}
print(json.loads(bytes(r['result']).decode()) if 'result' in r else '')" 2>/dev/null || true
}
# Prints yes / no: whether an account is registered on USDC (read-only); prints nothing when the RPC did not answer.
usdc_registered() {
  rpcq "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$USDC\",\"method_name\":\"storage_balance_of\",\"args_base64\":\"$(b64 "{\"account_id\":\"$1\"}")\"}" 2>/dev/null | python3 -c "import json,sys
r=json.load(sys.stdin).get('result') or {}
print(('no' if json.loads(bytes(r['result']).decode()) is None else 'yes') if 'result' in r else '')" 2>/dev/null || true
}
# Prints the newest key file of link <label> whose drop is Open on the escrow (read-only); prints nothing when none is.
# A key whose lock transaction failed never has a drop, so a claim step can never pick it.
live_link_key() {
  local f pk st
  for f in $(ls -t "$LINKS/$1"/link/*.json 2>/dev/null); do
    pk=$(keyfield "$f" public_key)
    st=$(rpcq "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"get_drop\",\"args_base64\":\"$(b64 "{\"public_key\":\"$pk\"}")\"}" 2>/dev/null | python3 -c "import json,sys
r=json.load(sys.stdin).get('result') or {}
v=json.loads(bytes(r['result']).decode()) if 'result' in r else None
print(v.get('status','') if isinstance(v,dict) else '')" 2>/dev/null || true)
    if [ "$st" = Open ]; then echo "$f"; return 0; fi
  done
  return 0
}
# Polls NEAR Intents until the swap behind deposit address $1 is final, for at most 75 minutes (the quote deadline is
# one hour). Returns 0 only on SUCCESS; a refund comes back to the deployer as wNEAR.
wait_swap() {
  local st="" i
  for i in $(seq 1 450); do
    st=$(curl -sS -m 20 -A "Mozilla/5.0 (lumenia-ops)" "https://1click.chaindefuser.com/v0/status?depositAddress=$1" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null || true)
    case "$st" in
      SUCCESS) echo "  status: SUCCESS"; return 0;;
      REFUNDED|FAILED) echo "  status: $st: the wNEAR goes back to $DEPLOYER; turn it into NEAR with: bash $0 unwrap <near>"; return 1;;
    esac
    if [ $((i % 6)) -eq 1 ]; then echo "  status: ${st:-no answer} at $(date -u +%H:%M:%SZ), waiting"; fi
    sleep 10
  done
  echo "  still ${st:-unknown} after 75 minutes; nothing else was sent. Check again with: bash $0 wait-swap $1"
  return 1
}
{ # bash reads the whole block before it runs it, so editing this file can never change a run that is already going
STEP=${1:-status}
case "$STEP" in
  status)
    for A in "$DEPLOYER" "$CONTRACT"; do echo "-- $A"; "$NEAR" account view-account-summary "$A" network-config mainnet now 2>&1 | grep -E "Native account balance|does not exist" || true; done
    for A in "$DEPLOYER" "$CONTRACT"; do printf "USDC units %s: " "$A"; "$NEAR" contract call-function as-read-only "$USDC" ft_balance_of json-args "{\"account_id\":\"$A\"}" network-config mainnet now 2>&1 | grep -E '^"' || echo "?"; done
    printf "wNEAR units %s: " "$DEPLOYER"; "$NEAR" contract call-function as-read-only wrap.near ft_balance_of json-args "{\"account_id\":\"$DEPLOYER\"}" network-config mainnet now 2>&1 | grep -E '^"' || echo "?"
    "$NEAR" contract call-function as-read-only "$CONTRACT" get_config json-args '{}' network-config mainnet now 2>&1 | grep -E "owner_id|token_id|key_allowance|starter|min_amount|paused|root_account" || echo "(escrow not deployed yet)"
    # A missing account also lists no keys, so the key count is shown only for an account that exists.
    if [ "$(account_exists "$CONTRACT" 2>/dev/null || true)" = yes ]; then
      KS=$(key_summary "$CONTRACT" 2>/dev/null || true)
      if [ -n "$(printf '%s\n' "$KS" | sed -n 3p)" ]; then printf "full-access keys on %s: %s (0 = locked); function-call keys: %s\n" "$CONTRACT" "$(printf '%s\n' "$KS" | sed -n 1p | tr ',' '\n' | grep -c . || true)" "$(printf '%s\n' "$KS" | sed -n 3p)"; fi
    fi
    ;;
  unwrap)
    AMT=$(python3 -c "import sys,decimal;print(int(decimal.Decimal(sys.argv[1])*10**24))" "$2")
    "$NEAR" contract call-function as-transaction wrap.near near_withdraw json-args "{\"amount\":\"$AMT\"}" prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    ;;
  create)
    echo "== create $CONTRACT with 4 NEAR from $DEPLOYER (its new full-access key is saved under ~/.near-credentials/mainnet/)"
    "$NEAR" account create-account fund-myself "$CONTRACT" '4 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    ;;
  deploy)
    # owner_id signs pause / unpause / set_config and is fixed at init: the contract has no ownership transfer.
    # Default: the escrow account itself. `lock` refuses for that owner (the methods would die with the key).
    OWNER=${OWNER_ID:-$CONTRACT}
    ACCOUNT_RE='^(([a-z0-9]+[-_])*[a-z0-9]+[.])*([a-z0-9]+[-_])*[a-z0-9]+$'
    if ! [[ "$OWNER" =~ $ACCOUNT_RE ]] || [ ${#OWNER} -lt 2 ] || [ ${#OWNER} -gt 64 ]; then echo "REFUSED: OWNER_ID '$OWNER' is not a valid NEAR account id; nothing was sent"; exit 1; fi
    if [ "$OWNER" != "$CONTRACT" ]; then
      case "$(account_exists "$OWNER" || true)" in
        yes) ;;
        no) echo "REFUSED: OWNER_ID $OWNER does not exist on mainnet (whoever registers that name would own the escrow); nothing was sent"; exit 1;;
        *) echo "REFUSED: could not check that OWNER_ID $OWNER exists ($RPC_MAINNET); nothing was sent"; exit 1;;
      esac
    else
      echo "note: owner_id = $CONTRACT (the default): its full-access key signs pause/set_config, and \`lock\` will refuse for this escrow; set OWNER_ID=<another account> now if you will ever lock"
    fi
    (cd "$CRATE/contract" && cargo near build non-reproducible-wasm >/dev/null)
    ls -la "$WASM"; shasum -a 256 "$WASM"
    # key_allowance 0.25 NEAR per link key (testnet: 1 NEAR): enough for a 100 Tgas claim at the 0.001 NEAR/Tgas
    # minimum purchase price, and the most gas one link key can ever burn from the pool.
    # starter_yocto 0 (testnet: 0.05 NEAR): on mainnet the starter can be farmed, because a sender who claims their
    # own links into fresh implicit accounts pockets it every round; a recipient's first fee is paid by the
    # relayer or their own wallet instead. claim_to_new_account then attaches 0 NEAR to near.create_account, which
    # sets no minimum (near/near-linkdrop @9a6bb316, the source the mainnet root's NEP-330 metadata names).
    INIT="{\"owner_id\":\"$OWNER\",\"token_id\":\"$USDC\",\"root_account_id\":\"$ROOT\",\"key_allowance\":\"250000000000000000000000\",\"registration_deposit\":\"1250000000000000000000\",\"max_expiry_s\":604800,\"starter_yocto\":\"0\",\"min_amount\":\"100000\"}"
    echo "== deploy + init $CONTRACT: $INIT"
    "$NEAR" contract deploy "$CONTRACT" use-file "$WASM" with-init-call new json-args "$INIT" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-legacy-keychain send
    ;;
  redeploy)
    if [ "$(account_exists "$CONTRACT" || true)" != yes ]; then echo "REFUSED: $CONTRACT does not exist on mainnet (or the RPC did not answer); nothing was sent"; exit 1; fi
    BEFORE=$(rpcq "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('result',{}).get('code_hash',''))" 2>/dev/null || true)
    if [ -z "$BEFORE" ] || [ "$BEFORE" = 11111111111111111111111111111111 ]; then echo "REFUSED: $CONTRACT holds no contract code; use deploy, not redeploy; nothing was sent"; exit 1; fi
    (cd "$CRATE/contract" && cargo near build non-reproducible-wasm >/dev/null)
    NEW_HASH=$(python3 -c "import hashlib,sys
A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
n=int.from_bytes(hashlib.sha256(open(sys.argv[1],'rb').read()).digest(),'big'); o=''
while n: n,r=divmod(n,58); o=A[r]+o
print(o)" "$WASM")
    echo "== redeploy $CONTRACT: code hash $BEFORE -> $NEW_HASH (no init call; state and open links stay)"
    if [ "$BEFORE" = "$NEW_HASH" ]; then echo "already running this code; nothing was sent"; exit 0; fi
    "$NEAR" contract deploy "$CONTRACT" use-file "$WASM" without-init-call network-config mainnet sign-with-legacy-keychain send
    AFTER=$(rpcq "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('result',{}).get('code_hash',''))" 2>/dev/null || true)
    echo "code hash on chain now: $AFTER"
    "$NEAR" contract call-function as-read-only "$CONTRACT" get_stats json-args '{}' network-config mainnet now 2>&1 | grep -E 'drops_created|open_drops' || true
    ;;
  register)
    for A in "$CONTRACT" "$DEPLOYER"; do
      echo "== register $A on USDC (0.00125 NEAR paid by $A)"
      "$NEAR" contract call-function as-transaction "$USDC" storage_deposit json-args "{\"account_id\":\"$A\",\"registration_only\":true}" prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$A" network-config mainnet sign-with-legacy-keychain send
    done
    ;;
  link)
    AMOUNT=$(units "$2"); LABEL=$3; D="$LINKS/$LABEL"
    HAVE=$(usdc_units "$DEPLOYER")
    if ! [[ "$HAVE" =~ ^[0-9]+$ ]]; then echo "REFUSED: could not read the deployer's USDC balance ($RPC_MAINNET); nothing was sent"; exit 1; fi
    if [ "$HAVE" -lt "$AMOUNT" ]; then echo "REFUSED: the deployer holds $HAVE USDC units and this link needs $AMOUNT; nothing was sent (a swap still running? bash $0 wait-swap)"; exit 1; fi
    KF=$(genkey "$D/link")
    PK=$(keyfield "$KF" public_key)
    LIFE=${4:-604800}
    if ! [[ "$LIFE" =~ ^[0-9]+$ ]] || [ "$LIFE" -lt 60 ] || [ "$LIFE" -gt 604800 ]; then echo "REFUSED: the life must be 60 to 604800 seconds, got $LIFE; nothing was sent"; exit 1; fi
    MSG="{\"public_key\":\"$PK\",\"expires_in_s\":$LIFE,\"memo\":\"Lumenia mainnet proof ($LABEL)\"}"
    echo "== lock $2 USDC behind link $LABEL (public key $PK); the secret stays in $KF (0600)"
    ARGS=$(python3 -c "import json,sys;print(json.dumps({'receiver_id':sys.argv[1],'amount':sys.argv[2],'msg':sys.argv[3]}))" "$CONTRACT" "$AMOUNT" "$MSG")
    "$NEAR" contract call-function as-transaction "$USDC" ft_transfer_call json-args "$ARGS" prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    "$NEAR" contract call-function as-read-only "$CONTRACT" get_drop json-args "{\"public_key\":\"$PK\"}" network-config mainnet now 2>&1 | grep -E '"status"|"amount"' || true
    OPEN=""; for i in 1 2 3 4 5 6; do if [ "$(live_link_key "$LABEL")" = "$KF" ]; then OPEN=1; break; fi; sleep 2; done
    if [ -z "$OPEN" ]; then echo "!!! link $PK is not Open on $CONTRACT: check the transaction above before any claim step"; exit 1; fi
    ;;
  claim-named)
    LABEL=$2; NAME=$3; D="$LINKS/$LABEL"; KF=$(live_link_key "$LABEL")
    if [ -z "$KF" ]; then echo "REFUSED: no Open link under $D/link (make one with: bash $0 link <usdc> $LABEL); nothing was sent"; exit 1; fi
    SK=$(keyfield "$KF" private_key); RF=$(genkey "$D/recipient"); RPK=$(keyfield "$RF" public_key)
    echo "== claim link $LABEL into the NEW account $NAME.near (its key: $RF)"
    "$NEAR" contract call-function as-transaction "$CONTRACT" claim_to_new_account json-args "{\"new_account_id\":\"$NAME.near\",\"new_public_key\":\"$RPK\"}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as "$CONTRACT" network-config mainnet sign-with-plaintext-private-key "$SK" send
    "$NEAR" account view-account-summary "$NAME.near" network-config mainnet now 2>&1 | grep -E "Native account balance" || true
    printf "USDC units %s.near: " "$NAME"; "$NEAR" contract call-function as-read-only "$USDC" ft_balance_of json-args "{\"account_id\":\"$NAME.near\"}" network-config mainnet now 2>&1 | grep -E '^"'
    ;;
  quote|quote-dry)
    AMOUNT=$(units "$2"); G=$3; DRY=$([ "$STEP" = quote-dry ] && echo true || echo false)
    DL=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")
    BODY="{\"dry\":$DRY,\"swapType\":\"EXACT_INPUT\",\"slippageTolerance\":100,\"originAsset\":\"nep141:$USDC\",\"depositType\":\"ORIGIN_CHAIN\",\"destinationAsset\":\"$STELLAR_USDC\",\"amount\":\"$AMOUNT\",\"refundTo\":\"$DEPLOYER\",\"refundType\":\"ORIGIN_CHAIN\",\"recipient\":\"$G\",\"recipientType\":\"DESTINATION_CHAIN\",\"deadline\":\"$DL\"}"
    mkdir -p "$LINKS"; OUT="$LINKS/quote-$(date -u +%Y%m%dT%H%M%SZ).json"
    curl -sS -A "Mozilla/5.0 (lumenia-ops)" -H 'content-type: application/json' -d "$BODY" https://1click.chaindefuser.com/v0/quote > "$OUT"
    python3 -c "import json,sys;d=json.load(open(sys.argv[1]));q=d.get('quote',{});print({k:q.get(k) for k in ('depositAddress','depositMemo','amountInFormatted','amountOutFormatted','timeEstimate','deadline')} if q else d)" "$OUT"
    echo "(full quote with its signature saved to $OUT; keep it until the swap completes)"
    ;;
  claim-to)
    LABEL=$2; TO=$3; D="$LINKS/$LABEL"; KF=$(live_link_key "$LABEL")
    if [ -z "$KF" ]; then echo "REFUSED: no Open link under $D/link (make one with: bash $0 link <usdc> $LABEL); nothing was sent"; exit 1; fi
    SK=$(keyfield "$KF" private_key)
    echo "== claim link $LABEL to the existing account $TO"
    "$NEAR" contract call-function as-transaction "$CONTRACT" claim json-args "{\"account_id\":\"$TO\"}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as "$CONTRACT" network-config mainnet sign-with-plaintext-private-key "$SK" send
    ;;
  intents-status)
    curl -sS -A "Mozilla/5.0 (lumenia-ops)" "https://1click.chaindefuser.com/v0/status?depositAddress=$2" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status'), json.dumps(d.get('swapDetails',{}))[:600])"
    ;;
  swap-usdc)
    AMT=$(python3 -c "import sys,decimal;print(int(decimal.Decimal(sys.argv[1])*10**24))" "$2")
    if ! "$NEAR" contract call-function as-read-only wrap.near storage_balance_of json-args "{\"account_id\":\"$DEPLOYER\"}" network-config mainnet now 2>&1 | grep '"total"' >/dev/null; then
      echo "== register the deployer on wNEAR (0.00125 NEAR)"
      "$NEAR" contract call-function as-transaction wrap.near storage_deposit json-args "{\"account_id\":\"$DEPLOYER\",\"registration_only\":true}" prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    fi
    echo "== wrap $2 NEAR into wNEAR"
    "$NEAR" contract call-function as-transaction wrap.near near_deposit json-args '{}' prepaid-gas '30 Tgas' attached-deposit "$2 NEAR" sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    DL=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")
    BODY="{\"dry\":false,\"swapType\":\"EXACT_INPUT\",\"slippageTolerance\":100,\"originAsset\":\"nep141:wrap.near\",\"depositType\":\"ORIGIN_CHAIN\",\"destinationAsset\":\"nep141:$USDC\",\"amount\":\"$AMT\",\"refundTo\":\"$DEPLOYER\",\"refundType\":\"ORIGIN_CHAIN\",\"recipient\":\"$DEPLOYER\",\"recipientType\":\"DESTINATION_CHAIN\",\"deadline\":\"$DL\"}"
    mkdir -p "$LINKS"; OUT="$LINKS/swap-$(date -u +%Y%m%dT%H%M%SZ).json"
    curl -sS -A "Mozilla/5.0 (lumenia-ops)" -H 'content-type: application/json' -d "$BODY" https://1click.chaindefuser.com/v0/quote > "$OUT"
    DEP=$(python3 -c "import json,sys;q=json.load(open(sys.argv[1])).get('quote',{});print(q.get('depositAddress','') if not q.get('depositMemo') else '')" "$OUT")
    python3 -c "import json,sys;q=json.load(open(sys.argv[1])).get('quote',{});print('quote:', q.get('amountInFormatted'), 'wNEAR ->', q.get('amountOutFormatted'), 'USDC, min', q.get('minAmountOut'), 'units, deposit', q.get('depositAddress'))" "$OUT"
    if ! [[ "$DEP" =~ ^[a-z0-9._-]{2,64}$ ]]; then echo "no usable deposit address in $OUT; nothing was sent"; exit 1; fi
    echo "== register the deposit address on wNEAR (0.00125 NEAR; refunded if already registered)"
    "$NEAR" contract call-function as-transaction wrap.near storage_deposit json-args "{\"account_id\":\"$DEP\",\"registration_only\":true}" prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    echo "== send $2 wNEAR to the NEAR Intents deposit address $DEP"
    "$NEAR" contract call-function as-transaction wrap.near ft_transfer json-args "{\"receiver_id\":\"$DEP\",\"amount\":\"$AMT\"}" prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    wait_swap "$DEP" || exit 1
    echo "USDC units now: $(usdc_units "$DEPLOYER")"
    ;;
  swap-rhea)
    # Ref's instant swap, as @ref-finance/ref-sdk 1.5.0 builds it: ft_transfer_call of wNEAR to v2.ref-finance.near
    # with {"force":0,"actions":[{pool_id, token_in, token_out, amount_in, min_amount_out}]}, 300 Tgas, 1 yoctoNEAR.
    REF=v2.ref-finance.near; POOL=${RHEA_POOL:-5515}
    AMT=$(python3 -c "import sys,decimal;print(int(decimal.Decimal(sys.argv[1])*10**24))" "$2")
    # Build the arguments in plain variables: a multi-key JSON nested inside $( "$( )" ) loses its quotes in
    # macOS /bin/bash 3.2 and gets brace-expanded into pieces.
    QARGS="{\"pool_id\":$POOL,\"token_in\":\"wrap.near\",\"amount_in\":\"$AMT\",\"token_out\":\"$USDC\"}"
    QB64=$(b64 "$QARGS")
    QPARAMS="{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$REF\",\"method_name\":\"get_return\",\"args_base64\":\"$QB64\"}"
    OUT=""
    for i in 1 2 3 4 5; do
      OUT=$(rpcq "$QPARAMS" 2>/dev/null | python3 -c "import json,sys
r=json.load(sys.stdin).get('result') or {}
print(json.loads(bytes(r['result']).decode()) if 'result' in r else '')" 2>/dev/null || true)
      if [[ "$OUT" =~ ^[0-9]+$ ]]; then break; fi
      sleep 2
    done
    if ! [[ "$OUT" =~ ^[0-9]+$ ]] || [ "$OUT" -le 0 ]; then echo "REFUSED: no quote from $REF pool $POOL ($RPC_MAINNET); nothing was sent"; exit 1; fi
    MIN=$((OUT * 99 / 100))
    BEFORE=$(usdc_units "$DEPLOYER")
    if ! [[ "$BEFORE" =~ ^[0-9]+$ ]]; then echo "REFUSED: could not read the deployer's USDC balance ($RPC_MAINNET); nothing was sent"; exit 1; fi
    if [ "$(usdc_registered "$DEPLOYER")" != yes ]; then echo "REFUSED: the deployer is not registered on USDC (bash $0 register); nothing was sent"; exit 1; fi
    echo "== quote: $2 wNEAR gives $OUT USDC units on $REF pool $POOL; the swap accepts no less than $MIN"
    if ! "$NEAR" contract call-function as-read-only wrap.near storage_balance_of json-args "{\"account_id\":\"$DEPLOYER\"}" network-config mainnet now 2>&1 | grep '"total"' >/dev/null; then
      echo "== register the deployer on wNEAR (0.00125 NEAR)"
      "$NEAR" contract call-function as-transaction wrap.near storage_deposit json-args "{\"account_id\":\"$DEPLOYER\",\"registration_only\":true}" prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    fi
    echo "== wrap $2 NEAR into wNEAR"
    "$NEAR" contract call-function as-transaction wrap.near near_deposit json-args '{}' prepaid-gas '30 Tgas' attached-deposit "$2 NEAR" sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    MSG=$(python3 -c "import json,sys;print(json.dumps({'force':0,'actions':[{'pool_id':int(sys.argv[1]),'token_in':'wrap.near','token_out':sys.argv[2],'amount_in':sys.argv[3],'min_amount_out':sys.argv[4]}]}))" "$POOL" "$USDC" "$AMT" "$MIN")
    ARGS=$(python3 -c "import json,sys;print(json.dumps({'receiver_id':sys.argv[1],'amount':sys.argv[2],'msg':sys.argv[3]}))" "$REF" "$AMT" "$MSG")
    echo "== swap $2 wNEAR to USDC on $REF pool $POOL"
    "$NEAR" contract call-function as-transaction wrap.near ft_transfer_call json-args "$ARGS" prepaid-gas '300 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    AFTER=""; for i in 1 2 3 4 5 6; do AFTER=$(usdc_units "$DEPLOYER"); if [[ "$AFTER" =~ ^[0-9]+$ ]] && [ "$AFTER" -gt "$BEFORE" ]; then break; fi; sleep 2; done
    echo "USDC units: $BEFORE before, ${AFTER:-unknown} now"
    if ! [[ "$AFTER" =~ ^[0-9]+$ ]] || [ "$AFTER" -le "$BEFORE" ]; then echo "!!! no USDC arrived: check the transaction above. A failed swap refunds the wNEAR to the deployer (bash $0 status, then bash $0 unwrap <near>)"; exit 1; fi
    ;;
  wait-swap)
    DA=${2:-}
    if [ -z "$DA" ]; then
      SF=$(ls -t "$LINKS"/swap-*.json 2>/dev/null | head -1 || true)
      if [ -n "$SF" ]; then DA=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('quote',{}).get('depositAddress',''))" "$SF"); fi
    fi
    if [ -z "$DA" ]; then echo "no swap quote under $LINKS; run swap-usdc first"; exit 1; fi
    echo "== wait for the NEAR Intents swap behind deposit address $DA"
    wait_swap "$DA" || exit 1
    echo "USDC units now: $(usdc_units "$DEPLOYER")"
    ;;
  send-usdc-rest)
    TO=$2
    HAVE=$(usdc_units "$DEPLOYER")
    if ! [[ "$HAVE" =~ ^[0-9]+$ ]]; then echo "REFUSED: could not read the deployer's USDC balance ($RPC_MAINNET); nothing was sent"; exit 1; fi
    if [ "$HAVE" -eq 0 ]; then echo "no USDC left on $DEPLOYER"; exit 0; fi
    case "$(usdc_registered "$TO")" in
      yes) ;;
      no)
        echo "== register $TO on USDC (0.00125 NEAR paid by the deployer)"
        "$NEAR" contract call-function as-transaction "$USDC" storage_deposit json-args "{\"account_id\":\"$TO\",\"registration_only\":true}" prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
        ;;
      *) echo "REFUSED: could not read whether $TO is registered on USDC ($RPC_MAINNET); nothing was sent"; exit 1;;
    esac
    echo "== send the deployer's remaining $HAVE USDC units to $TO"
    "$NEAR" contract call-function as-transaction "$USDC" ft_transfer json-args "{\"receiver_id\":\"$TO\",\"amount\":\"$HAVE\"}" prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    ;;
  send-rest)
    KEEP=$2; TO=$3
    SEND=$(curl -s -A "Mozilla/5.0" "$RPC_MAINNET" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$DEPLOYER\"}}" | python3 -c "
import json,sys,decimal
a=int(json.load(sys.stdin)['result']['amount']); keep=int(decimal.Decimal(sys.argv[1])*10**24)
s=a-keep
print(s if s>0 else 0)" "$KEEP")
    if [ "$SEND" = "0" ]; then echo "nothing above $KEEP NEAR to send"; exit 0; fi
    echo "== send $SEND yoctoNEAR (everything above $KEEP NEAR) from $DEPLOYER to $TO"
    "$NEAR" tokens "$DEPLOYER" send-near "$TO" "$SEND yoctonear" network-config mainnet sign-with-legacy-keychain send
    ;;
  lock)
    echo "!!! IRREVERSIBLE, REAL MONEY: lock deletes EVERY full-access key of $CONTRACT on mainnet."
    echo "!!! Afterwards nobody, not the owner and not this script, can ever redeploy, migrate or delete the escrow"
    echo "!!! or add a key to it, and the pool NEAR left in $CONTRACT can then only be spent by claims (and the storage"
    echo "!!! of new links): the contract has no withdraw. pause / unpause / set_config stay with owner_id (set_config"
    echo "!!! can still raise starter_yocto, which claims then pay out of that pool)."
    echo "!!! Without CONFIRM_LOCK=yes this step only checks and prints the plan; it sends nothing."
    CODE_HASH=$(rpcq "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('result',{}).get('code_hash',''))" 2>/dev/null || true)
    if [ -z "$CODE_HASH" ]; then echo "REFUSED: $CONTRACT does not exist on mainnet (or $RPC_MAINNET did not answer); nothing was sent"; exit 1; fi
    if [ "$CODE_HASH" = 11111111111111111111111111111111 ]; then echo "REFUSED: $CONTRACT holds no contract code; deploy first (a locked account without code is lost for good); nothing was sent"; exit 1; fi
    ESCROW_OWNER=$(rpcq "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"get_config\",\"args_base64\":\"e30=\"}" | python3 -c "import json,sys;r=json.load(sys.stdin)['result'];print(json.loads(bytes(r['result']).decode())['owner_id'])" 2>/dev/null || true)
    if [ -z "$ESCROW_OWNER" ]; then echo "REFUSED: get_config on $CONTRACT gave no owner_id (is the escrow deployed and initialised?); nothing was sent"; exit 1; fi
    if [ "$ESCROW_OWNER" = "$CONTRACT" ]; then
      echo "REFUSED: the escrow's owner_id is $CONTRACT itself: without its full-access key nobody could ever call pause, unpause or set_config again."
      echo "         owner_id is fixed at init (there is no transfer method); an escrow that should be locked is deployed with OWNER_ID=<another account>. Nothing was sent."
      exit 1
    fi
    case "$(account_exists "$ESCROW_OWNER" || true)" in
      yes) ;;
      no) echo "REFUSED: owner_id $ESCROW_OWNER does not exist on mainnet (whoever registers that name would own the escrow); nothing was sent"; exit 1;;
      *) echo "REFUSED: could not check that owner_id $ESCROW_OWNER exists ($RPC_MAINNET); nothing was sent"; exit 1;;
    esac
    KS=$(key_summary "$CONTRACT" 2>/dev/null || true)
    FULL=$(printf '%s\n' "$KS" | sed -n 1p); ODD=$(printf '%s\n' "$KS" | sed -n 2p); NFC=$(printf '%s\n' "$KS" | sed -n 3p)
    if [ -z "$NFC" ]; then echo "REFUSED: could not read the access keys of $CONTRACT ($RPC_MAINNET); nothing was sent"; exit 1; fi
    if [ -n "$ODD" ]; then
      echo "REFUSED: function-call key(s) on $CONTRACT that can do more than a link key would survive the lock: $ODD"
      echo "         delete them first: $NEAR account delete-keys $CONTRACT public-keys $ODD network-config mainnet sign-with-legacy-keychain send"
      exit 1
    fi
    if [ -z "$FULL" ]; then echo "$CONTRACT has no full-access key left: it is already locked ($NFC link keys remain, claim only)"; exit 0; fi
    echo "== plan: delete the full-access key(s) $FULL of $CONTRACT (code hash $CODE_HASH, owner_id $ESCROW_OWNER; the $NFC link keys stay, claim and claim_to_new_account only)"
    if [ "${CONFIRM_LOCK:-}" != yes ]; then echo "REFUSED: CONFIRM_LOCK=yes is not set; nothing was sent. Re-run as: CONFIRM_LOCK=yes bash $0 lock"; exit 1; fi
    "$NEAR" account delete-keys "$CONTRACT" public-keys "$FULL" network-config mainnet sign-with-legacy-keychain send
    # Confirm from the chain: an answered key list (its third line, the function-call key count, is present)
    # with no full-access key. An RPC that does not answer is never read as "locked".
    LEFT="?"
    for i in 1 2 3 4 5; do
      KS=$(key_summary "$CONTRACT" 2>/dev/null || true)
      if [ -n "$(printf '%s\n' "$KS" | sed -n 3p)" ]; then
        LEFT=$(printf '%s\n' "$KS" | sed -n 1p)
        if [ -z "$LEFT" ]; then echo "== locked: $CONTRACT has no full-access key. Nobody can redeploy it; its pool NEAR is spent only by claims."; exit 0; fi
      fi
      sleep 2
    done
    echo "!!! could not confirm the lock (full-access keys still listed: $LEFT; ? = the RPC did not answer): check with $NEAR account list-keys $CONTRACT network-config mainnet now"
    exit 1
    ;;
  all)
    NAME=$2; TO=$3
    "$0" create && "$0" deploy && "$0" register && "$0" swap-usdc 1.5 \
      && "$0" link 2 proof-a && "$0" claim-named proof-a "$NAME" \
      && "$0" link 1 proof-b && "$0" claim-to proof-b "$TO" \
      && "$0" send-usdc-rest "$TO" && "$0" send-rest 0.3 "$TO" && "$0" status
    ;;
  reclaim)
    LABEL=$2; D="$LINKS/$LABEL"; KF=$(live_link_key "$LABEL")
    if [ -z "$KF" ]; then echo "REFUSED: no Open link under $D/link; nothing was sent"; exit 1; fi
    PK=$(keyfield "$KF" public_key)
    RARGS="{\"public_key\":\"$PK\"}"
    RB64=$(b64 "$RARGS")
    EXP=$(rpcq "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"get_drop\",\"args_base64\":\"$RB64\"}" 2>/dev/null | python3 -c "import json,sys
r=json.load(sys.stdin).get('result') or {}
v=json.loads(bytes(r['result']).decode()) if 'result' in r else None
print(v.get('expires_at_ns','') if isinstance(v,dict) else '')" 2>/dev/null || true)
    if ! [[ "$EXP" =~ ^[0-9]+$ ]]; then echo "REFUSED: could not read the link's expiry ($RPC_MAINNET); nothing was sent"; exit 1; fi
    LEFT=$(python3 -c "import sys,time;print(max(0, int(sys.argv[1])//10**9 - int(time.time()) + 2))" "$EXP")
    if [ "$LEFT" -gt 0 ]; then echo "== link $LABEL expires in $LEFT s; waiting"; sleep "$LEFT"; fi
    echo "== take back link $LABEL (public key $PK) as its funder $DEPLOYER"
    "$NEAR" contract call-function as-transaction "$CONTRACT" reclaim json-args "$RARGS" prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    "$NEAR" contract call-function as-read-only "$CONTRACT" get_drop json-args "$RARGS" network-config mainnet now 2>&1 | grep -E '"status"|"amount"' || true
    echo "USDC units on the deployer now: $(usdc_units "$DEPLOYER")"
    ;;
  reclaim-proof)
    "$0" swap-rhea 0.1 && "$0" link 0.10 proof-r 60 && "$0" reclaim proof-r && "$0" status
    ;;
  arm)
    LABEL=$2; KF=$(live_link_key "$LABEL")
    if [ -z "$KF" ]; then echo "REFUSED: no Open link under $LINKS/$LABEL/link; nothing was sent"; exit 1; fi
    CODE=$(rpcq "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('result',{}).get('code_hash',''))" 2>/dev/null || true)
    if [ "$CODE" = GDKwUNKV1mvWVr48y77m9FEWkodcvCignc4GzJNAAcYv ]; then echo "REFUSED: $CONTRACT still runs the build without the return timer; run \`bash $0 redeploy\` first; nothing was sent"; exit 1; fi
    PK=$(keyfield "$KF" public_key)
    EXP=$(rpcq "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"get_drop\",\"args_base64\":\"$(b64 "{\"public_key\":\"$PK\"}")\"}" 2>/dev/null | python3 -c "import json,sys
r=json.load(sys.stdin).get('result') or {}
v=json.loads(bytes(r['result']).decode()) if 'result' in r else None
print(v.get('expires_at_ns','') if isinstance(v,dict) else '')" 2>/dev/null || true)
    if ! [[ "$EXP" =~ ^[0-9]+$ ]]; then echo "REFUSED: could not read the link's expiry ($RPC_MAINNET); nothing was sent"; exit 1; fi
    # The gas of @lumenia/near/return-timer for one link: 45 Tgas, plus 3 a wake-up (one each 100 s, two spare), at most 1 PGas.
    TGAS=$(python3 -c "import math,sys,time;left=max(0,int(sys.argv[1])//10**9-int(time.time()));t=45+(math.ceil(left/100)+2)*3;print(t if t<=1000 else '')" "$EXP")
    if [ -z "$TGAS" ]; then echo "REFUSED: link $LABEL lives longer than one return timer lasts (about 8 hours); take it back with \`reclaim\` after its expiry; nothing was sent"; exit 1; fi
    echo "== arm the return timer of link $LABEL ($PK): $TGAS Tgas from $DEPLOYER; after this, nobody signs anything"
    node "$(dirname "$0")/near-arm-return.mjs" --network mainnet --signer "$DEPLOYER" --tgas "$TGAS" "$PK"
    ;;
  wait-home)
    LABEL=$2; KF=$(ls -t "$LINKS/$LABEL"/link/*.json 2>/dev/null | head -1)
    if [ -z "$KF" ]; then echo "REFUSED: no link under $LINKS/$LABEL/link"; exit 1; fi
    PK=$(keyfield "$KF" public_key)
    echo "== waiting for link $LABEL ($PK) to come home; nobody is signing anything"
    for i in $(seq 1 60); do
      LINE=$(rpcq "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"get_drop\",\"args_base64\":\"$(b64 "{\"public_key\":\"$PK\"}")\"}" 2>/dev/null | python3 -c "import json,sys,time
r=json.load(sys.stdin).get('result') or {}
v=json.loads(bytes(r['result']).decode()) if 'result' in r else None
if isinstance(v,dict): print(v['status'], time.strftime('%H:%M:%S', time.gmtime(int(v['expires_at_ns'])/1e9)), time.strftime('%H:%M:%S', time.gmtime(int(v['status_changed_at_ns'])/1e9)))" 2>/dev/null || true)
      set -- $LINE
      if [ "${1:-}" = Reclaimed ]; then echo "home: expired at $2 UTC, sent back at $3 UTC; USDC units on the deployer now: $(usdc_units "$DEPLOYER")"; exit 0; fi
      sleep 10
    done
    echo "!!! link $LABEL is not home after 10 minutes (status ${1:-unknown}); check the arm transaction"; exit 1
    ;;
  return-proof)
    "$0" swap-rhea 0.1 && "$0" link 0.10 proof-t 60 && "$0" arm proof-t && "$0" wait-home proof-t && "$0" status
    ;;
  fund)
    TO=$2; AMT_NEAR=$3
    if ! python3 -c "import sys,decimal;d=decimal.Decimal(sys.argv[1]);sys.exit(0 if 0 < d <= 1 else 1)" "$AMT_NEAR" 2>/dev/null; then echo "REFUSED: fund takes 0 to 1 NEAR, got $AMT_NEAR; nothing was sent"; exit 1; fi
    case "$(account_exists "$TO" || true)" in
      yes) ;;
      *) echo "REFUSED: $TO does not exist on mainnet (or the RPC did not answer); nothing was sent"; exit 1;;
    esac
    echo "== send $AMT_NEAR NEAR from $DEPLOYER to $TO"
    "$NEAR" tokens "$DEPLOYER" send-near "$TO" "$AMT_NEAR NEAR" network-config mainnet sign-with-legacy-keychain send
    ;;
  set-starter)
    AMT_NEAR=$2
    YOCTO=$(python3 -c "import sys,decimal;d=decimal.Decimal(sys.argv[1]);print(int(d*10**24) if 0 <= d <= decimal.Decimal('0.05') else '')" "$AMT_NEAR" 2>/dev/null || true)
    if ! [[ "$YOCTO" =~ ^[0-9]+$ ]]; then echo "REFUSED: the starter is 0 to 0.05 NEAR, got $AMT_NEAR; nothing was sent"; exit 1; fi
    OWNER_NOW=$(rpcq "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"get_config\",\"args_base64\":\"e30=\"}" | python3 -c "import json,sys;r=json.load(sys.stdin)['result'];print(json.loads(bytes(r['result']).decode())['owner_id'])" 2>/dev/null || true)
    if [ "$OWNER_NOW" != "$DEPLOYER" ]; then echo "REFUSED: the escrow's owner_id is ${OWNER_NOW:-unknown}, not the deployer; nothing was sent"; exit 1; fi
    echo "!!! a starter above 0 is paid by the escrow's pool on every claim into a new account, and self-claims can farm it."
    echo "== set starter_yocto to $YOCTO ($AMT_NEAR NEAR) on $CONTRACT"
    "$NEAR" contract call-function as-transaction "$CONTRACT" set_config json-args "{\"starter_yocto\":\"$YOCTO\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    "$NEAR" contract call-function as-read-only "$CONTRACT" get_config json-args '{}' network-config mainnet now 2>&1 | grep -E 'starter' || true
    ;;
  rest)
    NAME=$2; TO=$3
    HAVE=$(usdc_units "$DEPLOYER")
    if ! [[ "$HAVE" =~ ^[0-9]+$ ]] || [ "$HAVE" -lt 3000000 ]; then "$0" wait-swap || exit 1; fi
    "$0" link 2 proof-a && "$0" claim-named proof-a "$NAME" \
      && "$0" link 1 proof-b && "$0" claim-to proof-b "$TO" \
      && "$0" send-usdc-rest "$TO" && "$0" send-rest 0.3 "$TO" && "$0" status
    ;;
  *) echo "unknown step $STEP"; exit 2;;
esac
exit
}
