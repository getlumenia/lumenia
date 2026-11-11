#!/bin/bash
# Owner-run only: REAL MONEY on NEAR mainnet. A coding agent prepares these commands; the owner runs them.
# Purpose: prove Lumenia's escrow on mainnet with a few dollars: one link claimed into a brand-new named
# .near account, and one link claimed straight into a NEAR Intents deposit address so the dollars land on
# Stellar (claim to another network). Every step prints what it does and the explorer link.
#
# Prerequisite: the deployer (implicit account below; its key is in ~/.near-credentials/mainnet/) holds
# about 6 NEAR and, after `register`, about 5 USDC (Circle native USDC on NEAR).
#
#   bash ops/near-mainnet-owner.sh status                  read-only: balances, config, registration
#   bash ops/near-mainnet-owner.sh unwrap <near>           only if wNEAR arrived instead of NEAR (near_withdraw on wrap.near)
#   bash ops/near-mainnet-owner.sh create                  create lumenia.near with 4 NEAR from the deployer
#   bash ops/near-mainnet-owner.sh deploy                  build the wasm, deploy + init the escrow on lumenia.near
#   bash ops/near-mainnet-owner.sh register                register lumenia.near and the deployer on USDC
#   bash ops/near-mainnet-owner.sh link <usdc> <label>     lock <usdc> in a new link (key saved under ~/.lumenia-near/mainnet-links/<label>/)
#   bash ops/near-mainnet-owner.sh claim-named <label> <name>   claim link <label> into a NEW account <name>.near (the link key signs; the recipient pays nothing)
#   bash ops/near-mainnet-owner.sh quote <usdc> <stellarG>      ask NEAR Intents (1Click) for a deposit address that delivers Stellar USDC to <stellarG> (needs a USDC trustline)
#   bash ops/near-mainnet-owner.sh quote-dry <usdc> <stellarG>  the same quote without a deposit address (read-only)
#   bash ops/near-mainnet-owner.sh claim-to <label> <account>   claim link <label> to an existing NEAR account (e.g. the Intents deposit address)
#   bash ops/near-mainnet-owner.sh intents-status <depositAddress>
#   bash ops/near-mainnet-owner.sh swap-usdc <near>             swap <near> NEAR into USDC on NEAR through NEAR Intents (same-chain, about 20 s)
#   bash ops/near-mainnet-owner.sh send-rest <keep> <to>        send everything above <keep> NEAR from the deployer to <to>
#   bash ops/near-mainnet-owner.sh all <name> <to>              the whole proof in one go: create, deploy, register, swap 1.5 NEAR to USDC,
#                                                               a 2 USDC link claimed into the NEW account <name>.near, a 1 USDC link claimed
#                                                               to <to>, then the rest of the deployer's NEAR to <to> (stops at the first error)
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
units() { python3 -c "import sys,decimal;print(int(decimal.Decimal(sys.argv[1])*1000000))" "$1"; }
keyfield() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2"; }
genkey() { mkdir -p "$1"; chmod 700 "$1"; "$NEAR" account create-account fund-later use-auto-generation save-to-folder "$1" >/dev/null 2>&1; ls -t "$1"/*.json | head -1; }
STEP=${1:-status}
case "$STEP" in
  status)
    for A in "$DEPLOYER" "$CONTRACT"; do echo "-- $A"; "$NEAR" account view-account-summary "$A" network-config mainnet now 2>&1 | grep -E "Native account balance|does not exist" || true; done
    for A in "$DEPLOYER" "$CONTRACT"; do printf "USDC units %s: " "$A"; "$NEAR" contract call-function as-read-only "$USDC" ft_balance_of json-args "{\"account_id\":\"$A\"}" network-config mainnet now 2>&1 | grep -E '^"' || echo "?"; done
    printf "wNEAR units %s: " "$DEPLOYER"; "$NEAR" contract call-function as-read-only wrap.near ft_balance_of json-args "{\"account_id\":\"$DEPLOYER\"}" network-config mainnet now 2>&1 | grep -E '^"' || echo "?"
    "$NEAR" contract call-function as-read-only "$CONTRACT" get_config json-args '{}' network-config mainnet now 2>&1 | grep -E "token_id|starter|min_amount|paused|root_account" || echo "(escrow not deployed yet)"
    ;;
  unwrap)
    AMT=$(python3 -c "import sys,decimal;print(int(decimal.Decimal(sys.argv[1])*10**24))" "$2")
    "$NEAR" contract call-function as-transaction wrap.near near_withdraw json-args "{\"amount\":\"$AMT\"}" prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    ;;
  create)
    echo "== create $CONTRACT with 4 NEAR from $DEPLOYER (its new full-access key is saved under ~/.near-credentials/mainnet/)"
    "$NEAR" account create-account fund-myself "$CONTRACT" '4 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    ;;
  deploy)
    (cd "$CRATE/contract" && cargo near build non-reproducible-wasm >/dev/null)
    ls -la "$WASM"; shasum -a 256 "$WASM"
    INIT="{\"owner_id\":\"$CONTRACT\",\"token_id\":\"$USDC\",\"root_account_id\":\"$ROOT\",\"key_allowance\":\"1000000000000000000000000\",\"registration_deposit\":\"1250000000000000000000\",\"max_expiry_s\":604800,\"starter_yocto\":\"50000000000000000000000\",\"min_amount\":\"100000\"}"
    echo "== deploy + init $CONTRACT: $INIT"
    "$NEAR" contract deploy "$CONTRACT" use-file "$WASM" with-init-call new json-args "$INIT" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-legacy-keychain send
    ;;
  register)
    for A in "$CONTRACT" "$DEPLOYER"; do
      echo "== register $A on USDC (0.00125 NEAR paid by $A)"
      "$NEAR" contract call-function as-transaction "$USDC" storage_deposit json-args "{\"account_id\":\"$A\",\"registration_only\":true}" prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$A" network-config mainnet sign-with-legacy-keychain send
    done
    ;;
  link)
    AMOUNT=$(units "$2"); LABEL=$3; D="$LINKS/$LABEL"; KF=$(genkey "$D/link")
    PK=$(keyfield "$KF" public_key)
    MSG="{\"public_key\":\"$PK\",\"expires_in_s\":604800,\"memo\":\"Lumenia mainnet proof ($LABEL)\"}"
    echo "== lock $2 USDC behind link $LABEL (public key $PK); the secret stays in $KF (0600)"
    ARGS=$(python3 -c "import json,sys;print(json.dumps({'receiver_id':sys.argv[1],'amount':sys.argv[2],'msg':sys.argv[3]}))" "$CONTRACT" "$AMOUNT" "$MSG")
    "$NEAR" contract call-function as-transaction "$USDC" ft_transfer_call json-args "$ARGS" prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$DEPLOYER" network-config mainnet sign-with-legacy-keychain send
    "$NEAR" contract call-function as-read-only "$CONTRACT" get_drop json-args "{\"public_key\":\"$PK\"}" network-config mainnet now 2>&1 | grep -E '"status"|"amount"'
    ;;
  claim-named)
    LABEL=$2; NAME=$3; D="$LINKS/$LABEL"; KF=$(ls -t "$D"/link/*.json | head -1)
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
    LABEL=$2; TO=$3; D="$LINKS/$LABEL"; KF=$(ls -t "$D"/link/*.json | head -1); SK=$(keyfield "$KF" private_key)
    echo "== claim link $LABEL to the existing account $TO"
    "$NEAR" contract call-function as-transaction "$CONTRACT" claim json-args "{\"account_id\":\"$TO\"}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as "$CONTRACT" network-config mainnet sign-with-plaintext-private-key "$SK" send
    ;;
  intents-status)
    curl -sS -A "Mozilla/5.0 (lumenia-ops)" "https://1click.chaindefuser.com/v0/status?depositAddress=$2" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status'), json.dumps(d.get('swapDetails',{}))[:600])"
    ;;
  swap-usdc)
    AMT=$(python3 -c "import sys,decimal;print(int(decimal.Decimal(sys.argv[1])*10**24))" "$2")
    if ! "$NEAR" contract call-function as-read-only wrap.near storage_balance_of json-args "{\"account_id\":\"$DEPLOYER\"}" network-config mainnet now 2>&1 | grep -q '"total"'; then
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
    for i in $(seq 1 36); do
      ST=$(curl -sS -A "Mozilla/5.0 (lumenia-ops)" "https://1click.chaindefuser.com/v0/status?depositAddress=$DEP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status'))")
      echo "  status: $ST"; case "$ST" in SUCCESS|REFUNDED|FAILED) break;; esac; sleep 5
    done
    printf "USDC units now: "; "$NEAR" contract call-function as-read-only "$USDC" ft_balance_of json-args "{\"account_id\":\"$DEPLOYER\"}" network-config mainnet now 2>&1 | grep -E '^"'
    ;;
  send-rest)
    KEEP=$2; TO=$3
    SEND=$(curl -s -A "Mozilla/5.0" https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$DEPLOYER\"}}" | python3 -c "
import json,sys,decimal
a=int(json.load(sys.stdin)['result']['amount']); keep=int(decimal.Decimal(sys.argv[1])*10**24)
s=a-keep
print(s if s>0 else 0)" "$KEEP")
    if [ "$SEND" = "0" ]; then echo "nothing above $KEEP NEAR to send"; exit 0; fi
    echo "== send $SEND yoctoNEAR (everything above $KEEP NEAR) from $DEPLOYER to $TO"
    "$NEAR" tokens "$DEPLOYER" send-near "$TO" "$SEND yoctonear" network-config mainnet sign-with-legacy-keychain send
    ;;
  all)
    NAME=$2; TO=$3
    "$0" create && "$0" deploy && "$0" register && "$0" swap-usdc 1.5 \
      && "$0" link 2 proof-a && "$0" claim-named proof-a "$NAME" \
      && "$0" link 1 proof-b && "$0" claim-to proof-b "$TO" \
      && "$0" send-rest 0.3 "$TO" && "$0" status
    ;;
  *) echo "unknown step $STEP"; exit 2;;
esac
