# PROGRESS — What Has Concretely Been Built So Far

This file records **only the work that has actually been done** (not plans or decisions — those live in [README.md](README.md) and [stack.md](stack.md)). The next agent reads this to see "what really exists." Be honest about the line between *proven* and *unverified* (the §6 table is the single source of truth for that).

Last updated: 2026-06-17 · Network: **testnet** · No real money used.

> Naming note: the product is **Lumenia**; packages are `@lumenia/*`. The working directory is historically named `faceid-wallet` and some text still references the earlier `stelvin` project — these are cosmetic and being cleaned up.

> "Personas" (Tyler/Elliot/Justin/Nicole/Kaan/Bri) are an **adversarial AI review method**, not a team of people — see [stack.md](stack.md).

---

## 1. Documentation (written, English)

| File | What |
|---|---|
| [README.md](README.md) | Comprehensive project documentation — problem/solution/flows + 8 architecture decisions and **why**, tech stack, roadmap, risks, competitors. |
| [stack.md](stack.md) | Pinned tech stack + project risk table (R1–R10) + 6 persona reviews. |
| [AGENT_GUIDE.md](AGENT_GUIDE.md) | Grant context for the next agent + locked decisions + upcoming work. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architecture-decision workspace (create-architecture workflow; Step 1 done). |
| Memory note | `~/.claude/projects/.../memory/lumenia-project.md` (+ MEMORY.md index) — persistent cross-session context. |

---

## 2. Monorepo skeleton (set up)

pnpm workspaces. `pnpm install` ran successfully (including the argon2 native build; Node 24, pnpm 9.12).

```
lumenia/  (working dir: faceid-wallet)
├── package.json                         # workspace root, scripts (web:dev, sponsor:dev, spike1, test:antidrain, spike1b, spike1c)
├── pnpm-workspace.yaml                  # apps/* + packages/*
├── apps/
│   ├── web/
│   │   ├── package.json                 # @lumenia/web — Next 16.2.9, Serwist 9.5.11, stellar-sdk 16.0.0 (PINNED)
│   │   └── README.md                    # web responsibilities (no Next app files YET)
│   └── sponsor/
│       ├── package.json                 # @lumenia/sponsor — stellar-sdk, simplewebauthn/server, argon2 (CJS!)
│       ├── tsconfig.json
│       ├── README.md                    # spikes + stellar-sdk@16/tsx CJS finding
│       └── src/
│           ├── spike1-sponsored-claim.ts   # ✅ Spike #1  — sponsored 0-XLM claim economics
│           ├── spike1b-kms-rawsign.ts      # ✅ Spike #1b — external raw Ed25519 → DecoratedSignature
│           ├── spike1c-wire-parity.ts      # ✅ Spike #1c — web→sponsor XDR wire-parity + fee-bump
│           └── test-antidrain.ts           # ✅ anti-drain validator tests (14/14)
└── packages/
    └── shared/
        ├── package.json                 # @lumenia/shared
        └── src/index.ts                 # hardened anti-drain validator + claim-secret + asset helpers + types
```

**Pinned versions:** `@stellar/stellar-sdk@16.0.0` (exact), `next@16.2.9`, `react@19.2.0`, `serwist@9.5.11` + `@serwist/turbopack@9.5.11`, `@simplewebauthn/{browser@13.3.0,server@13.3.1}`, `@stellar/typescript-wallet-sdk@3.0.1`, `argon2@^0.41.1`, `tsx@^4.19`.

---

## 3. `packages/shared/src/index.ts` (written, hardened)

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

> ⚠️ **Correction (don't overclaim):** Spike #1 signs with a **local in-memory `Keypair`** (`tx.sign`) in a **single process**. It does **NOT** prove (a) that the sponsor key can live in an HSM/KMS, or (b) that the inner tx survives the web→sponsor wire, or (c) fee-abuse/economic anti-drain. Those are covered by §4b–§4d below; what remains open is in §6.

## 4b. ✅ Anti-drain validator hardening + tests (14/14)

**File:** [apps/sponsor/src/test-antidrain.ts](apps/sponsor/src/test-antidrain.ts) · **Run:** `pnpm test:antidrain` · no network needed.

Built the legit claim shape + 11 drain vectors and asserted the canonical validator's verdict. **Result: `✅ ANTI-DRAIN TESTS PASS (14/14)`.** Rejected vectors include: `payment`/`changeTrust` sourced by the sponsor, `createAccount(startingBalance>0)`, `payment` to a non-allow-listed destination, wrong `balanceId`, wrong `changeTrust` asset, wrong tx source, disallowed op type, too many ops, `createAccount` destination ≠ recipient, `beginSponsoring.sponsoredId` ≠ recipient.

## 4c. ✅ Spike #1b — external raw Ed25519 → Stellar DecoratedSignature (TESTNET)

**File:** [apps/sponsor/src/spike1b-kms-rawsign.ts](apps/sponsor/src/spike1b-kms-rawsign.ts) · **Run:** `pnpm spike1b`

Simulates an HSM/KMS with Node `crypto` (pure Ed25519 over the tx hash, **not** stellar-sdk's signer), builds the `DecoratedSignature` by hand (hint = last 4 bytes of the public key), and submits to testnet. **Result: `✅ SPIKE #1b PASS`** — the network accepted the externally-signed tx, and the hand-built `DecoratedSignature` is **byte-identical** to `kp.signDecorated()`. Research confirms AWS KMS supports Ed25519 raw signing since 2025-11-07 (`ECC_NIST_EDWARDS25519` / `ED25519_SHA_512` / `MessageType=RAW`), so swapping the Node-crypto stand-in for a `kms.sign(...)` call is a drop-in. **This closes the KMS half of R3.**

## 4d. ✅ Spike #1c — web→sponsor XDR wire-parity + fee-bump (TESTNET)

**File:** [apps/sponsor/src/spike1c-wire-parity.ts](apps/sponsor/src/spike1c-wire-parity.ts) · **Run:** `pnpm spike1c`

Inserts the real wire boundary: WEB builds + signs the claim inner tx → `toXDR()` (base64) → SPONSOR `fromXDR()` → asserts **byte-for-byte hash/XDR parity** → runs the **canonical** shared validator → fee-bumps the **re-parsed** tx → submits. **Result: `✅ SPIKE #1c PASS`** — wire round-trip byte-identical, validator accepts the claim, fee-bump of the re-parsed tx settles, recipient ends with 20 USDC / 0 XLM. **This closes the wire-parity concern.**

---

## 5. 🔎 Day-1 finding caught (mempool-class)

`@stellar/stellar-sdk@16` ESM build blows up under `tsx`/Node ESM on its internal `@stellar/js-xdr` import (`does not provide an export named 'config'`). **Fix:** run `apps/sponsor` as **CommonJS** (no `"type": "module"`). Web (Next.js bundler) unaffected. Keep the production sponsor on CJS/bundle. (Also in [apps/sponsor/README.md](apps/sponsor/README.md).)

---

## 6. Proven vs. unverified (the honest line)

| Item | Status |
|---|---|
| Sponsored 0-XLM onboarding + fee-bumped claim economics | ✅ PROVEN (Spike #1, testnet) |
| Anti-drain validator rejects reserve/principal drain vectors | ✅ PROVEN (14/14 tests) |
| Sponsor key behind external raw-Ed25519 signer (KMS path) | ✅ PROVEN mechanically (Spike #1b); real AWS KMS call not yet wired |
| web→sponsor XDR wire-parity + fee-bump of re-parsed tx | ✅ PROVEN (Spike #1c) |
| Fee-abuse / rate-limit economic defense | ⚠️ DESIGNED, not yet built (needs the HTTP service + rate-limit) |
| 🔑 Turkish CASP accepts USDC on **Stellar** (off-ramp) | ❌ UNVERIFIED — research says no native CASP support today; mitigation path = **CCTP on Stellar (live ~May 2026)** to bridge to an accepted chain, or a USDC card. Still must be confirmed before promising cash-out. |
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

- ❌ `apps/web` Next.js app files (manifest, claim page, OG route, Serwist SW) — only package.json + README exist.
- ❌ `apps/sponsor/src/index.ts` real HTTP service (`/create-account`, `/feebump`) with rate-limit + the KMS call wired in. When building it, also close the items below.
  - **Fee-abuse / rate-limit (Elliot):** the anti-drain validator guards the reserve/principal but NOT fee-grind; add per-account/per-IP rate-limit + fee caps in the HTTP layer.
  - **Exact-shape matcher (Tyler):** the validator allows any subset/permutation of the allowed ops; add an expected op-sequence/count template (and watch for double-`payment` once `allowedPaymentDestinations` is enabled in prod).
  - **Published-package parity (Elliot):** the spikes import the validator via a relative path; the HTTP service must import the built `@lumenia/shared` package and a test must prove dual-package (ESM web / CJS sponsor) parity, incl. `Asset.equals`/`instanceof` after bundling.
- ❌ **Spike #2** (WebAuthn PRF round-trip on a real device) — requires hardware.
- ❌ **Spike #3** (WhatsApp webview claim + escape-to-browser + Argon2id fallback) — requires hardware.
- ❌ 🔑 **CASP / off-ramp confirmation** — still the highest-leverage off-code task; research narrowed it to "confirm a CCTP-bridged or card cash-out actually works for a TR recipient."
- ❌ Off-chain split ledger, request (SEP-7) flow, DB schema, recovery (PRF/Argon2id) implementation.

---

## 9. How to run (summary)

```bash
# at the repo root
pnpm install        # entire workspace; includes the argon2 native build
pnpm spike1         # Spike #1   → testnet → "✅ SPIKE #1 PASS"
pnpm test:antidrain # validator  → "✅ ANTI-DRAIN TESTS PASS (14/14)" (no network)
pnpm spike1b        # Spike #1b  → testnet → "✅ SPIKE #1b PASS"
pnpm spike1c        # Spike #1c  → testnet → "✅ SPIKE #1c PASS"
```

> `node_modules/` is gitignored. Network is required (npm registry + Horizon testnet + friendbot).
