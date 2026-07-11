# @lumenia/sponsor

Lumenia's sponsor service: sponsored account creation + fee-bump (the recipient holds 0 XLM).
It holds a hot Ed25519 signing key (testnet scope; a KMS raw-signer drops in behind
`src/lib/signer.ts` later — mechanically proven by Spike #1b) and gates every fee-bump
with the anti-drain allowlist.

**Live (testnet):** https://lumenia-sponsor.vercel.app — `GET /health`,
`POST /create-account`, `POST /feebump`. Evidence: [../../EVIDENCE.md](../../EVIDENCE.md).

## Layout

```
src/index.ts        node:http server (local dev + integration-test child)
src/lib/            config · signer · stellar · service · create-account · feebump ·
                    anti-drain (the D3 validator) · rate-limit (durable KV/Upstash + in-memory fallback)
src/vercel/         function sources → bundled to api/*.js by build-vercel.mjs
src/cli/            bootstrap · create-account · claim · makelink
src/test-antidrain.ts     18/18, no network
src/test-integration.ts   5/5 — happy claim / drain rejection / rate-limit (testnet)
src/spike*.ts             the pre-sprint proof spikes (#1, #1b, #1c, #4)
```

## Run

```bash
pnpm install                                       # at the repo root
pnpm --filter @lumenia/sponsor test:antidrain      # 18/18, no network
pnpm --filter @lumenia/sponsor test:integration    # 5/5, testnet (friendbot)
pnpm --filter @lumenia/sponsor dev                 # local server (needs .env — see .env.example)
# deploy: node build-vercel.mjs && vercel deploy --prod --yes
```

## ⚠️ stellar-sdk@16 module-system gotchas (hard-won)

- This package is **ESM** (`"type":"module"`, explicit `.js` extensions on relative
  imports); `tsx` runs everything fine. An earlier note said "run as CJS" — that is
  obsolete.
- What still breaks is **plain Node-ESM on Vercel** (the `@stellar/js-xdr` `config`
  export). The deployed functions are therefore an **esbuild self-contained CJS
  bundle** (`build-vercel.mjs` → `api/*.js` + `api/package.json {type:commonjs}`).
  Don't deploy raw `.ts`/ESM function files.
- Vercel uploads only this directory → no `workspace:*` imports in deployed code;
  the anti-drain validator lives here (`src/lib/anti-drain.ts`), not in
  `packages/shared`, so the tests and the deployed bundle share one module.
