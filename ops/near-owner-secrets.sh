#!/bin/bash
# Owner-run only. Puts the NEAR rail's testnet values where the deployments read them. Nothing is printed;
# values are read from the local key files under ~/.near-credentials. Safe to run more than once.
#   1. Vercel production env for apps/web: the shared demo sender (a throwaway testnet account whose key is
#      public ON PURPOSE so judges can try the send screen without a wallet; hence --type config), the
#      relayer base URL and the RPC.
#   2. Cloudflare secret on the TESTNET sponsor Worker: the relayer account's key (never the mainnet Worker).
# Usage:  bash ops/near-owner-secrets.sh
set -uo pipefail
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:/opt/homebrew/bin:$PATH"
DEMO_KEY_FILE="$HOME/.near-credentials/testnet/lumenia-demo.testnet.json"
RELAYER_KEY_FILE="$HOME/.near-credentials/testnet/lumenia-relayer.testnet.json"
key() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['private_key'],end='')" "$1"; }
V() { npx --yes vercel@latest "$@"; }
setenv() { # name value type(config|plain)
  V env rm "$1" production --yes >/dev/null 2>&1 || true
  if [ "$3" = "config" ]; then printf '%s' "$2" | V env add "$1" --environment production --type config
  else printf '%s' "$2" | V env add "$1" --environment production; fi
}

echo "== Vercel production env (apps/web)"
cd "$(dirname "$0")/../apps/web"
setenv NEXT_PUBLIC_NEAR_DEMO_FUNDER_ID "lumenia-demo.testnet" plain
setenv NEXT_PUBLIC_NEAR_DEMO_FUNDER_KEY "$(key "$DEMO_KEY_FILE")" config
setenv NEXT_PUBLIC_NEAR_RELAYER_URL "https://lumenia-sponsor.avakit.workers.dev/near" plain
setenv NEXT_PUBLIC_NEAR_RPC "https://test.rpc.fastnear.com" plain
V env ls production 2>/dev/null | grep NEAR || true

echo "== Cloudflare secret on the TESTNET sponsor Worker (lumenia-sponsor)"
cd ../sponsor
key "$RELAYER_KEY_FILE" | npx --yes wrangler@4 secret put NEAR_RELAYER_PRIVATE_KEY
npx --yes wrangler@4 secret list 2>/dev/null | grep -o '"name": "[A-Z_]*"' || true
echo "done: the web picks these up at the next push to main; the testnet Worker at the next 'npx wrangler deploy' in apps/sponsor"
