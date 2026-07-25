# PROGRESS — What Has Concretely Been Built So Far

This file records **only the work that has actually been done** (not plans or decisions — those live in [README.md](README.md) and [stack.md](stack.md)). The next agent reads this to see "what really exists." Be honest about the line between *proven* and *unverified* (the §6 table is the single source of truth for that).

Last updated: 2026-07-25 · Network: **testnet** · No real money used.

> **Instawards sprint (25.06 → ~24.07): see §10** — the live sponsor service, the
> end-to-end browser claim (binary metric MET on-chain) and the hardened anti-drain
> (**44/44** unit + **6/6** integration) supersede the pre-award state below where they conflict.
> The project has continued past the sprint: the sponsor now runs as a single **Cloudflare Worker**,
> and v2 Soroban escrow + recovery + request-money + onward-send are shipped on testnet (§6, §10).
> A **pre-mainnet hardening pass** on the v2 escrow contract landed 2026-07-25 — see **§11**
> (static-analysis, property-test, fuzz and mutation-testing pass complete; a professional audit is pending),
> followed the same day by three operational controls: **canary caps**, a **legacy-contract read/exit
> fallback** (production now runs the hardened escrow), and a **cron watchdog** (§11).

> Naming note: the product is **Lumenia**; packages are `@lumenia/*`. The working directory is historically named `faceid-wallet` (cosmetic). Stelvin is a **separate, independent project** — not part of Lumenia and not used as its credential.

---

## 1. Documentation (written, English)

| File | What |
|---|---|
| [README.md](README.md) | Comprehensive project documentation — problem/solution/flows + 8 architecture decisions and **why**, tech stack, roadmap, risks, competitors. |
| [stack.md](stack.md) | Pinned tech stack + project risk table (R1–R10) + adversarial review notes (six lenses). |
| [EVIDENCE.md](EVIDENCE.md) | Reviewer-facing Instawards evidence package (tx hashes, live URLs, test capture). |
| [ANTI_DRAIN.md](ANTI_DRAIN.md) | Plain-language write-up of the anti-drain safeguard (SOW D3). |
| Internal working docs | Agent guide, architecture workspace, positioning/strategy and off-ramp planning are **local, gitignored** working documents (not part of the public repo). |

---

## 2. Monorepo skeleton (set up)

pnpm workspaces. `pnpm install` runs clean (Node 24, pnpm 9.12). (The argon2/simplewebauthn recovery deps present pre-sprint were dropped — recovery is SOW out-of-scope.)

```
lumenia/  (working dir: faceid-wallet)
├── package.json                         # workspace root, scripts (web:dev, sponsor:dev, spike1, test:antidrain, spike1b, spike1c)
├── pnpm-workspace.yaml                  # apps/* + packages/*
├── apps/
│   ├── web/
│   │   ├── package.json                 # @lumenia/web — Next 16.2.9, Serwist 9.5.11, stellar-sdk 16.0.0 (PINNED)
│   │   └── README.md                    # web responsibilities (app built + deployed — §10)
│   │                                    #   Next bumped to 16.2.11 in the 2026-07-25 pass (§11)
│   └── sponsor/
│       ├── package.json                 # @lumenia/sponsor — stellar-sdk only (ESM; recovery deps dropped)
│       ├── tsconfig.json
│       ├── README.md                    # live service layout + module-system gotchas
│       ├── wrangler.toml                 # Cloudflare Worker config (the LIVE deploy)
│       └── src/
│           ├── worker.ts                    # ✅ Cloudflare Worker entry — all endpoints (the LIVE host)
│           ├── lib/                          # create-account · feebump · send · sweep · channels · soroban-relay · anti-drain · recovery-*
│           ├── vercel/                       # esbuild-bundled deprecated 12-fn Vercel fallback
│           ├── spike1-sponsored-claim.ts   # ✅ Spike #1  — sponsored 0-XLM claim economics
│           ├── spike1b-kms-rawsign.ts      # ✅ Spike #1b — external raw Ed25519 → DecoratedSignature
│           ├── spike1c-wire-parity.ts      # ✅ Spike #1c — web→sponsor XDR wire-parity + fee-bump
│           ├── spike5-sponsored-send.ts    # ✅ Spike #5  — 0-XLM sponsored onward-send (7/7 testnet)
│           └── test-antidrain.ts           # ✅ anti-drain validator tests (44/44: 18 claim+7 send+12 sweep+4 seq+3 golden)
├── contracts/
│   └── lumen-drop/                      # ✅ v2 Soroban escrow (Rust) — soroban-sdk 26.1, OZ Stellar contracts 0.7.2
│       ├── src/lib.rs · src/test.rs     #   contract + 29 unit/property tests over a 14-invariant spec (§11)
│       ├── fuzz/                        #   cargo-fuzz solvency target (CI on Linux)
│       ├── deny.toml                    #   cargo-deny policy
│       └── README.md                    #   interface + governance + invariant spec + tooling
└── packages/
    └── shared/
        ├── package.json                 # @lumenia/shared
        └── src/index.ts                 # claim-secret + asset helpers + types (validator moved to apps/sponsor — §10)
```

**Pinned versions:** `@stellar/stellar-sdk@16.0.0` (exact), `next@16.2.11` (bumped from 16.2.9 — §11), `react@19.2.0`, `serwist@9.5.11` + `@serwist/turbopack@9.5.11`, `@simplewebauthn/{browser@13.3.0,server@13.3.1}`, `@stellar/typescript-wallet-sdk@3.0.1`, `argon2@^0.41.1`, `tsx@^4.19`.

---

## 3. `packages/shared/src/index.ts` (written, hardened)

> ⚠️ Superseded in part (§10): during the sprint the validator moved to
> `apps/sponsor/src/lib/anti-drain.ts` (Vercel deploy boundary); `packages/shared`
> now holds only claim-secret/asset helpers + types. The description below records
> the pre-sprint state.

The primitives shared by web + sponsor:
- `usdc(issuer)` / `USDC_MAINNET_ISSUER` — asset helpers.
- `generateClaimSecret()` / `hashClaimSecret()` — link bearer token (only the hash is kept on the server).
- **`validateInnerTransaction(tx, policy)`** — anti-drain ALLOWLIST validator the sponsor runs **before** fee-bumping. Now validates op SOURCE and PARAMETERS, not just op type (a code-review finding): the sponsor may only source `begin/createAccount`; `createAccount.startingBalance` must be ≤ 0; `changeTrust` must be the expected asset and recipient-sourced; `claimClaimableBalance.balanceId` must match; `payment` is rejected unless its destination is explicitly allow-listed; `beginSponsoring.sponsoredId` must be the recipient. `InnerTxPolicy` gained `expectedAsset`, `expectedBalanceId`, `allowedPaymentDestinations`, `maxStartingBalance`.
- Types: `ClaimLink`, `StellarNetwork`, `InnerTxPolicy`.

---

## 4. ✅ Spike #1 — Sponsored 0-XLM Claim economics (PASSING ON TESTNET)

**File:** [apps/sponsor/src/spike1-sponsored-claim.ts](apps/sponsor/src/spike1-sponsored-claim.ts) · **Run:** `pnpm spike1`

| Step | Result |
|---|---|
| 1. Fund issuer/sponsor/sender (EXCLUDING recipient) | ✔ |
| 2. sender USDC trustline + issuer issues 100 USDC | ✔ |
| 3. sender creates a dual-claimant Claimable Balance (recipient + sender-reclaim-7d) | ✔ |
| 4. **sponsored onboarding** → recipient with **0 XLM** + USDC trustline (reserve covered by sponsor) | ✔ |
| 5. recipient does a **fee-bumped claim** → received 20 USDC, **still 0 XLM** | ✔ |
| 6. anti-drain negative test → malicious inner tx **rejected** | ✔ |

**What it proves (honest scope):** the **economic backbone** — a new user can own an account + USDC trustline and claim USDC with **zero XLM** because the sponsor pays all reserve + fee. That is the *easy, already-documented* half of the sponsor risk.

> ⚠️ **Correction (don't overclaim):** Spike #1 signs with a **local in-memory `Keypair`** (`tx.sign`) in a **single process**. It does **NOT** prove (a) that the sponsor key can live in an HSM/KMS, or (b) that the inner tx survives the web→sponsor wire, or (c) fee-abuse/economic anti-drain. Those are covered by §4b–§4d below; what remains open is in 6.

## 4b. ✅ Anti-drain validator hardening + tests (14/14 → 18/18 → 25/25 → 44/44, see §10)

**File:** [apps/sponsor/src/test-antidrain.ts](apps/sponsor/src/test-antidrain.ts) · **Run:** `pnpm test:antidrain` · no network needed.

Built the legit claim shape + 11 drain vectors and asserted the canonical validator's verdict. **Result: `✅ ANTI-DRAIN TESTS PASS (14/14)`.** Rejected vectors include: `payment`/`changeTrust` sourced by the sponsor, `createAccount(startingBalance>0)`, `payment` to a non-allow-listed destination, wrong `balanceId`, wrong `changeTrust` asset, wrong tx source, disallowed op type, too many ops, `createAccount` destination ≠ recipient, `beginSponsoring.sponsoredId` ≠ recipient.

## 4c. ✅ Spike #1b — external raw Ed25519 → Stellar DecoratedSignature (TESTNET)

**File:** [apps/sponsor/src/spike1b-kms-rawsign.ts](apps/sponsor/src/spike1b-kms-rawsign.ts) · **Run:** `pnpm spike1b`

Simulates an HSM/KMS with Node `crypto` (pure Ed25519 over the tx hash, **not** stellar-sdk's signer), builds the `DecoratedSignature` by hand (hint = last 4 bytes of the public key), and submits to testnet. **Result: `✅ SPIKE #1b PASS`** — the network accepted the externally-signed tx, and the hand-built `DecoratedSignature` is **byte-identical** to `kp.signDecorated()`. Research confirms AWS KMS supports Ed25519 raw signing since 2025-11-07 (`ECC_NIST_EDWARDS25519` / `ED25519_SHA_512` / `MessageType=RAW`), so swapping the Node-crypto stand-in for a `kms.sign(...)` call is a drop-in. **This closes the KMS half of R3.**

## 4d. ✅ Spike #1c — web→sponsor XDR wire-parity + fee-bump (TESTNET)

**File:** [apps/sponsor/src/spike1c-wire-parity.ts](apps/sponsor/src/spike1c-wire-parity.ts) · **Run:** `pnpm spike1c`

Inserts the real wire boundary: WEB builds + signs the claim inner tx → `toXDR()` (base64) → SPONSOR `fromXDR()` → asserts **byte-for-byte hash/XDR parity** → runs the **canonical** shared validator → fee-bumps the **re-parsed** tx → submits. **Result: `✅ SPIKE #1c PASS`** — wire round-trip byte-identical, validator accepts the claim, fee-bump of the re-parsed tx settles, recipient ends with 20 USDC / 0 XLM. **This closes the wire-parity concern.**

---

## 4e. ✅ Spike #4 — CCTP off-ramp bridge: Stellar-side interface (TESTNET)

**File:** [apps/sponsor/src/spike4-cctp-bridge.ts](apps/sponsor/src/spike4-cctp-bridge.ts) · **Run:** `pnpm spike4`

Proves the Stellar-specific half of the CCTP bridge leg (off-ramp Path 3) on live testnet. **Result: `✅ SPIKE #4 PASS`** — `approve` (USDC SAC → TokenMessengerMinter) ran as a **real testnet tx (SUCCESS)**, and `deposit_for_burn` **simulation reached contract logic** (host accepted all 8 args — `i128`, `u32`, `BytesN<32>`, `Address` — plus `require_auth`, then returned `Error(Contract, #10)`, a contract business-rule rejection consistent with an unfunded account — NOT an ABI/type/method error). Iris attestation sandbox endpoint is reachable. Interface verified against `circlefin/stellar-cctp` + Circle quickstart.

**Honest scope:** this proves the Stellar-side CCTP interface (SAC approve, `deposit_for_burn` arg types/order/auth, recipient-signed). It does NOT run a funded burn (the testnet CCTP USDC faucet `faucet.circle.com` is web/reCAPTCHA only — no scriptable API) nor the EVM `receiveMessage` mint (standard CCTP, out of scope). Remaining = a [YOU] step: fund via the faucet, then the same call + Iris poll completes a real burn→attestation. The `Error(Contract, #10)` exact meaning isn't mapped to Circle's enum yet (most likely balance/allowance) — confirm on a funded run.

---

## 5. 🔎 Day-1 finding caught (mempool-class)

`@stellar/stellar-sdk@16` ESM build blows up under Node ESM on its internal `@stellar/js-xdr` import (`does not provide an export named 'config'`). **Original fix** was running `apps/sponsor` as CommonJS. **Superseded during the sprint (§10):** the package is now ESM (`"type":"module"`, tsx runs it fine); what still needs CJS is the **Vercel deploy**, handled by the esbuild self-contained bundle (`build-vercel.mjs`). Web (Next.js bundler) unaffected. (Details in [apps/sponsor/README.md](apps/sponsor/README.md).)

---

## 6. Proven vs. unverified (the honest line)

| Item | Status |
|---|---|
| Sponsored 0-XLM onboarding + fee-bumped claim economics | ✅ PROVEN (Spike #1, testnet) |
| Anti-drain validator rejects reserve/principal drain vectors | ✅ PROVEN (**44/44** unit + **6/6** integration tests; gates the live `/feebump` — §10) |
| Sponsor key behind external raw-Ed25519 signer (KMS path) | ✅ PROVEN mechanically (Spike #1b); an AWS-KMS signer is now **code-complete** behind the existing signer interface with **13/13 offline tests** (byte-parity with the SDK's own signing — §11). ⚠️ Live AWS provisioning has **not** happened: the deployed testnet service still uses an env hot-key (SOW scope) |
| web→sponsor XDR wire-parity + fee-bump of re-parsed tx | ✅ PROVEN (Spike #1c + live browser claim — §10) |
| **Live sponsor service + end-to-end walletless browser claim** | ✅ **PROVEN on-chain** (§10: tx `b9ef1844…` — 20 USDC landed, 0 XLM held, sponsor paid the fee) |
| Fee-abuse / rate-limit economic defense | ✅ PROVEN live — durable cross-instance 429 on the deployed service (Upstash store; §10) + integration test |
| v2 Soroban `LumenDrop` escrow (late-bound payout; the default shareable link-send) | ✅ PROVEN (testnet) — **29** unit + property tests over a written 14-invariant spec, plus **7/7** escrow + **5/5** relayer + **10/10** governance on-chain proofs against the current contract; deposit→claim→reclaim live over HTTP with the sponsor paying the fees (§10, §11). Production now points at the **hardened** contract, with superseded contracts still readable/exitable via the legacy fallback (§11). ❌ **No professional audit** — the static-analysis, property-test, fuzz and mutation-testing pass is complete, but that is self-assessment; a professional audit is pending. |
| Escrow **canary caps** (per-drop + rolling-UTC-day ceiling on both escrow-creating paths) | ✅ PROVEN offline — **28/28** (`test:caps`): boundaries, day rollover, reserve/release, both store-outage behaviours. Amounts are read from the transaction XDR, not a client field. Live on testnet at 100 / 1000 USDC; mainnet should start at 20 / 500 with `CAPS_FAIL_CLOSED=1` (§11) |
| **Legacy-contract read/exit fallback** (a drop can only be released by the contract holding it) | ✅ PROVEN on testnet — **9/9** real transactions (`test:legacy`): a drop in a superseded contract claims through the relayer, a drop in the current one claims with no `contract` argument, a foreign contract id is rejected before any network spend, and a deposit into a superseded contract is rejected (§11) |
| **Watchdog** (Cloudflare Cron Trigger, every 15 min: sponsor float · sponsor-sourced value ops · escrow governance + wasm hash) | ✅ PROVEN on testnet — smoke test **3/3** (`test:watchdog`), plus **both tripwires fired against real transactions**: a live `pause` produced a page naming the tx hash, and a deliberately wrong pinned wasm hash produced the wasm-changed page (§11) |
| v2 escrow tool-clean (static analysis, property tests, fuzz, mutation testing) | ✅ DONE 2026-07-25 (§11) — Scout 0 findings, strict clippy 0, cargo-deny ok, 0 `unsafe`, 99.16% line coverage, 51/58 mutants caught. **This is not an audit**; a professional audit is pending. |
| Sponsor concurrency (channel-account pool; was the #1 mainnet blocker) | ✅ PROVEN live — 20/20 concurrent `/create-account`, 0 `tx_bad_seq`, 20/20 via:channel (§10) |
| Recovery (password + email-OTP + WebAuthn-PRF "Face ID") | ◑ SHIPPED in code + crypto self-test 13/13 (multi-account keystore + sweep also shipped, Spike #7 8/8). Real-device PRF (Spike #2) + Resend domain-verify still gate real users. |
| Sponsor runs as a single Cloudflare Worker (env hot-key signer) | ✅ LIVE — `lumenia-sponsor.avakit.workers.dev`; the Vercel esbuild-CJS path is a deprecated 12-fn fallback. KMS raw-signer proven mechanically (Spike #1b), not wired. |
| 🔑 Recipient can turn Stellar-USDC into spendable TRY (off-ramp) | ⚠️ PATHS IDENTIFIED, real-world unconfirmed. **CCTP V2 is live on Stellar testnet+mainnet** (bridge leg is **testnet-testable now**, no money/KYC). Two **direct** Stellar-USDC exits need no bridge: **KAST card** (TRY spend) and **Binance Global→Binance TR→IBAN**. MASAK: ~$3k/day, 72h first withdrawal. Official anchor directory (anchors.stellar.org) checked 2026-06-18: TR anchors = Banxa/BiLira/Onramp.money/Digibank/Arf, but **Banxa rejects Stellar-USDC** (XLM buy-only) and **no anchor offers a direct TRY off-ramp for Stellar-USDC** — Banxa/BiLira are BD leads ("accept USDC on Stellar?"), not a ready path. Plan tracked in a local working doc — Spike #4 (CCTP testnet) done; KAST/Binance real-account checks pending. |
| WebAuthn PRF round-trip on real devices (Spike #2) | ❌ UNVERIFIED (needs hardware); Argon2id is the mandatory floor |
| WhatsApp webview claim + escape-to-browser + Argon2id (Spike #3) | ❌ UNVERIFIED (needs hardware); architecture researched (value-first + escape-to-browser) |
| Serwist + Turbopack PWA service worker | ❌ UNVERIFIED; webpack fallback still supported in Next 16 |

---

## 7. Research completed (off-code, June 2026)

Six deep research briefs were produced to de-risk the review-flagged unknowns. Headlines:

- **Off-ramp:** No Turkish CASP confirmed to accept USDC on the *Stellar* network. **Mitigation:** CCTP is live on Stellar (~May 2026) → bridge Stellar-USDC to a chain Turkish CASPs accept; or a USDC-funded card (RedotPay/KAST). MASAK caps: ~$3k/day, 72h first withdrawal.
- **WhatsApp webview:** passkeys **cannot** be created in WhatsApp's webview. **Mitigation:** value-first (show the money before any credential) + escape-to-browser (Android `intent://` reliable; iOS "Open in Safari" best-effort) + Argon2id password fallback. Reframe the promise to "see + claim in ~30s," not "passkey in 30s."
- **KMS:** AWS KMS does Ed25519 raw signing since 2025-11-07 → first-class fit (proven in Spike #1b). Turnkey/Fireblocks are alternatives if a policy engine/MPC is needed later.
- **PRF/Argon2id:** Argon2id-primary + PRF-as-fast-unlock is correct; envelope encryption (one DEK, two wraps); one mental model — "password is the master key; Face ID is a shortcut."
- **Competitors:** the real alternative is the recipient's own bank app (FAST/Kolay Adres — instant, free, domestic). Lumenia wins on the **cross-border EU→TR leg + open shareable link**. LOBSTR already does email/phone claim (close threat); Morse (ex-Sling) ships the same link UX (MiCA-licensed, Turkey closed-beta).
- **Sybil/economics:** ~$0.44 per onboarded recipient, mostly **reclaimable** reserves (1.5 XLM, CAP-33). Make the headline metric "unique-human + retained second action," not raw addresses.

---

## 8. NOT DONE YET (for the next agent)

- ✅ ~~`apps/web` skeleton~~ → **built, deployed and wired** (value-first claim page → live sponsor; §10). Recovery/passkeys, off-ramp adapters and the Serwist SW remain stubs (SOW out-of-scope).
- ✅ ~~`apps/sponsor` HTTP service~~ → **live on Vercel** with anti-drain gate, fee cap and per-IP/per-account rate limit (§10). Still open from the old sub-list: **provisioning** the KMS key (the signer itself is code-complete + 13/13 offline, but the deployed service still runs the env hot-key — §11), and the exact op-sequence matcher from the architecture review (the live `/feebump` policy pins `maxOps: 1`, which covers the claim path).
- ❌ **Spike #2** (WebAuthn PRF round-trip on a real device) — requires hardware.
- ❌ **Spike #3** (WhatsApp webview claim + escape-to-browser + Argon2id fallback) — requires hardware.
- ❌ 🔑 **CASP / off-ramp confirmation** — still the highest-leverage off-code task; research narrowed it to "confirm a CCTP-bridged or card cash-out actually works for a TR recipient."
- ◑ **Recovery** (password + email-OTP + PRF "Face ID") is SHIPPED in code (real-device PRF / Spike #2 + Resend domain-verify pending) and **request-money** is SHIPPED (push-only, **not** SEP-7 — the first-time-asker case has no destination account). Still unbuilt: an off-chain split ledger and a production DB (the live stores are Upstash Redis + on-chain; there is no Postgres).

---

## 9. How to run (summary)

```bash
# at the repo root
pnpm install        # entire workspace
pnpm spike1         # Spike #1   → testnet → "✅ SPIKE #1 PASS"
pnpm test:antidrain # validator  → "✅ ANTI-DRAIN TESTS PASS (44/44)" (no network)
pnpm --filter @lumenia/sponsor test:integration  # → "✅ INTEGRATION TESTS PASS (6/6)" (testnet)
pnpm --filter @lumenia/sponsor test:caps         # → 28/28 canary caps (no network)
pnpm --filter @lumenia/sponsor test:legacy       # → 9/9 legacy-contract fallback (testnet)
pnpm --filter @lumenia/sponsor test:watchdog     # → 3/3 watchdog smoke test (testnet)
pnpm spike1b        # Spike #1b  → testnet → "✅ SPIKE #1b PASS"
pnpm spike1c        # Spike #1c  → testnet → "✅ SPIKE #1c PASS"
pnpm spike4         # Spike #4   → testnet → "✅ SPIKE #4 PASS" (CCTP Stellar-side interface)
```

> `node_modules/` is gitignored. Network is required (npm registry + Horizon testnet + friendbot).

---

## 10. ✅ Instawards sprint (started 25.06.2026) — live service + e2e claim

The 30-day SOW ([INSTAWARDS_SOW.md](INSTAWARDS_SOW.md)) integrates the proven spikes into one live flow. Status per deliverable — see [EVIDENCE.md](EVIDENCE.md) for the reviewer-facing package:

- **D1 — live sponsor service:** now deployed as a single **Cloudflare Worker** at `https://lumenia-sponsor.avakit.workers.dev` (`/health`, `/create-account`, `/feebump`, plus the post-sprint `/send-link` `/sweep` `/faucet` `/demo-link` `/events` `/waitlist` `/feedback` and v2/recovery endpoints); env hot-key signer; fee cap; per-IP + per-account rate limiting, **durable across instances** (Upstash Redis, `KV_REST_API_URL/TOKEN`; in-memory fallback). Proven live: 12 concurrent `/create-account` for one account → exactly 5×200 (cap) + 7×429. (The Vercel esbuild-CJS deploy is a deprecated 12-fn fallback — the move was forced by Vercel Hobby's 12-function cap once recovery pushed the count to 15.)
- **D2 — end-to-end walletless claim:** ✅ **binary metric MET.** A real browser tapped a claim link on `https://lumenia-chi.vercel.app`, the sponsor created a 0-XLM account + USDC trustline, and the fee-bumped claim landed **20 USDC with the recipient holding 0 XLM** — tx `b9ef1844c6ca2df732648b965a2f991ba0197643057b2c9e2a60ab52c3e23746` (fee paid by the sponsor; verify on stellar.expert).
- **D3 — anti-drain, wired and tested:** the validator (`apps/sponsor/src/lib/anti-drain.ts`, hardened to **strict-by-default**) gates every live `/feebump`. **44/44** unit tests (18 claim + 7 send + 12 sweep + 4 op-sequence + 3 golden-policy) + **6/6** integration tests (happy claim / happy send / drain rejection / rate-limit 429 over real HTTP); a live drain attempt against the deployed endpoint returns `400 — "op 'payment' sourced from sponsor (drain attempt)"`. Three separate tight policies (CLAIM / SEND / SWEEP); the claim allowlist is never widened. Write-up: [ANTI_DRAIN.md](ANTI_DRAIN.md).
- **Web claim UI:** value-first page (amount before any credential; bearer key in the `#fragment`, never sent to a server), on-screen explorer tx link after the claim, and the delegated cash-out **placeholder** (disabled "Spend with a card / Convert to Turkish lira" — a licensed provider converts, Lumenia never does; SOW §4.1 note).
- **Evidence:** [EVIDENCE.md](EVIDENCE.md) + the test-output capture `evidence/tests-25-25-and-6-6.png`.
- **Still open (W4):** the 60-second demo video (user-recorded).

---

## 11. ✅ Pre-mainnet hardening pass on the v2 escrow contract (2026-07-25)

A hardening pass on `contracts/lumen-drop` ahead of any mainnet consideration. **It is not an audit** —
a static-analysis, property-test, fuzz and mutation-testing pass is complete; **a professional audit is
pending**. Contract details: [contracts/lumen-drop/README.md](contracts/lumen-drop/README.md) ·
posture: [SECURITY.md](SECURITY.md).

**Contract changes**

- **soroban-sdk 22 → 26.1**; events migrated to typed `#[contractevent]` structs (same topic layout).
- The **three static-analysis findings fixed** — checked arithmetic (×2) and no `unwrap` on the pinned
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
| Contract tests (unit + property-based) | **11 → 29**, covering a written **14-invariant** specification |
| Mutation testing (`cargo mutants`) | 58 mutants — **51 caught**, 1 missed (a deliberately redundant defense-in-depth guard, documented in the source), 6 unviable |
| Coverage | **99.16%** lines overall (95.2% on the contract library) |
| CoinFabrik Scout | **0 findings** (was 2 Critical + 1 Medium) |
| Strict clippy / cargo-deny / cargo-geiger | 0 warnings · ok · **0 `unsafe`** in the contract crate |
| cargo-audit | clean apart from one unmaintained-crate advisory (`paste`, transitive); cargo-vet baseline established |
| Fuzzing | a `cargo-fuzz` **solvency** target runs in CI on Linux (it cannot link on macOS); the same invariant also runs as a property test everywhere |

**Testnet deployment.** Current contract **`CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S`**
(USDC SAC `CDUL6GQBQKJYG26YZDJHTZF7G73EKUAWA3LTPK7LXODHPCUPK5AU76KF`), wasm sha256
`38941538b964af2110a6fd2fae4c1c3de2ff6585ef0da5d1a59de2ce29edec6a` (21,323 bytes; stellar CLI 25.2.0,
rustc 1.96.0, target `wasm32v1-none`). It supersedes `CDYEDHBPMDOOZSJGB2Z6JVK7GS3S5CWNXNGTEPMJFS25TAWSYHTXA2RF`
(the original) and `CAKEJAGCATVMJB6CMB6LM736DHUJ37YOTOER23SWRNDHPLTU2ZJUDIAB` (an interim hardened build).
**Production now points at this contract for all NEW escrow**, while still reading and exiting drops held
by the superseded ones — see "Legacy-contract fallback" below.

**Proofs re-run against the new contract** (real testnet transactions): escrow proof **7/7**, relayer
proof **5/5**, and a **new governance proof 10/10** (a non-owner can neither pause nor upgrade; pausing
blocks new deposits while a claim of an already-escrowed drop still succeeds; an owner upgrade leaves a
pre-upgrade drop claimable). Off-chain: anti-drain **44/44**, sponsor integration **6/6**, KMS-signer
**13/13**. See [EVIDENCE.md](EVIDENCE.md).

**Sponsor hardening.** An **AWS-KMS Ed25519 signer** is code-complete behind the existing signer
interface with **13/13** offline tests (including byte-parity with the SDK's own signing) — **live AWS
provisioning has not happened**, so the deployed service still uses an environment key. A **kill-switch**
can halt every value-moving endpoint. A key-custody runbook exists (`ops/RUNBOOK_SPONSOR_KEY.md`).

**Canary caps** (`apps/sponsor/src/lib/caps.ts`) — a hard ceiling on the escrow the sponsor will
facilitate, on **both** escrow-creating paths (`/send-link` for v1 and `/v2-deposit` for v2):

- **Per-drop cap** — enforced locally with no network call, so an outage can never disable it.
- **Per-day cap** — a rolling UTC-day total across all senders, kept in the same Upstash store as the
  rate limiter, using an **atomic `INCRBY` reserve-then-check** so concurrent requests cannot slip
  through a read-then-write gap. A rejected request does not consume the day's budget, and a *failed*
  transaction calls `release()` to hand its reservation back.
- **Store outage** is a deliberate choice: the default is **fail open** (the per-drop cap and the rate
  limits still bound the damage); `CAPS_FAIL_CLOSED=1` flips it to fail closed — recommended for mainnet.
- Amounts are read **from the transaction XDR** (the Claimable Balance amount for v1, `deposit`'s second
  argument for v2), i.e. from what the ledger will actually execute, not from a client-supplied field.
- Config: `MAX_DROP_USDC` / `MAX_DAY_USDC` / `CAPS_FAIL_CLOSED`. Testnet defaults are **100 / 1000 USDC**
  (set in `wrangler.toml`); mainnet should start at **20 / 500** with fail-closed.
- **Tests: 28/28 offline** — `pnpm --filter @lumenia/sponsor test:caps` (boundaries, day rollover,
  reserve/release, both outage behaviours, and a malformed env value falling back to the default rather
  than to unlimited).

**Legacy-contract fallback (the migration safety net).** Production points at the hardened escrow for all
NEW escrow while still **reading and exiting** drops held by superseded contracts — a drop can only ever
be released by the contract holding it, so a naive repoint would have silently broken every claim link
already sent.

- Sponsor: a `lumendropLegacyContracts` config (`LUMENDROP_LEGACY_CONTRACTS`); `/v2-claim` accepts an
  optional `contract`, `/v2-reclaim` validates the inner transaction's target, and both go through one
  `exitContract()` allowlist. **`/v2-deposit` is unchanged** — new escrow only ever enters the current
  contract.
- Web (`apps/web/lib/lumendrop.ts`): `resolveDropContract()` finds which escrow holds a link (`get_drop` /
  `get_pool`); `claimV2` + `reclaimV2` use it and `readDrop` reads across all of them. This ordering is
  load-bearing: the signed claim message **binds the contract address**, so reading a drop from the wrong
  contract would produce a signature the escrow rejects — resolution has to happen first.
- Superseded ids currently carried: `CDYEDHBPMDOOZSJGB2Z6JVK7GS3S5CWNXNGTEPMJFS25TAWSYHTXA2RF` (the
  original) and `CAKEJAGCATVMJB6CMB6LM736DHUJ37YOTOER23SWRNDHPLTU2ZJUDIAB` (the interim hardened build).
  An id can be dropped from the list once its drops have all expired and been reclaimed — a drop lives at
  most 7 days.
- **Proven on testnet 9/9** with real transactions — `pnpm --filter @lumenia/sponsor test:legacy`: a drop
  in the superseded contract claims through the relayer; a drop in the current contract claims with no
  `contract` argument; a foreign contract id is rejected **before any network spend**; and a `/v2-deposit`
  into a superseded contract is rejected ("wrong contract").

**Watchdog** (`apps/sponsor/src/lib/watchdog.ts`) — monitoring that actually runs. OpenZeppelin Monitor
needs a separate always-on host we do not operate, so the tripwire ships as a **Cloudflare Cron Trigger
every 15 minutes** on the Worker we already run. Three checks:

- **Sponsor float** below `SPONSOR_MIN_XLM` (default 50), or the account unreadable.
- **Sponsor-SOURCED value** — any `payment` / `path_payment_*` / `account_merge` / offer sourced by the
  sponsor. The sponsor only creates accounts and pays fees, so one of these is the signature of a stolen key.
- **Escrow governance** — `paused` / `unpaused` / ownership events, **and** the deployed wasm hash. The
  wasm check exists because an **`upgrade` emits no event** (the OpenZeppelin implementation just calls
  `update_current_contract_wasm`), so event-watching alone would miss the most serious possible action.
  The expected hash is pinned in `LUMENDROP_WASM_HASH` (currently `38941538…ec6a`) — it must be updated on
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
a middleware bypass and SSRF in Server Actions); the dependency audit is now clean.

**CI.** Every push now runs strict clippy, the contract test suite, `cargo-audit`, `cargo-deny` and a
**90% line-coverage gate**; a weekly workflow runs Scout, OpenZeppelin's `soroban-scanner`, fuzzing and
mutation testing.
