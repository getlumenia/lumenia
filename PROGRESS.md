# PROGRESS - What Has Concretely Been Built So Far

This file records **only the work that has actually been done** (not plans or decisions - those live in [README.md](README.md) and [stack.md](stack.md)). The next agent reads this to see "what really exists." Be honest about the line between *proven* and *unverified* (the section 6 table is the single source of truth for that).

Last updated: 2026-10-10. Networks: **testnet** (the open product and the grant deliverables) **and
a capped, allowlisted mainnet pilot that moves real Circle USDC** - hand-approved wallets only, $5
a link and up to $25 a day from one sender ($50 a day across the pilot), escrow caps fail closed.
"No real money is used" stopped being true on 2026-07-26; see section 6 and section 12.

> **Instawards follow-on, SOW 2 (2026-09-17 to 2026-10-16): see section 6** for the honest line on the
> browser extension (D1), private links and the commitment spike (D2) and the open-mainnet hardening
> (D3), and [EVIDENCE.md](EVIDENCE.md) for the evidence metric by metric. None of its three success
> metrics is met yet: two need the owner's real-money runs, and the third needs the KMS cutover.

> **Instawards sprint (25.06 -> ~24.07): see section 10** - the live sponsor service, the
> end-to-end browser claim (binary metric MET on-chain) and the hardened anti-drain
> (**60/60** unit + **6/6** integration) supersede the pre-award state below where they conflict.
> The project has continued past the sprint: the sponsor now runs as a single **Cloudflare Worker**,
> and v2 Soroban escrow + recovery + request-money + onward-send are shipped on testnet (section 6, section 10).
> A **pre-mainnet hardening pass** on the v2 escrow contract landed 2026-07-25 - see **section 11**
> (static-analysis, property-test, fuzz and mutation-testing pass complete; a professional audit is pending),
> followed the same day by three operational controls: **canary caps**, a **legacy-contract read/exit
> fallback** (production now runs the hardened escrow), and a **cron watchdog** (section 11).

> Naming note: the product is **Lumenia**; packages are `@lumenia/*`. The working directory is historically named `faceid-wallet` (cosmetic). Stelvin is a **separate, independent project** - not part of Lumenia and not used as its credential.

---

## 1. Documentation (written, English)

| File | What |
|---|---|
| [README.md](README.md) | Comprehensive project documentation - problem/solution/flows + 8 architecture decisions and **why**, tech stack, roadmap, risks, competitors. |
| [stack.md](stack.md) | Pinned tech stack + project risk table (R1-R10) + adversarial review notes (six lenses). |
| [EVIDENCE.md](EVIDENCE.md) | Reviewer-facing evidence for both Instawards (SOW 2 first, metric by metric; then SOW 1's tx hashes, live URLs, test captures). |
| [evidence/SOW2_READINESS_REPORT.md](evidence/SOW2_READINESS_REPORT.md), [evidence/LEAK_AUDIT.md](evidence/LEAK_AUDIT.md), [evidence/ZK_SPIKE_REPORT.md](evidence/ZK_SPIKE_REPORT.md), [evidence/SOW2_OPS_NOTE.md](evidence/SOW2_OPS_NOTE.md) | The SOW 2 evidence: the extension's checklist and runs, the private-link leak audit, the testnet commitment spike, and the open-mainnet hardening with its adversarial runs and operations note. |
| [ANTI_DRAIN.md](ANTI_DRAIN.md) | Plain-language write-up of the anti-drain safeguard (SOW D3). |
| Internal working docs | Agent guide, architecture workspace, positioning/strategy and off-ramp planning are **local, gitignored** working documents (not part of the public repo). |

---

## 2. Monorepo skeleton (set up)

pnpm workspaces. `pnpm install` runs clean (Node 24, pnpm 9.12). (The argon2/simplewebauthn recovery deps present pre-sprint were dropped - recovery is SOW out-of-scope.)

```
lumenia/  (working dir: faceid-wallet)
|-- package.json                         # workspace root, scripts (web:dev, sponsor:dev, spike1, test:antidrain, spike1b, spike1c)
|-- pnpm-workspace.yaml                  # apps/* + packages/*
|-- apps/
|   |-- web/
|   |   |-- package.json                 # @lumenia/web - Next 16.2.9, Serwist 9.5.11, stellar-sdk 16.0.0 (PINNED)
|   |   `-- README.md                    # web responsibilities (app built + deployed - section 10)
|   |                                    #   Next bumped to 16.2.11 in the 2026-07-25 pass (section 11)
|   `-- sponsor/
|       |-- package.json                 # @lumenia/sponsor - stellar-sdk only (ESM; recovery deps dropped)
|       |-- tsconfig.json
|       |-- README.md                    # live service layout + module-system gotchas
|       |-- wrangler.toml                 # Cloudflare Worker config (the LIVE deploy)
|       `-- src/
|           |-- worker.ts                    # Cloudflare Worker entry - all endpoints (the LIVE host)
|           |-- lib/                          # create-account, feebump, send, sweep, channels, soroban-relay, anti-drain, caps, pilot, watchdog, recovery-*
|           |-- spike1-sponsored-claim.ts   # Spike #1  - sponsored 0-XLM claim economics
|           |-- spike1b-kms-rawsign.ts      # Spike #1b - external raw Ed25519 -> DecoratedSignature
|           |-- spike1c-wire-parity.ts      # Spike #1c - web->sponsor XDR wire-parity + fee-bump
|           |-- spike5-sponsored-send.ts    # Spike #5  - 0-XLM sponsored onward-send (7/7 testnet)
|           `-- test-antidrain.ts           # anti-drain validator tests (60/60: 18 claim+7 send+12 sweep+12 payout+4 seq+4 golden+3 mux)
|-- contracts/
|   `-- lumen-drop/                      # v2 Soroban escrow (Rust) - soroban-sdk 26.1, OZ Stellar contracts 0.7.2
|       |-- src/lib.rs, src/test.rs     #   contract + 29 unit/property tests over a 14-invariant spec (section 11)
|       |-- fuzz/                        #   cargo-fuzz solvency target (CI on Linux)
|       |-- deny.toml                    #   cargo-deny policy
|       `-- README.md                    #   interface + governance + invariant spec + tooling
`-- packages/
    `-- shared/
        |-- package.json                 # @lumenia/shared
        `-- src/index.ts                 # claim-secret + asset helpers + types (validator moved to apps/sponsor - section 10)
```

**Pinned versions:** `@stellar/stellar-sdk@16.0.0` (exact), `next@16.2.11` (bumped from 16.2.9 - section 11), `react@19.2.0`, `serwist@9.5.11` + `@serwist/turbopack@9.5.11`, `@simplewebauthn/{browser@13.3.0,server@13.3.1}`, `@stellar/typescript-wallet-sdk@3.0.1`, `argon2@^0.41.1`, `tsx@^4.19`.

---

## 3. `packages/shared/src/index.ts` (written, hardened)

> Superseded in part (section 10): during the sprint the validator moved to
> `apps/sponsor/src/lib/anti-drain.ts` (Vercel deploy boundary); `packages/shared`
> now holds only claim-secret/asset helpers + types. The description below records
> the pre-sprint state.

The primitives shared by web + sponsor:
- `usdc(issuer)` / `USDC_MAINNET_ISSUER` - asset helpers.
- `generateClaimSecret()` / `hashClaimSecret()` - link bearer token (only the hash is kept on the server).
- **`validateInnerTransaction(tx, policy)`** - anti-drain ALLOWLIST validator the sponsor runs **before** fee-bumping. Now validates op SOURCE and PARAMETERS, not just op type (a code-review finding): the sponsor may only source `begin/createAccount`; `createAccount.startingBalance` must be <= 0; `changeTrust` must be the expected asset and recipient-sourced; `claimClaimableBalance.balanceId` must match; `payment` is rejected unless its destination is explicitly allow-listed; `beginSponsoring.sponsoredId` must be the recipient. `InnerTxPolicy` gained `expectedAsset`, `expectedBalanceId`, `allowedPaymentDestinations`, `maxStartingBalance`.
- Types: `ClaimLink`, `StellarNetwork`, `InnerTxPolicy`.

---

## 4. Spike #1 - Sponsored 0-XLM Claim economics (PASSING ON TESTNET)

**File:** [apps/sponsor/src/spike1-sponsored-claim.ts](apps/sponsor/src/spike1-sponsored-claim.ts), **Run:** `pnpm spike1`

| Step | Result |
|---|---|
| 1. Fund issuer/sponsor/sender (EXCLUDING recipient) | pass |
| 2. sender USDC trustline + issuer issues 100 USDC | pass |
| 3. sender creates a dual-claimant Claimable Balance (recipient + sender-reclaim-7d) | pass |
| 4. **sponsored onboarding** -> recipient with **0 XLM** + USDC trustline (reserve covered by sponsor) | pass |
| 5. recipient does a **fee-bumped claim** -> received 20 USDC, **still 0 XLM** | pass |
| 6. anti-drain negative test -> malicious inner tx **rejected** | pass |

**What it proves (honest scope):** the **economic backbone** - a new user can own an account + USDC trustline and claim USDC with **zero XLM** because the sponsor pays all reserve + fee. That is the *easy, already-documented* half of the sponsor risk.

> **Correction (don't overclaim):** Spike #1 signs with a **local in-memory `Keypair`** (`tx.sign`) in a **single process**. It does **NOT** prove (a) that the sponsor key can live in an HSM/KMS, or (b) that the inner tx survives the web->sponsor wire, or (c) fee-abuse/economic anti-drain. Those are covered by sections 4b to 4d below; what remains open is in 6.

## 4b. Anti-drain validator hardening + tests (14/14 -> 18/18 -> 25/25 -> 44/44 -> 57/57 -> 60/60, see section 10)

**File:** [apps/sponsor/src/test-antidrain.ts](apps/sponsor/src/test-antidrain.ts), **Run:** `pnpm test:antidrain`, no network needed.

Built the legit claim shape + 11 drain vectors and asserted the canonical validator's verdict. **Result: `ANTI-DRAIN TESTS PASS (14/14)`.** Rejected vectors include: `payment`/`changeTrust` sourced by the sponsor, `createAccount(startingBalance>0)`, `payment` to a non-allow-listed destination, wrong `balanceId`, wrong `changeTrust` asset, wrong tx source, disallowed op type, too many ops, `createAccount` destination != recipient, `beginSponsoring.sponsoredId` != recipient.

## 4c. Spike #1b - external raw Ed25519 -> Stellar DecoratedSignature (TESTNET)

**File:** [apps/sponsor/src/spike1b-kms-rawsign.ts](apps/sponsor/src/spike1b-kms-rawsign.ts), **Run:** `pnpm spike1b`

Simulates an HSM/KMS with Node `crypto` (pure Ed25519 over the tx hash, **not** stellar-sdk's signer), builds the `DecoratedSignature` by hand (hint = last 4 bytes of the public key), and submits to testnet. **Result: `SPIKE #1b PASS`** - the network accepted the externally-signed tx, and the hand-built `DecoratedSignature` is **byte-identical** to `kp.signDecorated()`. Research confirms AWS KMS supports Ed25519 raw signing since 2025-11-07 (`ECC_NIST_EDWARDS25519` / `ED25519_SHA_512` / `MessageType=RAW`), so swapping the Node-crypto stand-in for a `kms.sign(...)` call is a drop-in. **This closes the KMS half of R3.**

## 4d. Spike #1c - web->sponsor XDR wire-parity + fee-bump (TESTNET)

**File:** [apps/sponsor/src/spike1c-wire-parity.ts](apps/sponsor/src/spike1c-wire-parity.ts), **Run:** `pnpm spike1c`

Inserts the real wire boundary: WEB builds + signs the claim inner tx -> `toXDR()` (base64) -> SPONSOR `fromXDR()` -> asserts **byte-for-byte hash/XDR parity** -> runs the **canonical** shared validator -> fee-bumps the **re-parsed** tx -> submits. **Result: `SPIKE #1c PASS`** - wire round-trip byte-identical, validator accepts the claim, fee-bump of the re-parsed tx settles, recipient ends with 20 USDC / 0 XLM. **This closes the wire-parity concern.**

---

## 4e. Spike #4 - CCTP off-ramp bridge: Stellar-side interface (TESTNET)

**File:** [apps/sponsor/src/spike4-cctp-bridge.ts](apps/sponsor/src/spike4-cctp-bridge.ts), **Run:** `pnpm spike4`

Proves the Stellar-specific half of the CCTP bridge leg (off-ramp Path 3) on live testnet. **Result: `SPIKE #4 PASS`** - `approve` (USDC SAC -> TokenMessengerMinter) ran as a **real testnet tx (SUCCESS)**, and `deposit_for_burn` **simulation reached contract logic** (host accepted all 8 args - `i128`, `u32`, `BytesN<32>`, `Address` - plus `require_auth`, then returned `Error(Contract, #10)`, a contract business-rule rejection consistent with an unfunded account - NOT an ABI/type/method error). Iris attestation sandbox endpoint is reachable. Interface verified against `circlefin/stellar-cctp` + Circle quickstart.

**Honest scope:** this proves the Stellar-side CCTP interface (SAC approve, `deposit_for_burn` arg types/order/auth, recipient-signed). It does NOT run a funded burn (the testnet CCTP USDC faucet `faucet.circle.com` is web/reCAPTCHA only - no scriptable API) nor the EVM `receiveMessage` mint (standard CCTP, out of scope). Remaining = a [YOU] step: fund via the faucet, then the same call + Iris poll completes a real burn->attestation. The `Error(Contract, #10)` exact meaning isn't mapped to Circle's enum yet (most likely balance/allowance) - confirm on a funded run.

---

## 5. Day-1 finding caught (mempool-class)

`@stellar/stellar-sdk@16` ESM build blows up under Node ESM on its internal `@stellar/js-xdr` import (`does not provide an export named 'config'`). **Original fix** was running `apps/sponsor` as CommonJS. **Superseded during the sprint (section 10):** the package is now ESM (`"type":"module"`, tsx runs it fine). The esbuild CJS bundle existed only for the Vercel host, and **that host is gone** - `src/vercel/`, `build-vercel.mjs` and the `build:vercel` script were deleted; the Cloudflare Worker runs the ESM source directly. Web (Next.js bundler) unaffected. (Details in [apps/sponsor/README.md](apps/sponsor/README.md).)

---

## 6. Proven vs. unverified (the honest line)

| Item | Status |
|---|---|
| Sponsored 0-XLM onboarding + fee-bumped claim economics | PROVEN (Spike #1, testnet) |
| Anti-drain validator rejects reserve/principal drain vectors | PROVEN (**82/82** unit on the merged tree of 2026-10-09, 71/71 at `24d0f4e`, 60/60 at the SOW 1 close-out, + **6/6** integration tests; gates the live `/feebump` - section 10) |
| Sponsor key behind external raw-Ed25519 signer (KMS path) | PROVEN mechanically (Spike #1b); the AWS-KMS signer is **wired** - `lib/kms-signer.ts` implements the same `SponsorSigner` interface and `getServiceAsync()` selects it whenever `KMS_KEY_ID` is set, with **153/153 offline tests** on the merged tree of 2026-10-09 (142/142 at `24d0f4e`; byte-parity with the SDK's own signing - section 11; since SOW 2's D3 the sponsor account is configured apart from its signer, so the cutover is one SetOptions on the existing account). Live AWS provisioning has **not** happened, so **both** deployed Workers (testnet and the mainnet pilot) still sign with an env hot-key; the cutover is the last open part of SOW 2's metric 3 |
| web->sponsor XDR wire-parity + fee-bump of re-parsed tx | PROVEN (Spike #1c + live browser claim - section 10) |
| **Live sponsor service + end-to-end walletless browser claim** | **PROVEN on-chain** (section 10: tx `b9ef1844...` - 20 USDC landed, 0 XLM held, sponsor paid the fee) |
| Fee-abuse / rate-limit economic defense | PROVEN live - durable cross-instance 429 on the deployed service (Upstash store; section 10) + integration test |
| v2 Soroban `LumenDrop` escrow (late-bound payout; the default shareable link-send) | PROVEN (testnet) - **29** unit + property tests over a written 14-invariant spec, plus **7/7** escrow + **5/5** relayer + **10/10** governance on-chain proofs against the current contract; deposit->claim->reclaim live over HTTP with the sponsor paying the fees (section 10, section 11). Production now points at the **hardened** contract, with superseded contracts still readable/exitable via the legacy fallback (section 11). **No professional audit** - the static-analysis, property-test, fuzz and mutation-testing pass is complete, but that is self-assessment; a professional audit is pending. |
| Escrow **canary caps** (per-drop + rolling-UTC-day ceiling on both escrow-creating paths) + the **onboarding budget** (accounts/day) | PROVEN offline - **274/274** at `24d0f4e` and on the merged tree of 2026-10-09 (`test:caps`): boundaries, day rollover, reserve/release, both store-outage behaviours, the accounts-per-day bucket with its per-connection share, the per-sender day cap and the sponsor fee budget (the last three from SOW 2's D3). Amounts are read from the transaction XDR, not a client field. **Deployed values:** testnet 100 / 1000 USDC; the mainnet pilot runs **5 / 50 with `CAPS_FAIL_CLOSED=1`**, 25 per sender a day, 60 sponsored accounts a day and 8 per connection, and a 15 XLM day fee budget (section 11's "start at 20 / 500" was a pre-deploy suggestion - the live setting is tighter). On a store outage the escrow caps fail closed on mainnet; the onboarding and fee budgets fall back to per-isolate counters (a soft bound across isolates) instead of refusing, so an outage never strands a recipient |
| **Legacy-contract read/exit fallback** (a drop can only be released by the contract holding it) | PROVEN on testnet - **9/9** real transactions (`test:legacy`): a drop in a superseded contract claims through the relayer, a drop in the current one claims with no `contract` argument, a foreign contract id is rejected before any network spend, and a deposit into a superseded contract is rejected (section 11) |
| **Watchdog** (Cloudflare Cron Trigger, every 15 min: sponsor float, sponsor-sourced value ops, escrow governance + wasm hash) | PROVEN on testnet - smoke test **3/3** (`test:watchdog`), plus **both tripwires fired against real transactions**: a live `pause` produced a page naming the tx hash, and a deliberately wrong pinned wasm hash produced the wasm-changed page (section 11). Since 2026-10-08 (SOW 2's D3) it also halts the sponsor by itself on its two theft tripwires (a sponsor-sourced forbidden operation, a changed escrow wasm) and stamps a heartbeat that a GitHub workflow is scheduled to read every 30 minutes; GitHub has started this repository's schedules hours late, and the first scheduled run is 37850573340 (`test:watchdog-offline` **201/201** on the merged tree of 2026-10-09, 193/193 at `24d0f4e`; the merged tree also writes the halt the moment a tripwire is raised, which both Workers run since their deploys of 2026-10-09); both Workers' first stamps and the workflow's first green run are in `evidence/SOW2_READINESS_REPORT.md` D3.5. The alert path is PROVEN: on 2026-10-09 the `test_alert` drill (run 37905050169) opened issue #46 and the next run (37905107528) closed it at 08:28:08 UTC. Since 2026-10-10 (`7e699f0`, live on both Workers that day): after the mainnet watchdog paged five times that day because the public Soroban RPC answered HTTP 429 to three quick attempts, a busy or unreachable source (a throttle, a 5xx, a gateway page, no connection) pages only once every scheduled run for 45 minutes found it so, with retries paced 1 s then 3 s and `Retry-After` honoured up to 4 s; a refusal, an operator's run or a store that cannot keep the start time still pages at once; both auto-halt tripwires still halt in the first run that can see them, and the heartbeat still opens an issue after 3 hours without a full run (`test:watchdog-offline` **240/240** at `c961c69`). A review of the first version found five defects, fixed before it shipped |
| v2 escrow tool-clean (static analysis, property tests, fuzz, mutation testing) | DONE 2026-07-25 (section 11) - Scout 0 findings, strict clippy 0, cargo-deny ok, 0 `unsafe`, 99.16% line coverage, 51/58 mutants caught. **This is not an audit**; a professional audit is pending. |
| Sponsor concurrency (channel-account pool; was the #1 mainnet blocker) | PROVEN live - 20/20 concurrent `/create-account`, 0 `tx_bad_seq`, 20/20 via:channel (section 10) |
| Recovery (password + email-OTP + WebAuthn-PRF "Face ID") | PARTLY: SHIPPED in code + crypto self-test 18/18 (the web's `test:recovery`, which holds **125/125** at `c961c69` with the account model of 2026-10-10: signed backups, one email for one account, changing the backup email; multi-account keystore + sweep also shipped, Spike #7 8/8). Real-device PRF (Spike #2) + Resend domain-verify still gate real users. |
| Sponsor runs as a single Cloudflare Worker (env hot-key signer) | LIVE - `lumenia-sponsor.avakit.workers.dev`, plus a separate `lumenia-sponsor-mainnet` for the pilot. The Vercel host is **gone** (source, bundler and script deleted; the deployment is dead), so the Worker is the only sponsor host. |
| **Mainnet pilot - real Circle USDC, allowlisted + capped** | LIVE since 2026-07-26. Owner-approved wallets only (`PILOT_MODE=1`, fail-closed), $5 a link, up to $25 a day from one sender (since 2026-10-08) and $50 a day across the pilot, `CAPS_FAIL_CLOSED=1`, a per-wallet budget of 5 ledger-confirmed value ops, kill-switch, 15-min watchdog. Counted 2026-08-28: **74 approved wallets, 69 accounts opened, 53 funded, 109 real-money transfers** - every account and transfer is on the public ledger. Re-counted from Horizon on 2026-09-06: 76 accounts opened by the sponsor (72 still open, 51 holding real USDC today), 92 USDC-moving operations attributable to the sponsor between 2026-08-24 and 2026-08-30, about **$4.4 moved in total**, of which $2.76 was 69 person-to-person payments with a **median of $0.002** and a maximum of $1.00; 65 of those 69 landed on 2026-08-24 in a scripted coverage run, together only $0.26 (recounted from Horizon on 2026-10-09). The counts are real and small: this is a mechanism proven with real money, not volume. **Not** an open mainnet launch and **not** audited: opening it beyond the pilot waits only for a written legal opinion (SOW 2's D3 made it one rehearsed configuration change); a professional security review and a timelock in front of the owner multisig (2-of-3 since 2026-09-18) gate raising the caps materially and renouncing the upgrade key. Pilot guard tests **190/190** offline at `c961c69` on 2026-10-10, with the signed request to join and the pilot states (90/90 on the merged tree of 2026-10-09, 80/80 at `24d0f4e`; `test:pilot`). For the hackathon the day caps were raised (in force from the 18 Sept dry run) and reverted on 24 Sept in `858e999`, three and a half days late; the per-transfer cap, fail-closed and the allowlist never moved, and nothing was spent while the step stood. |
| Recipient can turn Stellar-USDC into spendable TRY (off-ramp) | PARTLY: **WALKED ONCE BY HAND, not productized (2026-08-28).** Real USDC left a Lumenia mainnet account on Stellar (tx `3ac2c428...`), a licensed exchange credited it, an internal move reached that exchange's Turkish entity, USDC was sold for lira there, and lira arrived in a Turkish bank account - about 30 minutes end to end. **Honest scope: one run, the founder's own fully-KYC'd accounts, every leg manual, and the amounts do not chain:** 0.50 USDC left Lumenia on chain (tx `3ac2c428...`), while the exchange-side legs sold 1 USDC for 48.05 TRY and withdrew 48.5 TRY, so they also drew on balances those accounts already held; only the first two legs are anchored in public. The 0.145% is the trading fee on that sale (0.0697 TRY on 48.05 TRY), not a ledger cost. It shows the route exists; it is not an integration, no user can do it in-product, and MASAK's ~$3k/day cap + 72h first-withdrawal hold still apply. **Correction:** the earlier "two direct exits" line was wrong - a review found **KAST funds only from Solana/EVM, not Stellar**, so it is not an exit for Stellar-USDC. Still true from the 2026-06-18 anchor-directory check: **no Stellar anchor offers a direct TRY off-ramp**, and Banxa rejects Stellar-USDC. **CCTP V2** (live on Stellar testnet+mainnet, Spike #4 done) remains the partner-independent fallback. |
| **Browser extension** (SOW 2 D1: Chrome + Firefox MV3, `apps/extension`) | PROVEN on testnet: links made in the extension and claimed on getlumenia.com in a browser with no extension, take-backs after expiry, and an account made in the extension end to end, last on 2026-10-10 with 0.1.4 against the new testnet Worker (an account made, 1.00 practice dollar, a link claimed with no extension, read as Claimed, backed up by email, restored in a fresh profile to the same address; `evidence/SOW2_READINESS_REPORT.md` D1.3). PUBLISHED: 0.1.3 on both stores, addons.mozilla.org since 2026-10-09 and the Chrome Web Store since 2026-10-10 (10:32 UTC; the package it serves, sha256 `94e119a4...51bd`, matches the build file for file apart from what the store adds); before it, 0.1.2 was public on the Chrome Web Store (by 2026-10-06) and on addons.mozilla.org (2026-10-07). 0.1.4 (the account management below; built 2026-10-10 from `c961c69`, hashes and a byte-identical clean-room rebuild in the readiness report): public on addons.mozilla.org since 2026-10-10, 13:26 UTC (AMO version 6561729); its Chrome Web Store upload is the owner's step and has not been made. Offline: 9 suites / 3,314 at `c961c69` (2,173 on the merged tree of 2026-10-09, 1,927 at `24d0f4e`), in CI with both builds and the Firefox lint. PARTLY: 0.1.2 predates private links (its links carry the amount and the sender's name in the query) and reads a take-back answered 202 as landed; 0.1.3 fixes both, and an install of 0.1.2 that has not updated yet, and the self-hosted 0.1.1 at getlumenia.com/extension/lumenia-firefox.xpi, still behave the old way. On 2026-10-09 the 0.1.3 Firefox package also ran end to end in Firefox 155 on practice money (an account made, a $0.25 link claimed on getlumenia.com, the list reading Claimed; readiness report D1.3). A 60 fps practice-money demo of 0.1.3 was recorded on 2026-10-09 (readiness report D1.6), served on getlumenia.com since the 2026-10-09 web deploy. UNVERIFIED: a real-money send from the published extension, claimed on mainnet (SOW 2 metric 1, the owner's run); Firefox as a person installs it from AMO (the 2026-10-09 run used a temporary add-on and the popup page in a tab); a paste on the real chat sites |
| **Account management** (one account model for the website, the extension and the sponsor, 2026-10-10) | LIVE on the website and both Workers since 2026-10-10 (sponsor `df31e02`; web `2d37df8` and `c961c69`; testnet Worker `b7876a09`, mainnet Worker `dd9408b4`); in extension 0.1.4 (`e4f57db`), public on addons.mozilla.org since 2026-10-10 and not yet uploaded to the Chrome Web Store. It started from the founder's report of 9 to 10 October: the website and the extension held two different keys, the extension's "Ask to join" filed the website's key, and a backup made on one surface could replace another account's email backup. A review in six lenses gave 84 findings; a second, skeptical pass checked 31 of them (30 real, 1 refuted); the real ones were all fixed in those four commits. The model now: one email backs up one account (the server never overwrites a row bound to another key; that an email already backs up another account is said only after the inbox code, and the person can open that account instead); a request to join real money is signed by the key in use and carries that key's backup email; both surfaces show the same pilot states (none, pending, approved, declined, revoked, no sends left, unknown); every surface shows the account in use (its short address and its email); a second account can be brought in without wiping the first; Leave this device sizes its warning by every account it deletes; practice dollars count as added only once the ledger shows them (a 202 from the faucet used to show "You have $0.00"). Offline at `c961c69`: sponsor `test:pilot` 190, `test:recovery-store` 149, `test:identity` 73, `test:identity-routes` 49; web `test:recovery` 125, `test:pilotaccess` 217, `test:claimhome` 44, `test:receive` 23; extension 3,314. Live on 2026-10-10: after the website deploy, the claim, private-link preview and send checks passed against production (3 of 3), and the extension's create run with 0.1.4 made, backed up and restored an account against the new testnet Worker. Not in those runs: a request to join real money from either surface, and opening an approved account on real money from the extension (held by the offline suites). NOT YET ON: two server switches that default off for the transition, `PILOT_REQUIRE_PROOF` on the mainnet Worker (refuses an unsigned request to join) and `RECOVERY_REQUIRE_OWNER` on the testnet Worker (refuses an unsigned first backup); the owner turns them on once the new website and extension are live (the website is; 0.1.4 is on addons.mozilla.org, not yet on the Chrome Web Store) |
| **Private links** (SOW 2 D2: no amount in the link, the amount read from the ledger, one plain chat preview, no sender name unless the sender types one, a password by default for real money) | LIVE since 2026-10-07 and held in CI (`test:linkprivacy`, `test:claimmeta`, `test:claimledger`, `test:claimhome`); the nightly live run 37774557675 (2026-10-08) passed its private-link preview step against getlumenia.com; the leak audit is `evidence/LEAK_AUDIT.md`. UNVERIFIED: a private link claimed on mainnet (SOW 2 metric 2, the owner's run). Stated, not changed: the link's id is public on the ledger and leads to the amount and the sender's account, and to the sender's @name when that account holds one |
| **Commitment escrow spike** (SOW 2 D2, `contracts/lumen-drop-commit`) | PROVEN on testnet only: contract `CAGWIGEG...ILCXA`, one deposit and its claim, 22 tests in CI; its testnet entries extended on 2026-10-09 to about ledger 8,206,700 (about 2027-04-07). It does **not** hide the amount: the amount stays public in the deposit call, its auth entry and the token event, and the stored record keeps it next to the commitment so a dishonest reveal cannot drain other drops (`evidence/ZK_SPIKE_REPORT.md`). Groth16 (Tier 2): MEASURED on testnet with the upstream example, not built by us. The upstream soroban-examples BLS12-381 verifier (`CBMYSVI2...75MD`) returned true for the upstream circom proof (tx `7a024510...48d6`, 41,460,357 instructions, 0.0039623 XLM). That is the upstream example circuit, not a range proof of ours; no circuit of ours exists |
| **Open-mainnet hardening** (SOW 2 D3: relay simulation and fee bounds, a day fee budget, single-shot cap accounting, the per-share floor, the per-connection onboarding share, the watchdog heartbeat and auto-halt, unconfirmed-submission handling, the per-sender cap, the account and signer split, the retirement switch) | DEPLOYED to both Workers on 2026-10-08 and green in CI (run 37813352621, step "Hardening suite (D3 a-k)"). The scripted adversarial run against the live mainnet Worker was refusal-only and spent nothing (239.6774337 XLM before and after); full runs went against the deployed testnet Worker and local Workers. The retirement switch passed a dry run on a local Worker (2026-10-08) and was REHEARSED on the deployed testnet Worker on 2026-10-09, 08:57 to 09:03 UTC (`ops/rehearsal/run-testnet-rehearsal.sh`: six phases, 22 logged steps, all PASS; a never-approved wallet refused with the allowlist on and served with it off, the caps still refusing, 13 of 13 routes halted by `SPONSOR_HALT=1`, all three deposits taken back; log in `evidence/SOW2_OPS_NOTE.md` section 1.4). MERGED AND DEPLOYED 2026-10-09 (testnet version `213a2832`, then `32067caf` after the rehearsal's last deploy; mainnet `baaeaae0`; all tagged `215cfb2`): the mainnet log redaction, a subrequest budget of 45 per request, `/health` version, the halt written as soon as a tripwire is raised, the approval mail's warning, and `SPONSOR_ACCOUNT_ID` / `KMS_REGION` in `wrangler.toml`. DEPLOYED 2026-10-10: the watchdog's busy-source fix (`7e699f0`) and the server half of the account model (`df31e02`), the testnet Worker as version `afb6aa3c` (the fix alone) then `b7876a09` (tag `e4f57db`) from 09:37 UTC, the mainnet Worker as version `dd9408b4` (tag `c961c69`) from 13:16 UTC, deployed by the owner, `PILOT_MODE=1` kept and the caps unchanged ($5 a link, $25 a day per sender, $50 a day in total, a 15 XLM fee budget); the whole offline gate on `c961c69`, 54 commands, green after the deploys. NOT DONE: the KMS cutover (SOW 2 metric 3's last part; `ops/kms/cloudshell-setup.sh` then `ops/kms/cutover.sh`), the owner's step |
| WebAuthn PRF round-trip on real devices (Spike #2) | UNVERIFIED (needs hardware); Argon2id is the mandatory floor |
| WhatsApp webview claim + escape-to-browser + Argon2id (Spike #3) | UNVERIFIED (needs hardware); architecture researched (value-first + escape-to-browser) |
| Serwist + Turbopack PWA service worker | UNVERIFIED; webpack fallback still supported in Next 16 |

---

## 7. Research completed (off-code, June 2026)

Six deep research briefs were produced to de-risk the review-flagged unknowns. Headlines:

- **Off-ramp:** No Turkish CASP confirmed to accept USDC on the *Stellar* network. **Mitigation:** CCTP is live on Stellar (~May 2026) -> bridge Stellar-USDC to a chain Turkish CASPs accept; or a USDC-funded card (RedotPay/KAST). MASAK caps: ~$3k/day, 72h first withdrawal.
- **WhatsApp webview:** passkeys **cannot** be created in WhatsApp's webview. **Mitigation:** value-first (show the money before any credential) + escape-to-browser (Android `intent://` reliable; iOS "Open in Safari" best-effort) + Argon2id password fallback. Reframe the promise to "see + claim in ~30s," not "passkey in 30s."
- **KMS:** AWS KMS does Ed25519 raw signing since 2025-11-07 -> first-class fit (proven in Spike #1b). Turnkey/Fireblocks are alternatives if a policy engine/MPC is needed later.
- **PRF/Argon2id:** Argon2id-primary + PRF-as-fast-unlock is correct; envelope encryption (one DEK, two wraps); one mental model - "password is the master key; Face ID is a shortcut."
- **Competitors:** the real alternative is the recipient's own bank app (FAST/Kolay Adres - instant, free, domestic). Lumenia wins on the **cross-border EU->TR leg + open shareable link**. LOBSTR already does email/phone claim (close threat); Morse (ex-Sling) ships the same link UX (MiCA-licensed, Turkey closed-beta).
- **Sybil/economics:** ~$0.44 per onboarded recipient, mostly **reclaimable** reserves (1.5 XLM, CAP-33). Make the headline metric "unique-human + retained second action," not raw addresses.

---

## 8. NOT DONE YET (for the next agent)

- DONE: ~~`apps/web` skeleton~~ -> **built, deployed and wired** (value-first claim page -> live sponsor; section 10). Recovery/passkeys, off-ramp adapters and the Serwist SW remain stubs (SOW out-of-scope).
- DONE: ~~`apps/sponsor` HTTP service~~ -> **live as a Cloudflare Worker** (deployed twice: testnet + the mainnet pilot) with the anti-drain gate, fee cap, canary caps and per-IP/per-account rate limit (section 10). Still open from the old sub-list: **provisioning** the KMS key (the signer is wired behind `KMS_KEY_ID`, 153/153 offline on the merged tree of 2026-10-09, but both deployments still run the env hot-key - section 11; the cutover is the owner's step under SOW 2), and putting a **timelock** in front of the mainnet contract owner, which has been a **2-of-3 multisig** since 2026-09-18 (all three keys held by one person today).
- NOT DONE: **Spike #2** (WebAuthn PRF round-trip on a real device) - requires hardware.
- NOT DONE: **Spike #3** (WhatsApp webview claim + escape-to-browser + Argon2id fallback) - requires hardware.
- PARTLY: **CASP / off-ramp** - the founder walked one exit to a Turkish bank by hand on 2026-08-28 (section 6), so the route is no longer theoretical. What is **not** done: any in-product path, a second run, a run by someone who is not the founder, and the MASAK first-withdrawal hold measured on a real recipient.
- PARTLY: **Recovery** (password + email-OTP + PRF "Face ID") is SHIPPED in code (real-device PRF / Spike #2 + Resend domain-verify pending) and **request-money** is SHIPPED (push-only, **not** SEP-7 - the first-time-asker case has no destination account). Still unbuilt: an off-chain split ledger and a production DB (the live stores are Upstash Redis + on-chain; there is no Postgres).

---

## 9. How to run (summary)

```bash
# at the repo root
pnpm install        # entire workspace
pnpm spike1         # Spike #1   -> testnet -> "SPIKE #1 PASS"
pnpm test:antidrain # validator  -> "ANTI-DRAIN TESTS PASS (82/82)" at c961c69, 2026-10-10 (no network)
pnpm --filter @lumenia/sponsor test:integration  # -> "INTEGRATION TESTS PASS (6/6)" (testnet)
pnpm --filter @lumenia/sponsor test:legacy       # -> 9/9 legacy-contract fallback (testnet)
pnpm --filter @lumenia/sponsor test:watchdog     # -> 3/3 watchdog smoke test (testnet)

# the offline suites CI runs on every push (no network, no secrets); counts at c961c69, 2026-10-10.
# The authoritative list is .github/workflows/ci.yml; README.md's quickstart lists every suite.
pnpm --filter @lumenia/sponsor test:caps            # -> 274/274 caps, per-sender cap, onboarding + fee budgets
pnpm --filter @lumenia/sponsor test:pilot           # -> 190/190 pilot allowlist + budget + the retirement switch + the approval mail + the signed request to join + the pilot states
pnpm --filter @lumenia/sponsor test:kms             # -> 153/153 KMS signer path + the account/signer split + subrequests per route
pnpm --filter @lumenia/sponsor test:events          # -> 80/80 event beacon
pnpm --filter @lumenia/sponsor test:recovery-store  # -> 149/149 recovery blob store, one email backs up one account
pnpm --filter @lumenia/sponsor test:identity        # -> 73/73 names + ways-back-in registries
pnpm --filter @lumenia/sponsor test:identity-routes # -> 49/49 the same, through worker.fetch
pnpm --filter @lumenia/sponsor test:channels        # -> 29/29 channel-lease correctness
pnpm --filter @lumenia/sponsor test:cctp            # -> 58/58 the CCTP relay
pnpm --filter @lumenia/sponsor test:soroban-relay   # -> 163/163 the LumenDrop relay guard + the log redaction
pnpm --filter @lumenia/sponsor test:watchdog-offline # -> 240/240 every watchdog tripwire, auto-halt, heartbeat, a busy source paged only after 45 minutes
pnpm --filter @lumenia/web test:recovery            # -> 125/125 recovery crypto + the website's backup client
pnpm --filter @lumenia/web test:money               # -> 36/36 amount parsing + formatting
pnpm --filter @lumenia/web test:txguard             # -> 32/32 client-side signing guard
pnpm --filter @lumenia/web test:claimerr            # -> 75/75 claim-error classification
pnpm --filter @lumenia/web test:claimpw             # -> 13/13 password-locked links
pnpm --filter @lumenia/web test:receive             # -> 23/23 incl. practice dollars counted only once the ledger shows them
pnpm --filter @lumenia/web test:horizon             # -> 71/71
pnpm --filter @lumenia/web test:suggest             # -> 8/8 name suggestions
pnpm --filter @lumenia/web test:linkprivacy         # -> 74/74 what a link, its beacon and the claim headers reveal
pnpm --filter @lumenia/web test:pilotaccess         # -> 217/217 the real-money access rules, the pilot states, the account in use
pnpm --filter @lumenia/web test:claimhome           # -> 44/44 a practice link's key never becomes the home account
pnpm --filter @lumenia/extension test               # -> 3,314 across the extension's 9 suites
# whole gate at c961c69 (54 commands, all green on 2026-10-10): 40 suites / 6,071 (sponsor 12 / 1,540, web 19 / 1,217,
# extension 9 / 3,314), plus fake-kv --selftest 38, cargo test 29 (lumen-drop) and 22 (lumen-drop-commit);
# on the merged tree of 2026-10-09 it was 40 suites / 4,388 (sponsor 12 / 1,270, web 19 / 945, extension 9 / 2,173)

# the remaining testnet spikes
pnpm spike1b        # Spike #1b  -> testnet -> "SPIKE #1b PASS"
pnpm spike1c        # Spike #1c  -> testnet -> "SPIKE #1c PASS"
pnpm spike4         # Spike #4   -> testnet -> "SPIKE #4 PASS" (CCTP Stellar-side interface)
```

> `node_modules/` is gitignored. Network is required (npm registry + Horizon testnet + friendbot).

---

## 10. Instawards sprint (started 25.06.2026) - live service + e2e claim

The 30-day SOW ([INSTAWARDS_SOW.md](INSTAWARDS_SOW.md)) integrates the proven spikes into one live flow. Status per deliverable - see [EVIDENCE.md](EVIDENCE.md) for the reviewer-facing package. Counts in this section are from the sprint and its close-out (2026-08-31); today's are in section 6 and section 9.

- **D1 - live sponsor service:** now deployed as a single **Cloudflare Worker** at `https://lumenia-sponsor.avakit.workers.dev` (`/health`, `/create-account`, `/feebump`, plus the post-sprint `/send-link` `/sweep` `/faucet` `/demo-link` `/events` `/waitlist` `/feedback` and v2/recovery endpoints); env hot-key signer; fee cap; per-IP + per-account rate limiting, **durable across instances** (Upstash Redis, `KV_REST_API_URL/TOKEN`; in-memory fallback). Proven live: 12 concurrent `/create-account` for one account -> exactly 5x200 (cap) + 7x429. (The move off Vercel was forced by its Hobby 12-function cap once recovery pushed the count to 15; the esbuild-CJS fallback that briefly existed for that host has since been deleted along with the host - section 5.)
- **D2 - end-to-end walletless claim:** **binary metric MET.** A real browser tapped a claim link on `https://lumenia-chi.vercel.app`, the sponsor created a 0-XLM account + USDC trustline, and the fee-bumped claim landed **20 USDC with the recipient holding 0 XLM** - tx `b9ef1844c6ca2df732648b965a2f991ba0197643057b2c9e2a60ab52c3e23746` (fee paid by the sponsor; verify on stellar.expert).
- **D3 - anti-drain, wired and tested:** the validator (`apps/sponsor/src/lib/anti-drain.ts`, hardened to **strict-by-default**) gates every live `/feebump`. **60/60** unit tests (18 claim + 7 send + 12 sweep + 12 payout + 4 op-sequence + 4 golden-policy + 3 muxed-address) + **6/6** integration tests (happy claim / happy send / drain rejection / rate-limit 429 over real HTTP); a live drain attempt against the deployed endpoint returns `400 - "op 'payment' sourced from sponsor (drain attempt)"`. Three separate tight policies (CLAIM / SEND / SWEEP); the claim allowlist is never widened. Write-up: [ANTI_DRAIN.md](ANTI_DRAIN.md).
- **Web claim UI:** value-first page (amount before any credential; bearer key in the `#fragment`, never sent to a server), on-screen explorer tx link after the claim, and the delegated cash-out **placeholder** (disabled "Spend with a card / Convert to Turkish lira" - a licensed provider converts, Lumenia never does; SOW section 4.1 note).
- **Evidence:** [EVIDENCE.md](EVIDENCE.md) + the test-output capture `evidence/tests-60-60-antidrain.png` (the SOW-era 25/25 capture was dropped once the suite outgrew it).
- **Demo videos:** recorded and published. The 60-second video is a phone opening a claim link on the live page on testnet, USDC arriving with no wallet, no setup and no gas (https://www.youtube.com/shorts/X5ie9O7XLYg, 61 s, published 2026-08-30). The three-minute product demo was recorded in a browser (https://youtu.be/eGqJDv0C0mk, 172 s, published 2026-07-28); until 2026-10-09 this line and EVIDENCE.md called that one the 60-second phone video. Both in [EVIDENCE.md](EVIDENCE.md).

---

## 11. Pre-mainnet hardening pass on the v2 escrow contract (2026-07-25)

A hardening pass on `contracts/lumen-drop` ahead of any mainnet consideration. **It is not an audit**:
a static-analysis, property-test, fuzz and mutation-testing pass is complete; **a professional audit is
pending**. Contract details: [contracts/lumen-drop/README.md](contracts/lumen-drop/README.md),
posture: [SECURITY.md](SECURITY.md).

**Contract changes**

- **soroban-sdk 22 -> 26.1**; events migrated to typed `#[contractevent]` structs (same topic layout).
- The **three static-analysis findings fixed** - checked arithmetic (x2) and no `unwrap` on the pinned
  token. New errors: `Overflow`, `NotInitialized`, `BadExpiry`.
- **`expiry` is now bounded:** `now < expiry <= now + 30 days`.
- **Versioned storage envelopes** (`DropEntry::V1` / `PoolEntry::V1`) so a future upgrade can extend
  records without trapping on old ones.
- **Governance** via OpenZeppelin's Stellar contracts (0.7.2): `Ownable` (two-step transfer + renounce),
  `Pausable` that gates **only** `deposit`/`create_drop` (claims and reclaims are **never** pausable, so
  escrowed funds can always exit) and `Upgradeable` behind the owner. **The owner has no path that moves
  escrowed funds.** Constructor is now `__constructor(token, owner)`; `contractmeta` `binver = "0.2.0"`.
  Intended end state: a final upgrade that removes the upgrade entrypoint = genuine immutability, **after**
  a professional audit.

**Testing + tooling (self-assessment, not an audit)**

| Check | Result |
|---|---|
| Contract tests (unit + property-based) | **11 -> 29**, covering a written **14-invariant** specification |
| Mutation testing (`cargo mutants`) | 58 mutants - **51 caught**, 1 missed (a deliberately redundant defense-in-depth guard, documented in the source), 6 unviable |
| Coverage | **99.16%** lines overall (95.2% on the contract library) |
| CoinFabrik Scout | **0 findings** (was 2 Critical + 1 Medium) |
| Strict clippy / cargo-deny / cargo-geiger | 0 warnings, ok, **0 `unsafe`** in the contract crate |
| cargo-audit | clean apart from one unmaintained-crate advisory (`paste`, transitive); cargo-vet baseline established |
| Fuzzing | a `cargo-fuzz` **solvency** target runs in CI on Linux (it cannot link on macOS); the same invariant also runs as a property test everywhere |

**Testnet deployment.** Current contract **`CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S`**
(USDC SAC `CDUL6GQBQKJYG26YZDJHTZF7G73EKUAWA3LTPK7LXODHPCUPK5AU76KF`), wasm sha256
`38941538b964af2110a6fd2fae4c1c3de2ff6585ef0da5d1a59de2ce29edec6a` (21,323 bytes; stellar CLI 25.2.0,
rustc 1.96.0, target `wasm32v1-none`). It supersedes `CDYEDHBPMDOOZSJGB2Z6JVK7GS3S5CWNXNGTEPMJFS25TAWSYHTXA2RF`
(the original) and `CAKEJAGCATVMJB6CMB6LM736DHUJ37YOTOER23SWRNDHPLTU2ZJUDIAB` (an interim hardened build).
**Production now points at this contract for all NEW escrow**, while still reading and exiting drops held
by the superseded ones - see "Legacy-contract fallback" below.

**Proofs re-run against the new contract** (real testnet transactions): escrow proof **7/7**, relayer
proof **5/5**, and a **new governance proof 10/10** (a non-owner can neither pause nor upgrade; pausing
blocks new deposits while a claim of an already-escrowed drop still succeeds; an owner upgrade leaves a
pre-upgrade drop claimable). Off-chain: anti-drain **44/44**, sponsor integration **6/6**, KMS-signer
**13/13**. See [EVIDENCE.md](EVIDENCE.md).

**Sponsor hardening.** An **AWS-KMS Ed25519 signer** is code-complete behind the existing signer
interface with **13/13** offline tests (including byte-parity with the SDK's own signing) - **live AWS
provisioning has not happened**, so the deployed service still uses an environment key. A **kill-switch**
can halt every value-moving endpoint. A key-custody runbook exists (`ops/RUNBOOK_SPONSOR_KEY.md`).

**Canary caps** (`apps/sponsor/src/lib/caps.ts`) - a hard ceiling on the escrow the sponsor will
facilitate, on **both** escrow-creating paths (`/send-link` for v1 and `/v2-deposit` for v2):

- **Per-drop cap** - enforced locally with no network call, so an outage can never disable it.
- **Per-day cap** - a rolling UTC-day total across all senders, kept in the same Upstash store as the
  rate limiter, using an **atomic `INCRBY` reserve-then-check** so concurrent requests cannot slip
  through a read-then-write gap. A rejected request does not consume the day's budget, and a *failed*
  transaction calls `release()` to hand its reservation back.
- **Store outage** is a deliberate choice: the default is **fail open** (the per-drop cap and the rate
  limits still bound the damage); `CAPS_FAIL_CLOSED=1` flips it to fail closed - recommended for mainnet.
- Amounts are read **from the transaction XDR** (the Claimable Balance amount for v1, `deposit`'s second
  argument for v2), i.e. from what the ledger will actually execute, not from a client-supplied field.
- Config: `MAX_DROP_USDC` / `MAX_DAY_USDC` / `CAPS_FAIL_CLOSED`. Testnet defaults are **100 / 1000 USDC**
  (set in `wrangler.toml`); mainnet should start at **20 / 500** with fail-closed.
- **Tests: 28/28 offline** - `pnpm --filter @lumenia/sponsor test:caps` (boundaries, day rollover,
  reserve/release, both outage behaviours, and a malformed env value falling back to the default rather
  than to unlimited).

**Legacy-contract fallback (the migration safety net).** Production points at the hardened escrow for all
NEW escrow while still **reading and exiting** drops held by superseded contracts - a drop can only ever
be released by the contract holding it, so a naive repoint would have silently broken every claim link
already sent.

- Sponsor: a `lumendropLegacyContracts` config (`LUMENDROP_LEGACY_CONTRACTS`); `/v2-claim` accepts an
  optional `contract`, `/v2-reclaim` validates the inner transaction's target, and both go through one
  `exitContract()` allowlist. **`/v2-deposit` is unchanged** - new escrow only ever enters the current
  contract.
- Web (`apps/web/lib/lumendrop.ts`): `resolveDropContract()` finds which escrow holds a link (`get_drop` /
  `get_pool`); `claimV2` + `reclaimV2` use it and `readDrop` reads across all of them. This ordering is
  load-bearing: the signed claim message **binds the contract address**, so reading a drop from the wrong
  contract would produce a signature the escrow rejects - resolution has to happen first.
- Superseded ids currently carried: `CDYEDHBPMDOOZSJGB2Z6JVK7GS3S5CWNXNGTEPMJFS25TAWSYHTXA2RF` (the
  original) and `CAKEJAGCATVMJB6CMB6LM736DHUJ37YOTOER23SWRNDHPLTU2ZJUDIAB` (the interim hardened build).
  An id can be dropped from the list once its drops have all expired and been reclaimed - a drop lives at
  most 7 days.
- **Proven on testnet 9/9** with real transactions - `pnpm --filter @lumenia/sponsor test:legacy`: a drop
  in the superseded contract claims through the relayer; a drop in the current contract claims with no
  `contract` argument; a foreign contract id is rejected **before any network spend**; and a `/v2-deposit`
  into a superseded contract is rejected ("wrong contract").

**Watchdog** (`apps/sponsor/src/lib/watchdog.ts`) - monitoring that actually runs. OpenZeppelin Monitor
needs a separate always-on host we do not operate, so the tripwire ships as a **Cloudflare Cron Trigger
every 15 minutes** on the Worker we already run. Three checks:

- **Sponsor float** below `SPONSOR_MIN_XLM` (default 50), or the account unreadable.
- **Sponsor-SOURCED value** - any `payment` / `path_payment_*` / `account_merge` / offer sourced by the
  sponsor. The sponsor only creates accounts and pays fees, so one of these is the signature of a stolen key.
- **Escrow governance** - `paused` / `unpaused` / ownership events, **and** the deployed wasm hash. The
  wasm check exists because an **`upgrade` emits no event** (the OpenZeppelin implementation just calls
  `update_current_contract_wasm`), so event-watching alone would miss the most serious possible action.
  The expected hash is pinned in `LUMENDROP_WASM_HASH` (currently `38941538...ec6a`) - it must be updated on
  every intentional upgrade or the watchdog pages you about your own deploy.
- Alerts go to `wrangler tail` always, plus email when `RESEND_API_KEY` + `ALERT_NOTIFY_TO` are set.
  Cursors live in Upstash; with no store every check still runs against a bounded recent window.
- **Both tripwires verified against real testnet transactions:** a live `pause` on the escrow produced a
  page naming the tx hash (then unpaused; `paused` reads false again), and a deliberately wrong pinned
  hash produced the wasm-changed page. Smoke test: `pnpm --filter @lumenia/sponsor test:watchdog` (**3/3**).
- Two real bugs were found and fixed while proving it: event topics are base64-XDR `ScVal`s (a plain
  string match never matched), and `upgrade` emits no event at all.

The OpenZeppelin Monitor JSON configs remain in `ops/monitor/` as a documented, **not-deployed** richer
alternative.

**Web dependencies.** Next.js bumped to **16.2.11**, closing 4 high and 6 moderate advisories (including
a middleware bypass and SSRF in Server Actions); the dependency audit was clean that day. (Correction,
2026-10-09: it is not clean now. Next.js is at 16.3.8, and GitHub lists 60 open Dependabot alerts: 2
critical, 25 high, 29 medium, 4 low.)

**CI.** Every push now runs strict clippy, the contract test suite, `cargo-audit`, `cargo-deny` and a
**90% line-coverage gate**; a weekly workflow runs Scout, OpenZeppelin's `soroban-scanner`, fuzzing and
mutation testing.

---

## 12. Correctness pass, 2026-08-30 (real-money paths + doc truth)

A review of the money paths now that real dollars move through them, and of the public docs that had
drifted behind the deployment. **No new product surface** - the changes below make existing paths
tell the truth about what happened.

**The doctrine that drove most of it: an unconfirmed transaction is not a failed one.** Reporting
"nothing moved" when the network simply did not answer invites a retry that spends the money twice.

- **v2 deposit / `/send`.** A deposit that cannot be confirmed now says so and offers no retry until
  the signed transaction's own timebound has passed - the instant after which it genuinely cannot be
  included. Before that, "we couldn't confirm" stays on screen.
- **Cash-out (`/send-out`).** Horizon timeouts, 5xx and no-answer-at-all now raise a distinct
  "couldn't confirm" state instead of "your money hasn't moved, try again", with **no retry
  affordance**; the sponsor distinguishes the same case (`SubmitUnconfirmedError`) rather than
  collapsing it into a generic failure. The `/payout` route still carries no status or field of its
  own for it, so on **mainnet** the client reads the redacted `request failed` answer as unconfirmed
  - deliberately conservative on the one screen where saying "nothing moved" pays an exchange twice,
  at the cost of every other withheld reason on that route reading the same way.
- **v1 claim.** A link retried after a partial claim no longer bricks: the client accepts the
  sponsor's 3-op reply after independently confirming on Horizon that the account exists, instead of
  demanding the 4-op shape forever. Guard refusals are now **terminal** (no button offering an
  identical refusal), `op_no_trust` is no longer misread as "already claimed", the frozen route's
  fallback host was pointed at the live Worker, and the route is pinned to testnet.
- **v2 claim.** The escrow is read **before** an account is minted, so a dead or already-claimed
  link costs no sponsor reserve and files no orphan key; already-claimed / no-such-drop get their own
  settled screens instead of "your money is still safe, try again"; double-tap is guarded; an
  Argon2id derivation that cannot run says so instead of leaving "Checking..." forever.
- **`/sent/[id]`.** A status read that failed renders as "couldn't check just now", not "Received".
- **Amounts.** Four money fields deleted a decimal comma, turning `1,50` into `150`. They now read it
  (`lib/money.ts`, `test:money` **36/36**). USDC->stroop conversion no longer round-trips through a
  float.
- **Recovery passwords.** The strength floor is enforced where the box is wrapped, not only on the
  first screen, and the server-stored backup lands **before** the device locks - a wrong code no
  longer leaves an account locked under a password with no copy anywhere. A confirm field was added
  where a new password is set.
- **Sponsor bounds.** `/create-account` was the one value route with no economic ceiling; it now
  reserves against a per-UTC-day onboarding budget (released when the handout fails; when the counter
  store cannot be read it falls back to a per-isolate counter instead of refusing, so an outage never
  strands a recipient. Correction, 2026-10-09: this line used to say "fail-closed on mainnet", which
  the budget never was; only the escrow caps and the pilot allowlist fail closed). The body cap is enforced on the bytes actually read rather than on a
  `content-length` a client can omit. `/faucet` and `/demo-link` refuse off testnet **in code**, so
  an inherited secret cannot give away real value. `/events/summary` is metered like the other reads.
- **Watchdog.** Sponsor-sourced `set_options` / `create_passive_sell_offer` /
  `create_claimable_balance` now page (a stolen key preparing a theft was invisible); the capacity
  alert's title no longer carries a ticking number, so its 6-hour dedup works; a check that *fails to
  run* pages instead of passing quietly; and a run that cannot deliver alerts says so rather than
  marking conditions as already-sent.
- **Connecting a way back in.** `/identity-attach` now takes **two** signatures, because two parties
  have to agree: the identity's own proof, and the account's `links` signature over the literal
  `attach` - rebuilt server-side from `address`, so no other key can stand in for it. Both halves are
  wired end to end: the three connect paths take the signer first, the client sends `accountProof`,
  the Worker forwards it, and the store verifies it before writing a row. A throwaway email is no
  longer enough to hang connections off a stranger's address.
- **Half-landed, recorded as such:** a recovery row can now carry a hash of the account key allowed
  to replace it, so a stolen inbox cannot paint over a working backup, and the web helper knows how
  to sign that proof - but the one screen that stores a backup does not hand it a signer, so rows are
  still written unbound and stay replaceable by anyone who can read the mail.

**Test counts after the pass** (all offline, all run): antidrain 60/60, caps **52/52**, pilot
**36/36**, recovery-store **30/30**, identity **66/66**, identity-routes 37/37, kms 13/13,
events 22/22, web recovery 18/18, **money 36/36 (new suite)**, txguard **32/32**, claimerr
**24/24**, claimpw 13/13, receive 14/14, horizon 17/17, suggest 8/8. `test:money` is wired into
CI alongside the rest.
