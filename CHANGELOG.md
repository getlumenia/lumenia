# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/).

> **Where it runs.** Most of the product runs on the Stellar **test network**, where
> balances are free test USDC. Since 2026-07-26 a hand-approved, capped **mainnet pilot**
> has moved real Circle USDC ($5 a link, up to $25 a day from one sender and $50 a day
> across the pilot); see [SECURITY.md](SECURITY.md). The tagged releases below (0.1.0 to
> 0.2.1) were testnet only. Amounts and metrics reflect testing and a small pilot, not
> economic volume.

## [Unreleased]

Everything since 0.2.1; nothing has been tagged since. The Instawards follow-on (SOW 2,
2026-09-17 to 2026-10-16) is grouped by deliverable and dated, newest first. Its evidence,
metric by metric, is in [EVIDENCE.md](EVIDENCE.md).

### SOW 2, D3: open-mainnet readiness (deployed to both Workers on 2026-10-08)

#### Added

- **A per-day sponsor fee budget** on every route the sponsor signs (`MAX_DAY_FEE_XLM`,
  15 XLM on mainnet). A bid counts before the signature; a transaction that never reached a
  ledger gives it back, an included one counts the fee the ledger charged.
- **A per-sender day cap** (`MAX_DAY_USDC_PER_SENDER`, 25 USDC of the mainnet day's 50),
  reserved and released with the day counter.
- **Server-side simulation and fee bounds on the Soroban relays.** A deposit is simulated
  before the caps, the fee budget and the signature, and refused above what the simulation
  needs plus a fixed margin; a take-back carries the same bound.
- **The watchdog's heartbeat and automatic halt.** Each run stamps `/health`; a GitHub
  workflow (`watchdog-heartbeat.yml`) reads both Workers every 30 minutes and opens an issue
  on a stale stamp; the sponsor halts itself on the watchdog's two theft tripwires (a
  sponsor-sourced forbidden operation, a changed escrow wasm).
- **The allowlist's retirement behind one variable** (`PILOT_MODE`): unset, `/pilot-status`
  answers "open" and every cap stays. Rehearsed on a local Worker against the testnet ledger
  (`pnpm --filter @lumenia/sponsor rehearse`).
- **A scripted adversarial runner** (`pnpm --filter @lumenia/sponsor adversarial`): full mode
  on testnet or a local Worker, refusal-only against a live mainnet Worker, with a stand-in
  store for the store-dependent probes (`fake-kv`).
- **The sponsor account configured apart from its signer** (`SPONSOR_ACCOUNT_ID`), so the KMS
  cutover adds the KMS key to the existing account with one SetOptions (`kms-check`,
  `add-signer`). The cutover itself has not happened yet.
- **CI step "Hardening suite (D3 a-k)"**, naming the suites that hold each item.

#### Changed

- **The onboarding budget**: mainnet 60 sponsored accounts a day and 8 per connection (it was
  40 a day with a per-source share floored at 20, so two addresses could spend a day), and an
  honest retry for the same recipient is free.
- **Single-shot cap accounting**: a failed deposit gives its reservation back once, never
  twice; the pilot slot is kept for an unconfirmed submit; no approval path refills spent
  slots.
- **Unconfirmed submissions**: `/v2-claim`, `/v2-reclaim` and `/cctp-relay` answer 202
  `{hash, confirmed: false}` like `/v2-deposit`, and a busy network answers 503, so no screen
  offers a retry that could spend twice.
- **The channel lease** takes the first free channel of a pass in one store round trip
  (`6b6b98c`), so a full pool falls back instead of failing.

### SOW 2, D2: private links and the commitment spike (live on 2026-10-07)

#### Changed

- **Links are private by default**: no amount anywhere in the link (the claim page reads it
  from the escrow on the ledger, so an edited `?a=` changes nothing on the page), one plain chat
  preview, and
  the sender's name only after the `#`. From the release after `24d0f4e`, a new link carries no
  name at all unless the sender types one.
- **A password is on by default** for real-money links.
- **Claim beacons go to the Worker of the link's network** (`494739b`, 2026-09-19; v1 practice
  links from the release after `24d0f4e`).
- **A practice link's key never becomes the device's home account.**

#### Added

- **The leak audit** ([`evidence/LEAK_AUDIT.md`](evidence/LEAK_AUDIT.md)), the CI suites
  `test:linkprivacy`, `test:claimmeta`, `test:claimledger` and `test:claimhome`, and a nightly
  live check of what chat-preview bots see (`e2e/preview.spec.ts`).
- **A testnet commitment escrow spike** (`contracts/lumen-drop-commit`) with its report
  ([`evidence/ZK_SPIKE_REPORT.md`](evidence/ZK_SPIKE_REPORT.md)). Testnet only, and it does not
  hide the amount.

### SOW 2, D1: the sender-side browser extension, 0.1.0 to 0.1.3 (from 2026-10-03)

- **0.1.0** (2026-10-03): the extension for Chrome and Firefox MV3 (`apps/extension`), reusing
  the website's sender code. Make a payment link from your own account, paste it into a text
  box you pick, see whether it was claimed, take it back after expiry; make or restore an
  account; practice money by default.
- **0.1.1** (2026-10-04): the mascot icons. addons.mozilla.org signed 0.1.0 and 0.1.1 as
  unlisted packages.
- **0.1.2** (2026-10-04): the listing for a public addons.mozilla.org page, the same code as
  0.1.1. Public on the Chrome Web Store by 2026-10-06 and on addons.mozilla.org since
  2026-10-07. Its links still carry the amount and the sender's name in the query.
- **0.1.3** (the release after `24d0f4e`): the private link shape, a take-back answered 202
  kept open instead of read as landed, the real-money warning the website shows, the pilot
  cap as "$5 a link, $25 a day", and no sender name unless the sender types one. It reaches
  each store after that store's review.

### Removed (2026-10-03)

- **The sandbox SEP-6 lira rail** (`/send-out/bank`, `/add-money/bank` and the anchor client):
  the product carries no fiat rail and no mock integration (`40dd808`).

### Earlier (August 2026)

- Community-health and presentation layer: contributing guide, code of conduct,
  security policy, issue/PR templates, and this changelog.

#### Fixed

- **The web recovery self-test was repaired.** Its Argon2id speed-check parameters sat
  below the minimum the wrap path enforces, so the suite had been crashing since
  2026-08-08; the parameters were raised to the enforced floor, and a wrap-time guard
  now rejects Argon2id parameters below that floor instead of failing later.
- **The pilot approval email now states the enforced per-transfer cap** (derived from
  `MAX_DROP_USDC`) instead of a stale hard-coded "$1".

#### Changed

- **CI now runs every offline test suite**, not just the anti-drain validator: the web
  self-tests (recovery, claim-password, receive, horizon) plus the sponsor
  kms / caps / channels / pilot / recovery-store suites. The dead Vercel bundle step
  was removed along with the deleted Vercel fallback.
- **Test-count claims across the docs were reconciled to the executed suites**, as they
  stood on 2026-08-13: anti-drain 60, caps 31, recovery-store 17, web recovery self-test 18.
  Today's counts are in the README's quickstart.

## [0.2.1] - 2026-07-25

A pre-mainnet hardening pass on the v2 `LumenDrop` Soroban escrow, plus dependency and
CI work. Still entirely on the Stellar **test network**. **No professional audit has
happened** - a static-analysis, property-test, fuzz and mutation-testing pass is
complete, and a professional audit is pending. The user-facing flows are unchanged.

### Added

- **Contract governance** via OpenZeppelin's Stellar contracts (0.7.2): `Ownable`
  (two-step transfer + renounce), `Pausable` and `Upgradeable` behind the owner. **Pause
  gates only new escrow** (`deposit` / `create_drop`) - claims and reclaims are never
  pausable, so escrowed funds can always exit - and **the owner has no path that moves
  escrowed funds**. The intended end state is a final upgrade that removes the upgrade
  entrypoint, after an audit.
- **Versioned storage envelopes** (`DropEntry::V1` / `PoolEntry::V1`) so a future upgrade
  can extend records safely.
- **An on-chain governance proof (10/10)**: a non-owner can neither pause nor upgrade;
  pausing blocks new deposits while a claim of an already-escrowed drop still succeeds;
  an owner upgrade leaves a pre-upgrade drop claimable.
- **AWS KMS Ed25519 signer** for the sponsor, code-complete behind the existing signer
  interface with 13/13 offline tests (including byte-parity with the SDK's own signing).
  The live AWS key is **not** provisioned; the deployed service still uses an environment
  key.
- **A kill-switch** that can halt every value-moving sponsor endpoint.
- **Canary caps** - a hard per-drop and rolling-UTC-day ceiling on the escrow the sponsor
  will facilitate, enforced on **both** escrow-creating paths (`/send-link` for v1 and
  `/v2-deposit` for v2). The per-drop cap is checked locally with no network call, so an
  outage cannot disable it; the per-day total is an atomic `INCRBY` reserve-then-check in
  the same store as the rate limiter, so concurrent requests cannot slip through a
  read-then-write gap. A rejected request does not consume the day's budget and a failed
  transaction releases its reservation. Amounts are read from the transaction XDR - what
  the ledger will actually execute - not from a client-supplied field. Configured with
  `MAX_DROP_USDC` / `MAX_DAY_USDC` / `CAPS_FAIL_CLOSED`; testnet runs 100 / 1000 USDC.
  **28/28 offline tests** (`pnpm --filter @lumenia/sponsor test:caps`).
- **A legacy-contract fallback** so a contract repoint cannot break claim links already
  sent. A drop can only ever be released by the contract holding it, so the sponsor
  (`LUMENDROP_LEGACY_CONTRACTS`, one `exitContract()` allowlist behind `/v2-claim` and
  `/v2-reclaim`) and the web app (`resolveDropContract()`, used by claim, reclaim and
  read) now **read and exit** superseded contracts while **new escrow only ever enters the
  current one**. **Proven 9/9 on testnet** with real transactions
  (`pnpm --filter @lumenia/sponsor test:legacy`).
- **A watchdog** on a **Cloudflare Cron Trigger every 15 minutes**, on the Worker that is
  already running. It checks sponsor float, any `payment` / `path_payment_*` /
  `account_merge` / offer **sourced by the sponsor** (the sponsor only creates accounts and
  pays fees, so one of those is the signature of a stolen key), and escrow governance -
  pause/unpause/ownership events plus the deployed wasm hash pinned in
  `LUMENDROP_WASM_HASH`, because an `upgrade` emits **no event** and event-watching alone
  would miss it. Alerts go to `wrangler tail`, plus email when `RESEND_API_KEY` and
  `ALERT_NOTIFY_TO` are set. Smoke test **3/3**
  (`pnpm --filter @lumenia/sponsor test:watchdog`); both tripwires were additionally fired
  against real testnet transactions.
- **A weekly deep-security workflow** - Scout, OpenZeppelin's `soroban-scanner`, fuzzing
  and mutation testing - alongside a per-push contract job (strict clippy, contract tests,
  `cargo-audit`, `cargo-deny`, a 90% line-coverage gate).

### Changed

- **soroban-sdk 22 -> 26.1**; contract events migrated to typed `#[contractevent]` structs
  (same topic layout). `contractmeta binver = "0.2.0"`; the constructor is now
  `__constructor(token, owner)`.
- **Contract tests grew 11 -> 29** (unit + property-based), covering a written
  **14-invariant specification** documented in `contracts/lumen-drop/README.md`.
- **Redeployed to testnet** as `CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S`
  (wasm sha256 `38941538b964af2110a6fd2fae4c1c3de2ff6585ef0da5d1a59de2ce29edec6a`),
  superseding `CDYEDHBPMDOOZSJGB2Z6JVK7GS3S5CWNXNGTEPMJFS25TAWSYHTXA2RF` and the interim
  hardened build `CAKEJAGCATVMJB6CMB6LM736DHUJ37YOTOER23SWRNDHPLTU2ZJUDIAB`. The escrow (7/7)
  and relayer (5/5) on-chain proofs were re-run against it.
- **Production now runs the hardened contract.** The sponsor Worker and the web app point at
  `CDVZN53V...ST6S` for all new escrow, and read/exit the superseded ids through the legacy
  fallback above, so links already sent keep working. A superseded id can be removed from the
  list once its drops have expired and been reclaimed - a drop lives at most 7 days.
- **Next.js bumped to 16.2.11**, closing 4 high and 6 moderate advisories (including a
  middleware bypass and SSRF in Server Actions); the dependency audit was clean at this
  release.

### Fixed

- The three static-analysis findings in the contract: checked arithmetic in two places and
  no `unwrap` on the pinned token. New errors `Overflow`, `NotInitialized`, `BadExpiry`.
- **`expiry` is now bounded** to `now < expiry <= now + 30 days`.

### Security

- Tooling status after the pass: Scout **0 findings** (was 2 Critical + 1 Medium), strict
  clippy 0, `cargo-deny` ok, `cargo-audit` clean apart from one unmaintained-crate advisory
  (`paste`, transitive), `cargo-geiger` 0 `unsafe` in the contract crate, a `cargo-vet`
  baseline. Mutation testing: 58 mutants, **51 caught**, 1 missed (a deliberately redundant
  defense-in-depth guard, documented in the source), 6 unviable. Line coverage 99.16%
  overall (95.2% on the contract library). A `cargo-fuzz` solvency target runs in CI on
  Linux (it cannot link on macOS); the same invariant also runs as a property test
  everywhere. **This is self-assessment with free tooling, not an audit.**
- Operational controls now live on the testnet deployment: the kill-switch, the canary caps
  and the 15-minute cron watchdog described above. On a store outage the caps **fail open by
  default** (the per-drop cap and the rate limits still bound the damage); `CAPS_FAIL_CLOSED=1`
  flips that, and is the recommended mainnet setting - as are lower opening values (20 / 500).
- Two real bugs were found and fixed while proving the watchdog: contract event topics are
  base64-XDR `ScVal`s, so a plain string match never matched; and `upgrade` emits no event at
  all, which is why the deployed wasm hash is checked directly.
- OpenZeppelin Monitor configurations remain in `ops/monitor/` as a documented, **not-deployed**
  richer alternative; a key-custody runbook exists at `ops/RUNBOOK_SPONSOR_KEY.md`.

## [0.2.0] - 2026-07-22

Everything below remains on the Stellar **test network**. This release moves the
sponsor to a single always-on host, makes the default shareable link a Soroban
smart-contract escrow, and adds account recovery, concurrency, and take-it-back -
none of which touches the frozen classic claim path.

### Added

- **v2 Soroban `LumenDrop` escrow** - a smart-contract drop with a **late-bound
  payout**: the link key does not hold the money, it authorizes a payout to an
  address chosen at claim time (verified inside the contract). This is now the
  **default shareable link-send**; the relayer submits and pays the Soroban fee, so
  the flow stays walletless and the recipient still pays no gas. Deployed to testnet
  (single-drop + group-pool variants). The classic v1 Claimable Balance claim
  (`/c/[id]`) remains live and unchanged alongside it.
- **Account recovery** - password + email-OTP recovery of the on-device seed, plus a
  WebAuthn-PRF "Face ID" fast-unlock upgrade. One 32-byte seed is wrapped twice
  (Argon2id -> AES-GCM as the floor; PRF -> HKDF -> AES-GCM as the upgrade) and stored
  as a ciphertext-only, zero-knowledge box the server cannot open. OTP-gated, on its
  own rate-limit bucket. (Owner-gated while the email domain is being verified.)
- **Channel-account concurrency** - a pool of sponsor-controlled channel accounts,
  each lending a transaction sequence under an exclusive Upstash Redis lease, removes
  the single-sequence bottleneck so concurrent claims no longer collide.
- **Recover / reclaim ("Take it back")** - a sender can reclaim an
  abandoned drop without paying gas (the sponsor fee-bumps) for both the classic (v1) and Soroban (v2) paths, surfaced as
  reclaimable notices in the app.

### Changed

- **Sponsor now runs as a single Cloudflare Worker**
  (`https://lumenia-sponsor.avakit.workers.dev`, deployed with `wrangler`), replacing
  the earlier multi-function serverless deployment. Same anti-drain gate, same
  env-hot-key signer, durable Upstash rate-limiting.
- **Anti-drain hardened to 44/44 unit tests** (from 25/25) - added a strict
  recovery-consolidation **sweep** policy, an exact op-**sequence** matcher, and a
  **golden-policy snapshot** test that fails if any allowlist ever widens. The claim
  allowlist was never widened. Integration suite stays 6/6.
- **Live product domain** - the web app now serves from **getlumenia.com**.

## [0.1.0] - 2026-07-18

The first end-to-end testnet pilot: send and request money by link, where the
recipient claims it walletless, seedless, and pays no gas.

### Added

- **Walletless claim flow.** A sender-funded Claimable Balance (dual predicate:
  recipient claims, or the sender reclaims after 7 days) is claimed by a recipient
  who holds **0 XLM** - the sponsor covers the account reserve and the transaction
  fee via a sponsored create + fee-bump. Proven end-to-end in a real browser on
  testnet.
- **Sponsor service** (`apps/sponsor`) with endpoints for account creation, claim
  fee-bumping, onward-send, a test-USDC faucet, demo links, an anonymous event
  beacon, a waitlist, and a feedback channel.
- **Anti-drain validator** - an allowlist that checks every operation's source and
  sensitive parameters before the sponsor signs, so a client transaction can never
  spend the sponsor's reserve or funds. Separate, tighter policies for the claim and
  send paths. Covered by 25/25 unit tests and 6/6 integration tests.
- **Durable rate limiting** (per-IP and per-account) across serverless instances,
  plus a per-bump fee cap.
- **Request money** - create a link that asks someone to pay you; the payer opens it
  and pushes the payment (no pull/debit), with honest handling for the with- and
  without-account cases.
- **Onward send** and an off-chain **split** helper.
- **Product web app** (`apps/web`) in the "Periwinkle" design system: landing,
  how-it-works, a live `/demo` that mints a real testnet claim link, a tools hub
  (transaction verify, link check, USD->TRY, cost), guides (`/learn`), `/stats` (real
  counts read from the public ledger), an honest `/cash-out` guide, and about /
  roadmap / privacy / terms / brand / developers pages.
- **On-device key handling** - a classic Ed25519 key generated on-device, stored in
  an IndexedDB keystore and optionally locked with an Argon2id-derived key.
- **Hermetic CI** - typecheck, the anti-drain validator, and production builds on
  every push and PR, with a single `ci-passed` gate and grouped Dependabot updates.

### Security

- The URL fragment carrying a bearer key is read only on the client and stripped from
  the address bar after use; it is never sent to a server.
- Money surfaces never expose wallet, crypto, or ledger-level error codes to users.

[Unreleased]: https://github.com/getlumenia/lumenia/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/getlumenia/lumenia/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/getlumenia/lumenia/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/getlumenia/lumenia/releases/tag/v0.1.0
