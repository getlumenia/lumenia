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
src/lib/near-relay.ts     the NEAR rail's NEP-366 relayer (see "NEAR relayer" below)
src/test-near-relay.ts    139/139, no network
src/cli/            bootstrap · create-account · claim · makelink · provision-channels · reserve-report
src/test-antidrain.ts     60/60, no network
src/test-integration.ts   6/6 — happy claim / happy send / drain rejection / rate-limit (testnet)
src/spike*.ts             proof spikes (#1/#1b/#1c/#4/#5/#6/#7/#8/#9/#10 + LumenDrop v2)
```

Endpoints (Worker): `/health`, `/create-account`, `/feebump`, `/send-link`, `/sweep`, `/payout`,
`/faucet`, `/demo-link`, `/waitlist`, `/feedback`, `/events`, plus the v2 Soroban group
(`/v2-deposit` `/v2-claim` `/v2-reclaim`), the recovery group (`/recovery-otp` `/recovery`
`/recovery-fetch` `/recovery-check` `/recovery-release` `/recovery-alias-fetch`), the pilot
group (`/pilot-*`) and the NEAR rail (`/near/relay` `/near/health` `/near/policy`, the testnet
Worker only; see "NEAR relayer" below).

Two switches, unset by default (unset keeps the old behavior): `RECOVERY_REQUIRE_OWNER=1` on the
testnet Worker refuses an unsigned first backup, and `PILOT_REQUIRE_PROOF=1` on the mainnet Worker
refuses an unsigned ask to join real money. Set both once the website that signs both is live.

## Run

```bash
pnpm install                                       # at the repo root
pnpm --filter @lumenia/sponsor test:antidrain      # 60/60, no network
pnpm --filter @lumenia/sponsor test:integration    # 6/6, testnet (friendbot)
pnpm --filter @lumenia/sponsor dev                 # local server (needs .env — see .env.example)
# deploy: cd apps/sponsor && npx wrangler deploy   # Cloudflare Worker (the only host)
```

## NEAR relayer

Lumenia is one product; during NEAR HACKATHON 2026 NEAR became its second rail, on NEAR testnet. The
sponsor Worker carries that rail's relayer: a NEP-366 meta-transaction relayer that pays NEAR gas for
exactly two things and refuses everything else. Code: `src/lib/near-relay.ts` (the pipeline, the
caps, health) on top of the workspace package `@lumenia/near` (`/relayer/policy` is the allowlist,
`/relayer/client` is what the web app and the agent market use to build and send a delegate).

**In plain words.** A person who claimed a Lumenia link on NEAR owns a fresh account with USDC and
about 0.01 NEAR: enough to receive, not enough to pay gas. They sign a NEP-366 DelegateAction with
their own full-access key, this relayer checks it, wraps it in ONE transaction signed by
`lumenia-relayer.testnet` and pays the gas and the 1 yoctoNEAR the token contract demands. The
network checks the sender's signature again and runs the call AS the sender. The relayer never
holds a user key and never signs on a user's behalf: a dishonest relayer could at worst refuse.

### Policy (`GET /near/policy` says the same thing)

| | Allowed 1: create a link | Allowed 2: take an expired link back |
|---|---|---|
| Delegate `receiver_id` | `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` (Circle testnet USDC) | `lumenia-near.testnet` (the escrow) |
| Action | exactly one `FunctionCall` | exactly one `FunctionCall` |
| Method | `ft_transfer_call` | `reclaim` |
| Args | `receiver_id` must be `lumenia-near.testnet`; `amount` a positive integer string; `msg` a Lumenia link message (single key or `drops` batch, expiry 1 hour to 7 days); optional `memo` up to 256 bytes; no other fields | exactly `{"public_key":"ed25519:..."}` |
| Attached deposit | exactly 1 yoctoNEAR | exactly 0 |
| Gas | more than 0, at most 100 Tgas | more than 0, at most 100 Tgas |

For every delegate: valid NEAR account ids, `max_block_height` above the current height and at most
600 blocks ahead, the nonce inside the protocol bound, no nested delegate and no other action type,
and a signature that verifies against the delegate's own `public_key` (checked offline, first).
Before anything is sent, one RPC read confirms the sender owns that key, the nonce is fresh, and a
function-call key is not asked to carry a deposit. Everything else is refused with a reason and a
code (HTTP 403), and every decision is one JSON log line (`route: "near/relay"`) in `wrangler tail`.

### Caps

| Cap | Default | Variable |
|---|---|---|
| Relays per sender per UTC day | 20 | `NEAR_RELAY_PER_SENDER_PER_DAY` |
| Relays per UTC day in total | 500 | `NEAR_RELAY_PER_DAY` |
| Cooldown per sender | 10 s | `NEAR_RELAY_COOLDOWN_S` |

The caps live in the same Upstash store as every other counter of this service (keys
`near:testnet:...`), through the same 2 s deadline, and they **fail closed**: a store that is down or
slow refuses the relay with 503 `store_unavailable` rather than relaying unmetered. The record step
is atomic (SET NX for the cooldown, INCR for the day counters, a lost race given back), and it runs
only after the RPC pre-check, so a delegate naming a stranger's `sender_id` burns none of that
sender's allowance. The Worker's own limiter also applies, per IP and per signing key (its own
`near:` buckets). The in-process store serves only when no store is configured at all (local dev).

### Routes

- `POST /near/relay` with `{"signedDelegate":"<base64 of the borsh SignedDelegate>"}`:
  `200 {txHash, explorerUrl, outcome}` (`outcome.status` is `success` when the escrow opened the
  link or returned the USDC, `failure` with the escrow's receipt reason otherwise; the transaction
  still exists, and a refused `ft_transfer_call` is refunded by the token contract);
  `400 {reason, code}` not a relay request or not a canonical SignedDelegate;
  `403 {reason, code}` refused by the policy or the pre-check;
  `429 {reason, code, retryAfterS}` plus a `Retry-After` header for a cap or the limiter;
  `502 {reason, code}` the chain could not be reached or the send failed;
  `503 {"error":"near_not_configured", reason}` without the NEAR variables or the secret, and
  `503 {"error":"sponsor temporarily halted"}` under the kill switch (it is a value route).
- `GET /near/health`: `ok`, network, RPC URL, block height, the relayer account with its public key
  and live NEAR balance, escrow and USDC ids, storage mode (`upstash` or `memory`), today's caps,
  the policy in words, warnings, and the sponsor's halt verdict. 200 when `ok`, 503 otherwise
  (no key, a low balance, an RPC or store that did not answer). Cached per isolate for 5 s.
- `GET /near/policy`: the allowlist in words and as JSON.

### Environment

Testnet Worker vars (`wrangler.toml`, the default env): `NEAR_NETWORK=testnet`, `NEAR_RPC_URL`
(`https://test.rpc.fastnear.com`), `NEAR_ESCROW_ID` (`lumenia-near.testnet`), `NEAR_USDC_ID`,
`NEAR_RELAYER_ACCOUNT_ID` (`lumenia-relayer.testnet`), the three cap variables above and
`NEAR_RELAYER_MIN_NEAR` (default 1: the watchdog pages "NEAR relayer balance below the floor" under
it, and `/near/health` warns). The one SECRET is `NEAR_RELAYER_PRIVATE_KEY`, the relayer's
full-access key in near-api-js text form (`ed25519:<base58 of 64 bytes>`), set once with
`npx wrangler secret put NEAR_RELAYER_PRIVATE_KEY` from this folder (the default env is the
testnet Worker; it is never written to the repo or to a log).

**Mainnet is disabled on purpose.** `[env.mainnet]` carries none of the NEAR variables, so the
mainnet Worker answers `503 near_not_configured` on all three routes; the code also refuses the
routes off a Stellar-testnet environment and refuses `NEAR_NETWORK=mainnet` as "not configured".

### Live URLs (testnet Worker)

- https://lumenia-sponsor.avakit.workers.dev/near/health
- https://lumenia-sponsor.avakit.workers.dev/near/policy
- `POST https://lumenia-sponsor.avakit.workers.dev/near/relay`

### Run and test

```bash
pnpm --filter @lumenia/sponsor test:near-relay   # 139/139 offline: routes, policy, caps, halt, store down, watchdog page
# deploy (testnet Worker):  cd apps/sponsor && npx wrangler deploy
# the secret, once:         cd apps/sponsor && npx wrangler secret put NEAR_RELAYER_PRIVATE_KEY
```

The local node server (`src/index.ts`) does not serve the NEAR routes; they are Worker routes
(`wrangler dev` serves them, with `.dev.vars` holding the secret).

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
