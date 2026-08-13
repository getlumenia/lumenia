# Instawards Evidence Package — Lumenia (30-day testnet sprint)

> Reviewer-facing evidence for the SOW deliverables ([INSTAWARDS_SOW.md](INSTAWARDS_SOW.md)).
> Everything below is on the **public Stellar testnet** — no real money. Each claim is
> independently verifiable: click the explorer links or re-run the commands.

## The binary success metric — MET

> *"At least one verifiable end-to-end testnet claim: a link tap that lands USDC in a
> freshly sponsored 0-XLM account, evidenced by a public on-chain tx hash."*

**Tx hash:** `b9ef1844c6ca2df732648b965a2f991ba0197643057b2c9e2a60ab52c3e23746`
**Explorer:** <https://stellar.expert/explorer/testnet/tx/b9ef1844c6ca2df732648b965a2f991ba0197643057b2c9e2a60ab52c3e23746>

What the explorer shows: a **fee-bump transaction** whose fee account is the sponsor
(`GDQFGINJ4PMEX4GN53OHFFO657P5APN5BYEEDKRTNYC74FXUBCQTXDLL`) wrapping a
`claimClaimableBalance` sourced by the recipient
(`GCI5ZR6B2TQJDN7VX4TBZAU4J5RBRCKLWYALJEIMPNOM7CTK6AP5PPIR`). The claim was made
from a **real browser** on the live claim page: **20 USDC landed while the recipient
held 0 XLM throughout and paid no fee** — no wallet, no seed phrase, no setup.

**Still true on the current live path.** The sponsor has since moved to a single
Cloudflare Worker (see D1) and the anti-drain validator has been hardened (see D3). A
fresh end-to-end claim through that current path re-proves the same metric:
tx `21816364fbe2460ac58c2fcf54dfdf24b71f71ad3344f7358dad12d2aa772203`
(<https://stellar.expert/explorer/testnet/tx/21816364fbe2460ac58c2fcf54dfdf24b71f71ad3344f7358dad12d2aa772203>)
— again **20 USDC into a freshly sponsored 0-XLM account**. The original `b9ef1844…`
capture remains valid evidence; this newer one shows the metric holds on today's stack.

---

## D1 — Live sponsor service (testnet)

| Evidence | Where |
|---|---|
| Live service | <https://lumenia-sponsor.avakit.workers.dev/health> (returns network + sponsor public key) — a single **Cloudflare Worker** (`apps/sponsor/src/worker.ts`), deployed with `cd apps/sponsor && npx wrangler deploy`. (It replaced the earlier Vercel serverless deployment, which capped a project at 12 functions; the Worker has no function limit.) |
| Endpoints | Core claim path: `POST /create-account` (sponsored 0-XLM account + USDC trustline), `POST /feebump` (anti-drain gate → fee cap → fee-bump → submit). Full surface: `/health`, `/create-account`, `/feebump`, `/send-link`, `/sweep`, `/faucet`, `/demo-link`, `/waitlist`, `/feedback`, `/events`, `/v2-deposit`, `/v2-claim`, `/v2-reclaim`, `/recovery-otp`, `/recovery`, `/recovery-fetch`. The `/v2-*` and `/recovery-*` endpoints are post-SOW (see "Beyond the SOW" below); none of them widens the claim path. |
| Sponsored account creation via the live service | tx `43ceea89b034fc6484206348b8ab44fafa4a1349101a63a441cb064a0ace0aa8` — <https://stellar.expert/explorer/testnet/tx/43ceea89b034fc6484206348b8ab44fafa4a1349101a63a441cb064a0ace0aa8> — the 4-op sponsored sandwich (beginSponsoring → createAccount(0) → changeTrust → endSponsoring), source **and** fee account = the sponsor `/health` reports; it onboarded the recipient of the binary-metric claim 5 seconds later. (An earlier W1 CLI run, tx `cc8e690f…8320`, used a previous testnet sponsor key that was rotated — testnet keys are disposable.) |
| Signer | Env hot-key (testnet scope per SOW); external raw-Ed25519/KMS signing proven separately (Spike #1b, [PROGRESS.md §4c](PROGRESS.md)) |
| Fee cap | `FEE_BUMP_MAX_STROOPS` enforced in [`apps/sponsor/src/lib/feebump.ts`](apps/sponsor/src/lib/feebump.ts) |
| Rate limiting | Per-IP + per-account on both POST endpoints ([`apps/sponsor/src/lib/rate-limit.ts`](apps/sponsor/src/lib/rate-limit.ts)), **durable across instances** (Upstash Redis fixed-window; in-memory fallback). Proven live 2026-07-11: 12 concurrent `/create-account` for one account → 5×200 (cap) + 7×429 |
| Public repo | <https://github.com/getlumenia/lumenia> |

## D2 — End-to-end walletless claim (testnet)

| Evidence | Where |
|---|---|
| On-chain claim | tx `b9ef1844…` above (the binary metric), re-proven on today's stack by `21816364…` |
| Live claim page | <https://getlumenia.com> — value-first: the amount is shown **before** any credential or action; the bearer key travels in the URL `#fragment` and is never sent to a server |
| 60-second demo video | <https://youtu.be/eGqJDv0C0mk> — a phone opening the claim link on the live page, USDC arriving with no wallet, no setup and no gas (the SOW-scoped **testnet** v1 flow) |
| Flow | link tap → value-first page → "Claim my money" → `/create-account` → client-signed claim → `/feebump` → on-screen explorer tx link |
| SOW-scoped route | This D2 claim is the **v1 classic Claimable Balance** route (`/c/[id]`) — the frozen grant-evidence path (webfont-free, unchanged mechanics). Since the sprint, the app's **default shareable link-send** is a v2 Soroban escrow with a separate claim route (`/v2/c/[…]`, see "Beyond the SOW"); both run side by side, and this SOW is evidenced entirely on the v1 route. |

## D3 — Anti-drain protection, wired and tested

| Evidence | Where |
|---|---|
| Validator gating every live `/feebump` | [`apps/sponsor/src/lib/anti-drain.ts`](apps/sponsor/src/lib/anti-drain.ts) — allowlist over op **types, sources and parameters**, strict-by-default (a missing constraint rejects) |
| Unit tests | **60/60** — `pnpm --filter @lumenia/sponsor test:antidrain` (no network; the same module the deployed Worker uses). Breakdown: **18 claim + 7 send + 12 sweep + 12 payout + 4 op-sequence + 4 golden-policy + 3 muxed-address**. The SOW cited 14/14; the suite grew to 60/60 (see the growth note below) — re-running today prints 60/60 |
| Integration tests | **6/6** — `pnpm --filter @lumenia/sponsor test:integration` (real HTTP: happy claim lands 20 USDC at 0 XLM, a 0-XLM onward send creates a sponsored CB, a malicious payment is rejected 400, a burst 429s) |
| Live drain rejection (deployed service) | A sponsor-sourced `payment` inner tx POSTed to the **production** `/feebump` returns `400 {"error":"anti-drain rejected the inner tx: op 'payment' sourced from sponsor (drain attempt)"}` (2026-07-11) |
| Plain-language write-up | [ANTI_DRAIN.md](ANTI_DRAIN.md) |

> **Why the count differs from the SOW.** The SOW (§4.1, written 2026-06-18) cites **14/14**. The suite has
> since grown to **60/60**: sprint hardening added strict-by-default fail-closed cases + more drain vectors
> (14 → 18); the post-SOW onward-send feature added a **separate, tight `/send-link` policy** (18 → 25); the
> recovery-consolidation **sweep policy** added 12 (25 → 37); an op-**sequence** matcher + a
> **golden-policy** snapshot added 7 (37 → 44); a **`/payout` policy** (the user sends their own dollars to
> an address they name) plus its golden-allowlist case added 13 (44 → 57); and three **muxed-address
> (M…) rejection** cases, added 2026-08-08, closed the muxed-source bypass class (57 → 60). The claim
> allowlist was never widened — the count went up because coverage went up, and no SOW-era test was
> removed or weakened. (The captures referenced below are historical: a 44/44 run from 2026-07-22 and the
> SOW-era 25/25 capture at `evidence/tests-25-25-and-6-6.png`; re-running today prints 60/60.)

### Test output (2026-07-22 capture — the suite has since grown to 60/60)

![44/44 anti-drain + 6/6 integration tests passing](evidence/tests-44-44-and-6-6.png)

Verbatim (as captured then — the anti-drain line now prints 60/60):

```
 ✅ ANTI-DRAIN TESTS PASS (44/44)
```

```
=== bootstrap sponsor + issuer (friendbot) ===
=== start sponsor service (child) — per-account cap = 3 ===

[1] happy claim: create CB → /create-account → claim → /feebump
  ✔ create-account → 200
  ✔ feebump → 200 + tx hash
  ✔ USDC landed (20) + 0 XLM held

[1b] happy send: the 0-XLM claimer sends $7 onward → /send-link → CB created
  ✔ send-link → 200 + balanceId (0-XLM sender, sponsor-reserved CB)

[2] drain rejection: a malicious payment inner tx → anti-drain 400
  ✔ feebump rejects the drain (400 + anti-drain reason)

[3] rate limit: 6 rapid /create-account for one account (cap 3) → 429
  ✔ burst is rate-limited (a 429 appears)

 ✅ INTEGRATION TESTS PASS (6/6)
```

---

## Deviations from the SOW as written

The SOW was written on 2026-06-18, before the service was deployed. Three of its
implementation details did not survive contact with the deployment target. Each is a
deliberate engineering decision, not a shortcut — the **deliverable and its intent are
unchanged in every case**. They are listed here so a reviewer does not have to find
them by reading the diff.

**1. The validator is not imported from `@lumenia/shared`.**
*SOW D1:* "Imports the validator from the built `@lumenia/shared` package."
*Built:* the validator lives at [`apps/sponsor/src/lib/anti-drain.ts`](apps/sponsor/src/lib/anti-drain.ts).
*Why:* Vercel uploads only the linked project directory, so a `workspace:*` import fails
the build — npm cannot resolve the protocol on a standalone upload. The validator moved
into the sponsor, where it also belongs conceptually: the web builds the inner tx, only
the sponsor validates it.
*Intent preserved:* there is still exactly **one** canonical validator module and no
duplicate anywhere in the repo. `test-antidrain.ts` imports the same file that esbuild
inlines into the deployed function, so the tests still exercise the deployed gate — which
is what the SOW clause was protecting against.

**2. The sponsor runs ESM, not CJS; the ESM↔CJS parity test became an XDR wire-parity test.**
*SOW D1 / Week 1:* "Node sponsor service (CJS)… with a test proving web(ESM) ↔ sponsor(CJS) parity."
*Built:* `apps/sponsor` is `"type": "module"`; the **deployed artifact** is a self-contained
CJS bundle produced by esbuild (`build-vercel.mjs` → `api/*.js`).
*Why:* plain Node-ESM on Vercel fails on the `@stellar/stellar-sdk` → `@stellar/js-xdr`
`config` export interop. Bundling resolves every module at build time, so the deployed
function does no runtime resolution. This is the only configuration that deploys cleanly.
*Intent preserved:* the risk that clause targeted was **"does the transaction survive the
web→sponsor boundary intact?"** — a module-system concern only because the boundary was
assumed to be one. That risk is proven directly instead, at the level that actually
matters: **Spike #1c** asserts the inner tx re-parses from base64 XDR **byte-identically**
(`reparsed.hash() === original.hash()`), that the canonical validator accepts the re-parsed
tx, and that a fee-bump around it is network-accepted. The live browser claim (`b9ef1844…`)
then proved the same boundary end-to-end in production.

**3. `/feebump` has no explicit polling loop.**
*SOW D1:* "…submits, and polls until the transaction confirms SUCCESS/FAILED before responding."
*Built:* the endpoint awaits Horizon's synchronous `submitTransaction`
([`apps/sponsor/src/lib/stellar.ts`](apps/sponsor/src/lib/stellar.ts)), which returns only
once the transaction has been included in a ledger, or throws with Horizon's `extras`.
*Intent preserved:* the observable behaviour the clause specifies holds exactly — the
response reflects a final outcome and never a pending state. Only the mechanism differs
(Horizon blocks; we do not poll it ourselves).

**4. The test count grew: 14/14 → 60/60.** See the note under D3 above.

> **Note on the host.** Deviations 1–2 were written when the sponsor deployed to Vercel.
> It has since moved to a single **Cloudflare Worker** (`apps/sponsor/src/worker.ts`,
> `wrangler deploy`) because recovery pushed the endpoint count past Vercel's 12-function
> Hobby cap. The reasoning above is now historical, but the outcomes it protected still
> hold: there is still exactly **one** canonical validator module, and Spike #1c's XDR
> wire-parity proof (the inner tx re-parses byte-identically across the web→sponsor
> boundary) is independent of the runtime host.

## Beyond the SOW (shipped since)

The repository has continued past the sprint, so a reviewer will find code that this SOW
does not cover and does not claim as evidence. All of it is **testnet** and **none of it
touches the frozen v1 claim path** (`/c/[id]`) evidenced above. Listed here so a reviewer
sees the current shape of the repo, not to expand the SOW's claims:

- **v2 Soroban `LumenDrop` escrow** (testnet) — the app's **default shareable link-send** is
  now a smart-contract drop with a **late-bound payout**: the link key does not hold the
  money, it authorizes a payout to an address chosen at claim time, verified inside the
  contract, so the relayer can never redirect a stroop. The relayer pays the Soroban fee,
  so the flow stays walletless and the recipient still pays no gas. Proven on-chain (7/7)
  plus native unit and property tests; a separate v2 claim route
  (`/v2/c/[…]`). Hardened and re-proven on 2026-07-25 — see the section below. Mainnet is
  gated on an audit.
- **Account recovery** (`lib/recovery.ts`, `/account`) — password + email-OTP recovery of
  the on-device seed, plus a WebAuthn-PRF "Face ID" fast-unlock upgrade. One 32-byte seed,
  two wraps (Argon2id → AES-GCM as the floor; PRF → HKDF → AES-GCM as the upgrade), stored
  as a **ciphertext-only, zero-knowledge box the server cannot open** (OTP-gated, isolated
  store, separate rate-limit bucket). Recovery self-test 18/18. Owner-gated while the OTP
  email domain is being verified; there is still **no seed-export** path.
- **Channel-account concurrency** (`lib/channels.ts`) — a pool of sponsor-controlled channel
  accounts, each lending a transaction sequence under an exclusive Upstash Redis lease,
  removes the single-sequence bottleneck. Proven 20/20 concurrent with 0 `tx_bad_seq`.
- **Recover / reclaim ("Take it back")** — a sender can reclaim an abandoned drop without paying gas (the sponsor fee-bumps)
  for both the classic (v1, via `/feebump`) and Soroban (v2, via `/v2-reclaim`) paths,
  surfaced as reclaimable notices in the app.
- **Onward send** (`/send-link`, `/send`) — a recipient who claimed can send a link of their
  own, gated by a **separate** anti-drain policy that never widens the claim allowlist
  (Spike #5, 7/7). **Request money** (`/request`, `/r/[id]`) — create a link asking someone
  to pay you; the payer pushes the payment, no pull/debit (Spike #6, 8/8). **Split** across
  N request links (`/split`).
- **Local key encryption** (`lib/argon.ts`, `lib/keystore.ts`, `/unlock`) — Argon2id-derived
  AES-GCM encryption of the seed in IndexedDB, at rest on-device.
- **Support endpoints** (`/faucet`, `/demo-link`, `/waitlist`, `/feedback`, `/events`) and
  the product web app in the "Periwinkle" design system.

The SOW deliverables above (D1/D2/D3) are evidenced on their own terms and do not depend
on any of this.

## v2 escrow hardening + proof re-runs (2026-07-25)

Also outside the SOW, and listed here only because the numbers below are re-runnable. A
pre-mainnet hardening pass landed on the v2 Soroban escrow (`contracts/lumen-drop`):
**a static-analysis, property-test, fuzz and mutation-testing pass is complete; a
professional audit is pending.** Free tooling is not an audit and is not described as one.
Contract details: [contracts/lumen-drop/README.md](contracts/lumen-drop/README.md) ·
posture: [SECURITY.md](SECURITY.md).

### The deployed artifact (testnet)

| Item | Value |
|---|---|
| Contract id | `CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S` — <https://stellar.expert/explorer/testnet/contract/CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S> |
| Pinned USDC SAC | `CDUL6GQBQKJYG26YZDJHTZF7G73EKUAWA3LTPK7LXODHPCUPK5AU76KF` |
| wasm sha256 | `38941538b964af2110a6fd2fae4c1c3de2ff6585ef0da5d1a59de2ce29edec6a` (21,323 bytes) |
| Build | `stellar contract build` — stellar CLI 25.2.0, rustc 1.96.0, target `wasm32v1-none`; soroban-sdk 26.1, OpenZeppelin Stellar contracts 0.7.2; `contractmeta binver = "0.2.0"` |
| Supersedes | `CDYEDHBPMDOOZSJGB2Z6JVK7GS3S5CWNXNGTEPMJFS25TAWSYHTXA2RF` (the original) and `CAKEJAGCATVMJB6CMB6LM736DHUJ37YOTOER23SWRNDHPLTU2ZJUDIAB` (an interim hardened build) |
| Live wiring | The deployed sponsor Worker points at **this** contract for all new escrow. Because a drop can only ever be released by the contract holding it, both the Worker and the web app also **read and exit** drops still held by the superseded ids (`LUMENDROP_LEGACY_CONTRACTS`), so claim links already sent keep working. Deposits only ever enter the current contract. Proven 9/9 on testnet (below). |

### Proof runs against the new contract

| Proof | Result | How to re-run |
|---|---|---|
| Escrow, on-chain (deposit → late-bound claim → relayer cannot redirect) | **7/7** real testnet txs | `USDC_ISSUER_SECRET=S… pnpm --filter @lumenia/sponsor exec tsx src/lumendrop-onchain-proof.ts` |
| Relayer handler (the same code the deployed `/v2-claim` runs) | **5/5** real testnet txs | `SPONSOR_SECRET=S… USDC_ISSUER_SECRET=S… pnpm --filter @lumenia/sponsor exec tsx src/lumendrop-relay-test.ts` |
| **Governance, on-chain (new)** | **10/10** real testnet txs | `USDC_ISSUER_SECRET=S… OWNER_SECRET=S… LUMENDROP_CONTRACT=C… WASM_HASH=… pnpm --filter @lumenia/sponsor exec tsx src/lumendrop-governance-proof.ts` |
| Anti-drain validator | **60/60** (offline) | `pnpm --filter @lumenia/sponsor test:antidrain` |
| Sponsor integration (real HTTP) | **6/6** (testnet) | `pnpm --filter @lumenia/sponsor test:integration` |
| KMS Ed25519 signer (offline; byte-parity with the SDK's own signing) | **13/13** | `pnpm --filter @lumenia/sponsor test:kms` |
| **Canary caps (new)** — per-drop + rolling-UTC-day escrow ceiling on both escrow-creating paths | **31/31** (offline) | `pnpm --filter @lumenia/sponsor test:caps` |
| **Legacy-contract fallback (new)** — claim/reclaim a drop held by a superseded contract | **9/9** real testnet txs | `SPONSOR_SECRET=S… USDC_ISSUER_SECRET=S… pnpm --filter @lumenia/sponsor test:legacy` |
| **Watchdog (new)** — cron tripwire smoke test | **3/3** (testnet) | `pnpm --filter @lumenia/sponsor test:watchdog` |

**What the caps proof establishes.** The cap is read from the **transaction XDR** — the Claimable
Balance amount for v1, `deposit`'s second argument for v2 — so it bounds what the ledger will
actually execute, not a client-supplied field. The per-drop cap is enforced locally with no network
call, so a store outage cannot disable it; the per-day total is an **atomic `INCRBY` reserve-then-check**
in the same Upstash store as the rate limiter, so concurrent requests cannot slip through a
read-then-write gap. A rejected request does not consume the day's budget and a failed transaction
releases its reservation. The 31 cases cover boundaries, UTC-day rollover, reserve/release, both
store-outage behaviours (default **fail open**, `CAPS_FAIL_CLOSED=1` **fail closed**) and a malformed
env value falling back to the default rather than to unlimited. Testnet values: `MAX_DROP_USDC=100`,
`MAX_DAY_USDC=1000`.

**What the legacy-fallback proof establishes**, with real transactions: a drop escrowed in the
**superseded** contract claims through the relayer; a drop in the **current** contract claims with no
`contract` argument at all; a **foreign** contract id is rejected before any network spend; and a
`/v2-deposit` aimed at a superseded contract is rejected ("wrong contract") — new escrow only ever
enters the current contract. On the web side the resolution has to happen *first*, because the signed
claim message binds the contract address: reading a drop from the wrong contract would produce a
signature the escrow rejects.

**What the watchdog verification establishes.** Beyond the 3/3 smoke test, **both tripwires were fired
against real testnet transactions**: a live `pause` on the escrow produced a page naming the
transaction hash (the contract was then unpaused and `paused` reads false again), and a deliberately
wrong pinned wasm hash produced the wasm-changed page.

What the **governance** proof establishes on-chain: a **non-owner can neither pause nor
upgrade**; pausing **blocks new deposits while a claim of an already-escrowed drop still
succeeds** (escrowed funds can always exit); and an **owner upgrade leaves a pre-upgrade drop
claimable** (versioned storage survives). The owner has **no path that moves escrowed funds**.

### Contract test + tooling numbers (re-runnable in `contracts/lumen-drop`)

| Check | Result | Command |
|---|---|---|
| Unit + invariant property tests | **29** (11 before the pass), over a written **14-invariant** spec | `cargo test` |
| Mutation testing | 58 mutants — **51 caught**, 1 missed (a deliberately redundant defense-in-depth guard, documented in the source), 6 unviable | `PROPTEST_CASES=16 cargo mutants -f src/lib.rs` |
| Coverage | **99.16%** lines overall (95.2% on the contract library) | `cargo llvm-cov --summary-only` |
| CoinFabrik Scout | **0 findings** (was 2 Critical + 1 Medium) | `cargo scout-audit` |
| Strict clippy · cargo-deny · cargo-geiger | 0 warnings · ok · **0 `unsafe`** in the contract crate | `cargo clippy --all-targets -- -D warnings …` · `cargo deny check` |
| cargo-audit | clean apart from one unmaintained-crate advisory (`paste`, transitive); cargo-vet baseline established | `cargo audit` |
| Fuzzing | a solvency target that runs in CI on Linux (it cannot link on macOS); the same invariant also runs as a property test everywhere | `cargo +nightly fuzz run escrow_solvency` |

CI runs the fast checks (strict clippy, contract tests, `cargo-audit`, `cargo-deny`, a **90%
line-coverage gate**) on every push; Scout, OpenZeppelin's `soroban-scanner`, fuzzing and
mutation testing run on a weekly workflow.

### Alongside (honest status)

- **AWS-KMS Ed25519 signer** — code-complete behind the existing signer interface, **13/13**
  offline tests. **Live AWS provisioning has not happened**: the deployed service still uses an
  environment key.
- **Kill-switch** — can halt every value-moving endpoint.
- **Canary caps** (`apps/sponsor/src/lib/caps.ts`) — a per-drop and a rolling-UTC-day ceiling on the
  escrow the sponsor will facilitate, live on both escrow-creating paths (`/send-link`, `/v2-deposit`).
  Testnet values are 100 / 1000 USDC; mainnet should start at 20 / 500 with `CAPS_FAIL_CLOSED=1`.
- **Watchdog** (`apps/sponsor/src/lib/watchdog.ts`) — a **Cloudflare Cron Trigger every 15 minutes** on
  the Worker that is already running, because OpenZeppelin Monitor needs a separate always-on host we do
  not operate. It checks sponsor float (`SPONSOR_MIN_XLM`, default 50), any `payment` /
  `path_payment_*` / `account_merge` / offer **sourced by the sponsor** (the sponsor only creates
  accounts and pays fees, so one of those is the signature of a stolen key), and escrow governance —
  pause/unpause/ownership events **plus the deployed wasm hash**, since an `upgrade` emits **no event**
  at all and event-watching alone would miss the most serious possible action. The expected hash is
  pinned in `LUMENDROP_WASM_HASH` and must be updated on every intentional upgrade. Alerts go to
  `wrangler tail`, plus email when `RESEND_API_KEY` + `ALERT_NOTIFY_TO` are set.
- **OpenZeppelin Monitor configs** remain in `ops/monitor/` as a documented, **not-deployed** richer
  alternative. A key-custody runbook exists (`ops/RUNBOOK_SPONSOR_KEY.md`).
- **Next.js bumped to 16.2.11**, closing 4 high and 6 moderate advisories (including a middleware
  bypass and SSRF in Server Actions); the dependency audit is now clean.

## Out of scope (per SOW §4.1)

What the SOW deferred: Mainnet/real money, live fiat conversion (delegated to a licensed
provider — the claim page ships a disabled **placeholder** only), account recovery/passkeys,
request-money, WhatsApp automation, production KMS/HSM, DB/SEP-7, abuse-at-scale handling.

Since the sprint, several of these have shipped on **testnet** (account recovery + Face ID,
request-money — see "Beyond the SOW" above). Still genuinely out: mainnet/real money, live
fiat conversion, production KMS/HSM, WhatsApp automation, and abuse-at-scale handling.

## Re-run everything

```bash
git clone https://github.com/getlumenia/lumenia && cd lumenia
pnpm install
pnpm --filter @lumenia/sponsor test:antidrain     # 60/60, no network
pnpm --filter @lumenia/sponsor test:integration   # 6/6, testnet (friendbot; can be slow if friendbot rate-limits)
pnpm --filter @lumenia/sponsor test:kms           # 13/13 KMS signer tests, no network, no AWS
pnpm --filter @lumenia/sponsor test:caps          # 31/31 canary caps, no network
pnpm --filter @lumenia/sponsor test:legacy        # 9/9 legacy-contract fallback, testnet (needs SPONSOR_SECRET + USDC_ISSUER_SECRET)
pnpm --filter @lumenia/sponsor test:watchdog      # 3/3 watchdog smoke test, testnet
curl https://lumenia-sponsor.avakit.workers.dev/health   # live service (Cloudflare Worker)

# the v2 escrow contract (Rust; see contracts/lumen-drop/README.md)
cd contracts/lumen-drop && cargo test            # 29 unit + invariant property tests

# deploy the sponsor (Cloudflare Worker):
cd apps/sponsor && npx wrangler deploy
```
