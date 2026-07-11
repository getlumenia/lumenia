# PROGRESS — What Has Concretely Been Built So Far

This file records **only the work that has actually been done** (not plans or decisions — those live in [README.md](README.md) and [stack.md](stack.md)). The next agent reads this to see "what really exists." Be honest about the line between *proven* and *unverified* (the §6 table is the single source of truth for that).

Last updated: 2026-07-11 · Network: **testnet** · No real money used.

> **Instawards sprint (25.06 → ~24.07): see §10** — the live sponsor service, the
> end-to-end browser claim (binary metric MET on-chain) and the hardened anti-drain
> (18/18 + 5/5) supersede the pre-award state below where they conflict.

> Naming note: the product is **Lumenia**; packages are `@lumenia/*`. The working directory is historically named `faceid-wallet` (cosmetic). Stelvin is a **separate, independent project** — not part of Lumenia and not used as its credential.

> "Personas" (Tyler/Elliot/Justin/Nicole/Kaan/Bri) are an **adversarial AI review method**, not a team of people — see [stack.md](stack.md).

---

## 1. Documentation (written, English)

| File | What |
|---|---|
| [README.md](README.md) | Comprehensive project documentation — problem/solution/flows + 8 architecture decisions and **why**, tech stack, roadmap, risks, competitors. |
| [stack.md](stack.md) | Pinned tech stack + project risk table (R1–R10) + 6 persona reviews. |
| [AGENT_GUIDE.md](AGENT_GUIDE.md) | Grant context for the next agent + locked decisions + upcoming work. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architecture-decision workspace (create-architecture workflow; Step 1 done). |
| [POSITIONING.md](POSITIONING.md) | Product-market fit & positioning recommendation (remittance wedge → wallet; SCF→VC). |
| [OFF_RAMP_VERIFICATION.md](OFF_RAMP_VERIFICATION.md) | Executable off-ramp plan (CCTP testnet spike [ME] + KAST/Binance real-world checks [YOU]). |
| Memory note | `~/.claude/projects/.../memory/lumenia-project.md` (+ MEMORY.md index) — persistent cross-session context. |

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
│   └── sponsor/
│       ├── package.json                 # @lumenia/sponsor — stellar-sdk only (ESM; recovery deps dropped)
│       ├── tsconfig.json
│       ├── README.md                    # live service layout + module-system gotchas
│       └── src/
│           ├── spike1-sponsored-claim.ts   # ✅ Spike #1  — sponsored 0-XLM claim economics
│           ├── spike1b-kms-rawsign.ts      # ✅ Spike #1b — external raw Ed25519 → DecoratedSignature
│           ├── spike1c-wire-parity.ts      # ✅ Spike #1c — web→sponsor XDR wire-parity + fee-bump
│           └── test-antidrain.ts           # ✅ anti-drain validator tests (now 18/18 — §10)
└── packages/
    └── shared/
        ├── package.json                 # @lumenia/shared
        └── src/index.ts                 # claim-secret + asset helpers + types (validator moved to apps/sponsor — §10)
```

**Pinned versions:** `@stellar/stellar-sdk@16.0.0` (exact), `next@16.2.9`, `react@19.2.0`, `serwist@9.5.11` + `@serwist/turbopack@9.5.11`, `@simplewebauthn/{browser@13.3.0,server@13.3.1}`, `@stellar/typescript-wallet-sdk@3.0.1`, `argon2@^0.41.1`, `tsx@^4.19`.

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

## 4b. ✅ Anti-drain validator hardening + tests (14/14 → 18/18, see §10)

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
| Anti-drain validator rejects reserve/principal drain vectors | ✅ PROVEN (**18/18** unit + **5/5** integration tests; gates the live `/feebump` — §10) |
| Sponsor key behind external raw-Ed25519 signer (KMS path) | ✅ PROVEN mechanically (Spike #1b); the deployed testnet service uses an env hot-key (SOW scope) |
| web→sponsor XDR wire-parity + fee-bump of re-parsed tx | ✅ PROVEN (Spike #1c + live browser claim — §10) |
| **Live sponsor service + end-to-end walletless browser claim** | ✅ **PROVEN on-chain** (§10: tx `b9ef1844…` — 20 USDC landed, 0 XLM held, sponsor paid the fee) |
| Fee-abuse / rate-limit economic defense | ✅ PROVEN live — durable cross-instance 429 on the deployed service (Upstash store; §10) + integration test |
| 🔑 Recipient can turn Stellar-USDC into spendable TRY (off-ramp) | ⚠️ PATHS IDENTIFIED, real-world unconfirmed. **CCTP V2 is live on Stellar testnet+mainnet** (bridge leg is **testnet-testable now**, no money/KYC). Two **direct** Stellar-USDC exits need no bridge: **KAST card** (TRY spend) and **Binance Global→Binance TR→IBAN**. MASAK: ~$3k/day, 72h first withdrawal. Official anchor directory (anchors.stellar.org) checked 2026-06-18: TR anchors = Banxa/BiLira/Onramp.money/Digibank/Arf, but **Banxa rejects Stellar-USDC** (XLM buy-only) and **no anchor offers a direct TRY off-ramp for Stellar-USDC** — Banxa/BiLira are BD leads ("accept USDC on Stellar?"), not a ready path. Plan: [OFF_RAMP_VERIFICATION.md](OFF_RAMP_VERIFICATION.md) — Spike #4 (CCTP testnet) = [ME]; KAST/Binance real-account checks = [YOU]. |
| WebAuthn PRF round-trip on real devices (Spike #2) | ❌ UNVERIFIED (needs hardware); Argon2id is the mandatory floor |
| WhatsApp webview claim + escape-to-browser + Argon2id (Spike #3) | ❌ UNVERIFIED (needs hardware); architecture researched (value-first + escape-to-browser) |
| Serwist + Turbopack PWA service worker | ❌ UNVERIFIED; webpack fallback still supported in Next 16 |

---

## 7. Research completed (off-code, June 2026)

Six deep research briefs were produced to de-risk the persona-flagged unknowns. Headlines:

- **Off-ramp:** No Turkish CASP confirmed to accept USDC on the *Stellar* network. **Mitigation:** CCTP is live on Stellar (~May 2026) → bridge Stellar-USDC to a chain Turkish CASPs accept; or a USDC-funded card (RedotPay/KAST). MASAK caps: ~$3k/day, 72h first withdrawal.
- **WhatsApp webview:** passkeys **cannot** be created in WhatsApp's webview. **Mitigation:** value-first (show the money before any credential) + escape-to-browser (Android `intent://` reliable; iOS "Open in Safari" best-effort) + Argon2id password fallback. Reframe the promise to "see + claim in ~30s," not "passkey in 30s."
- **KMS:** AWS KMS does Ed25519 raw signing since 2025-11-07 → first-class fit (proven in Spike #1b). Turnkey/Fireblocks are alternatives if a policy engine/MPC is needed later.
- **PRF/Argon2id:** Argon2id-primary + PRF-as-fast-unlock is correct; envelope encryption (one DEK, two wraps); one mental model — "password is the master key; Face ID is a shortcut."
- **Competitors:** the real alternative is the recipient's own bank app (FAST/Kolay Adres — instant, free, domestic). Lumenia wins on the **cross-border EU→TR leg + open shareable link**. LOBSTR already does email/phone claim (close threat); Morse (ex-Sling) ships the same link UX (MiCA-licensed, Turkey closed-beta).
- **Sybil/economics:** ~$0.44 per onboarded recipient, mostly **reclaimable** reserves (1.5 XLM, CAP-33). Make the headline metric "unique-human + retained second action," not raw addresses.

---

## 8. NOT DONE YET (for the next agent)

- ✅ ~~`apps/web` skeleton~~ → **built, deployed and wired** (value-first claim page → live sponsor; §10). Recovery/passkeys, off-ramp adapters and the Serwist SW remain stubs (SOW out-of-scope).
- ✅ ~~`apps/sponsor` HTTP service~~ → **live on Vercel** with anti-drain gate, fee cap and per-IP/per-account rate limit (§10). Still open from the old sub-list: the KMS call (env hot-key for the sprint), and Tyler's exact op-sequence matcher (the live `/feebump` policy pins `maxOps: 1`, which covers the claim path).
- ❌ **Spike #2** (WebAuthn PRF round-trip on a real device) — requires hardware.
- ❌ **Spike #3** (WhatsApp webview claim + escape-to-browser + Argon2id fallback) — requires hardware.
- ❌ 🔑 **CASP / off-ramp confirmation** — still the highest-leverage off-code task; research narrowed it to "confirm a CCTP-bridged or card cash-out actually works for a TR recipient."
- ❌ Off-chain split ledger, request (SEP-7) flow, DB schema, recovery (PRF/Argon2id) implementation.

---

## 9. How to run (summary)

```bash
# at the repo root
pnpm install        # entire workspace
pnpm spike1         # Spike #1   → testnet → "✅ SPIKE #1 PASS"
pnpm test:antidrain # validator  → "✅ ANTI-DRAIN TESTS PASS (18/18)" (no network)
pnpm --filter @lumenia/sponsor test:integration  # → "✅ INTEGRATION TESTS PASS (5/5)" (testnet)
pnpm spike1b        # Spike #1b  → testnet → "✅ SPIKE #1b PASS"
pnpm spike1c        # Spike #1c  → testnet → "✅ SPIKE #1c PASS"
pnpm spike4         # Spike #4   → testnet → "✅ SPIKE #4 PASS" (CCTP Stellar-side interface)
```

> `node_modules/` is gitignored. Network is required (npm registry + Horizon testnet + friendbot).

---

## 10. ✅ Instawards sprint (started 25.06.2026) — live service + e2e claim

The 30-day SOW ([INSTAWARDS_SOW.md](INSTAWARDS_SOW.md)) integrates the proven spikes into one live flow. Status per deliverable — see [EVIDENCE.md](EVIDENCE.md) for the reviewer-facing package:

- **D1 — live sponsor service:** deployed at `https://lumenia-sponsor.vercel.app` (`/health`, `/create-account`, `/feebump`) as esbuild-bundled CJS functions; env hot-key signer; fee cap; per-IP + per-account rate limiting on both POST endpoints, **durable across serverless instances** (Upstash Redis via Vercel Marketplace, `KV_REST_API_URL/TOKEN`; in-memory fallback). Proven live 2026-07-11: 12 concurrent `/create-account` for one account → exactly 5×200 (cap) + 7×429.
- **D2 — end-to-end walletless claim:** ✅ **binary metric MET.** A real browser tapped a claim link on `https://lumenia-chi.vercel.app`, the sponsor created a 0-XLM account + USDC trustline, and the fee-bumped claim landed **20 USDC with the recipient holding 0 XLM** — tx `b9ef1844c6ca2df732648b965a2f991ba0197643057b2c9e2a60ab52c3e23746` (fee paid by the sponsor; verify on stellar.expert).
- **D3 — anti-drain, wired and tested:** the validator (`apps/sponsor/src/lib/anti-drain.ts`, moved out of `packages/shared` for the Vercel deploy boundary, hardened to **strict-by-default**) gates every live `/feebump`. **18/18** unit tests + **5/5** integration tests (happy claim / drain rejection / rate-limit 429 over real HTTP); a live drain attempt against the deployed endpoint returns `400 — "op 'payment' sourced from sponsor (drain attempt)"`. Write-up: [ANTI_DRAIN.md](ANTI_DRAIN.md).
- **Web claim UI:** value-first page (amount before any credential; bearer key in the `#fragment`, never sent to a server), on-screen explorer tx link after the claim, and the delegated cash-out **placeholder** (disabled "Kartla harca / Türk lirasına çevir" — a licensed provider converts, Lumenia never does; SOW §4.1 note).
- **Evidence:** [EVIDENCE.md](EVIDENCE.md) + the test-output capture `evidence/tests-18-18-and-5-5.png`.
- **Still open (W4):** the 60-second demo video (user-recorded).
