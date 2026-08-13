# @lumenia/sponsor

Lumenia's sponsor service: sponsored account creation + fee-bump (the recipient holds 0 XLM).
It holds a hot Ed25519 signing key (testnet scope; a KMS raw-signer drops in behind
`src/lib/signer.ts` later — mechanically proven by Spike #1b) and gates every fee-bump
with the anti-drain allowlist.

**Live (testnet):** a single Cloudflare Worker at https://lumenia-sponsor.avakit.workers.dev —
`GET /health` plus the POST endpoints below. Deploy = `cd apps/sponsor && npx wrangler deploy`.
(The old Vercel host and its esbuild `api/*.js` bundle have been deleted — the Worker is the
only host.) Evidence: [../../EVIDENCE.md](../../EVIDENCE.md).

## Layout

```
src/worker.ts       Cloudflare Worker entry (the LIVE host — all endpoints, node:http → fetch)
src/index.ts        node:http server (local dev + integration-test child)
src/lib/            config · signer · stellar · service · create-account · feebump · send · sweep ·
                    channels (concurrency lease) · soroban-relay (v2) · recovery-otp/-store ·
                    anti-drain (the D3 validator) · rate-limit (durable Upstash KV + in-memory fallback)
src/cli/            bootstrap · create-account · claim · makelink · provision-channels · reserve-report
src/test-antidrain.ts     60/60, no network
src/test-integration.ts   6/6 — happy claim / happy send / drain rejection / rate-limit (testnet)
src/spike*.ts             proof spikes (#1/#1b/#1c/#4/#5/#6/#7/#8/#9/#10 + LumenDrop v2)
```

Endpoints (Worker): `/health`, `/create-account`, `/feebump`, `/send-link`, `/sweep`, `/payout`,
`/faucet`, `/demo-link`, `/waitlist`, `/feedback`, `/events`, plus the v2 Soroban group
(`/v2-deposit` `/v2-claim` `/v2-reclaim`), the recovery group (`/recovery-otp` `/recovery`
`/recovery-fetch` `/recovery-alias-fetch`) and the pilot group (`/pilot-*`).

## Run

```bash
pnpm install                                       # at the repo root
pnpm --filter @lumenia/sponsor test:antidrain      # 60/60, no network
pnpm --filter @lumenia/sponsor test:integration    # 6/6, testnet (friendbot)
pnpm --filter @lumenia/sponsor dev                 # local server (needs .env — see .env.example)
# deploy: cd apps/sponsor && npx wrangler deploy   # Cloudflare Worker (the only host)
```

## ⚠️ stellar-sdk@16 module-system gotchas (hard-won)

- This package is **ESM** (`"type":"module"`, explicit `.js` extensions on relative
  imports); `tsx` runs everything fine. An earlier note said "run as CJS" — that is
  obsolete.
- The **live host is a single Cloudflare Worker** (`src/worker.ts`, `nodejs_compat`) — the
  sponsor is one service, and Vercel Hobby caps a deployment at 12 functions (recovery pushed
  it to 15). `@stellar/stellar-sdk@16` runs on `workerd`+`nodejs_compat` (proven).
- The **Vercel fallback is gone**: `src/vercel/`, `build-vercel.mjs` and the generated
  `api/*.js` were deleted once the Worker was proven as the sole host. (Historical context,
  in case the pattern resurfaces: plain Node-ESM on Vercel broke on the `@stellar/js-xdr`
  `config` export, so those functions shipped as an esbuild self-contained CJS bundle.)
- The anti-drain validator lives here (`src/lib/anti-drain.ts`), not in `packages/shared` —
  originally forced by Vercel's standalone upload (npm can't resolve `workspace:*` there),
  kept because the sponsor is where validation belongs; the tests and the deployed Worker
  share one module.
