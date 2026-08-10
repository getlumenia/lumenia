# Lumenia

[![CI](https://github.com/getlumenia/lumenia/actions/workflows/ci.yml/badge.svg)](https://github.com/getlumenia/lumenia/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-6E5FCE.svg)](LICENSE)
![Network: Stellar testnet](https://img.shields.io/badge/network-Stellar%20testnet-6E5FCE.svg)

> **Send and request money by link — the recipient claims it walletless, seedless, and the recipient pays no gas, in a target ~30 seconds.**
> On Stellar, with native USDC. Every claim creates a new funded Stellar account.

Lumenia — from Stellar's lumens: light (value) that travels by link. It is a consumer payments app that lets **an ordinary person use Stellar's invisible infrastructure (anchors, USDC, sponsorship) just by tapping a WhatsApp link.** No one needs to know anything about crypto.

**Context:** Built for [SCF Build (Integration Track)](https://stellar.gitbook.io/scf-handbook) + Instawards (Stellar ambassador, 30-day MVP).

## Quickstart

Everything below runs on the Stellar **testnet** — no real money. (The product itself is testnet
too; the one exception is a deliberately capped **mainnet canary** used as on-chain evidence —
see [Security posture](#security-posture) further down.)

```bash
pnpm install
pnpm test:antidrain   # anti-drain validator (60/60, offline)
pnpm spike1           # sponsored 0-XLM claim economics (testnet)
```

Full setup and environment variables are in [§7 Getting started](#7-getting-started).
New here? See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Table of contents
1. [Problem](#1-problem)
2. [Solution](#2-solution)
3. [How it works](#3-how-it-works)
4. [Architectural decisions and why](#4-architectural-decisions-and-why)
5. [Tech stack](#5-tech-stack)
6. [Project structure](#6-project-structure)
7. [Getting started](#7-getting-started)
8. [Day-1 spikes](#8-day-1-spikes)
9. [Known risks](#9-known-risks)
10. [Roadmap](#10-roadmap)
11. [Why Stellar](#11-why-stellar)
12. [Competitors](#12-competitors)

---

## 1. Problem

In crypto, **even to receive money** you first have to set up a wallet, save a seed phrase, and hold a token for the transaction fee (gas). For a normal person this is an absurd wall. Telling someone "I'll send you 20 dollars" means putting the other party through a half-hour crypto setup ordeal.

The result: stablecoins (USDC) are cheap and fast but **can't reach ordinary people's hands.** The pain isn't in "sending money," it's in **"the recipient being able to receive the money without knowing anything."**

Especially in emerging markets (Turkey and the Turkish diaspora), people want to hold dollars, send money home, and split group expenses — but all the tools require either crypto literacy or banking friction.

---

## 2. Solution

Lumenia offers two core flows:

- **Send by link (hero flow):** You send someone a link → the recipient taps, confirms with their face (biometric) → USDC is in their pocket in a target ~30 seconds. They don't set up a wallet, never see a seed phrase, and **the recipient pays no gas.**
- **Request money (differentiation + retention layer):** You request money from someone → a link goes to the other party → they tap it and pay → and now **they too have a wallet + a balance.**

At no point does the user feel a "crypto" step. They think in lira; behind the scenes it settles in USDC.

**What it is NOT:** Not a savings/interest product (no yield), not a bank, not an exchange. Just **person-to-person money movement.**

---

## 3. How it works

### 3.1 Claim flow (sending by link)

```
Sender                           Stellar Ledger                 Recipient (walletless)
   │                                   │                              │
   │ 1. Creates a Claimable Balance    │                              │
   │    with USDC (dual predicate:     │                              │
   │    recipient + reclaim-after-      │                              │
   │    7-days)                         │                              │
   ├──────────────────────────────────▶│                              │
   │                                   │                              │
   │ 2. Link (bearer claim-key inside) │  ── WhatsApp ──▶             │
   │                                   │                              │
   │                                   │   3. Link opens, biometric   │
   │                                   │      confirm, keypair on     │
   │                                   │      device                  │
   │                                   │◀─────────────────────────────┤
   │                                   │                              │
   │            4. SPONSOR SERVICE atomic sandwich (fee-bump):        │
   │            beginSponsoring → createAccount(0 XLM) →              │
   │            changeTrust(USDC) → claimClaimableBalance →           │
   │            endSponsoring                                         │
   │                                   │─────────────────────────────▶│
   │                                   │        USDC in pocket, 0 XLM │
```

**Important:** The money never sits on our server. **The Stellar ledger escrows it** (Claimable Balance). The sponsor service only pays for account creation + the transaction fee; it can never touch the user's money.

### 3.2 Request money flow

On Stellar there is **no pull/debit (automatic collection).** "Request money" = a **push-only request**: the asker generates a request link carrying the amount, their name, and a nonce (no custody, no credential); the payer opens it, sees the amount, and **pushes** the money back — a first-time asker gets a normal bearer claim link in return, while a returning asker's link also carries her address so the payer's Claimable Balance names her as the claimant. No one can pull money from anyone without their knowledge — this isn't a constraint, it's a **trust feature** ("you won't get a surprise charge").

> **Not SEP-7 (yet):** the shipped v1 deliberately does **not** use a SEP-7 `web+stellar:pay` URI — a first-time asker has no destination account to express, and a SEP-7 URI would drop the sender's reclaim predicate. "Pay from any wallet" via SEP-7 is a later, additive SCF-Integration milestone (v1.5).

### 3.3 Recovery (device change / loss)

> **Scope note (updated 2026-07-22 — recovery is now built on testnet):** a **classic Ed25519 key** is
> generated on-device (IndexedDB keystore, optionally locked with an **Argon2id password**). On top of
> that, a **portable, server-storable zero-knowledge "recovery box"** wraps the seed with that password
> (floor) and/or a **WebAuthn-PRF passkey** (the Face ID upgrade) into AES-256-GCM ciphertext — the
> server holds **only ciphertext it can never open**, so recovery stays strictly non-custodial. Cross-
> device restore = email one-time-code → fetch the sealed box → decrypt locally → the SAME account.
> Real-user rollout is gated on email-channel verification + real-device passkey validation, and a
> pending password-strength/OTP-abuse security pass; the WebAuthn-PRF design below is now the
> implementation, not just a plan. (Guardian/social recovery via a v2 smart account remains future.)

The design (now shipped): keeping a classic Ed25519 key only in browser memory is catastrophic (if the data is wiped, the money is gone). Instead:
- ONE 32-byte seed is wrapped **twice** into **AES-256-GCM** ciphertext — copy A with a key from **Argon2id(password)** (the floor), copy B with a key from a **WebAuthn-PRF passkey** (the Face ID upgrade). The server stores **only ciphertext it can never open**; there is still **no seed-export path.**
- Cross-device restore = an **email one-time code** unlocks fetching the sealed box, which is decrypted locally back into the **same account.** Because the WhatsApp in-app browser blocks passkey creation, the **Argon2id password path is primary**, and PRF is the fast-unlock upgrade offered on a real browser.

---

## 4. Architectural decisions and why

This section is the heart of the project: every major decision and **why** it was made that way. Rationales are detailed in [stack.md](stack.md). Each decision was stress-tested via an adversarial multi-lens AI review: the **technical decisions are locked**, while the **product/strategy decisions remain provisional bets**.

### Decision 1 — Not React Native, but a **web-first PWA**
**Why:** The essence of Lumenia is a **link.** A link opens wherever the user taps it (WhatsApp in-app browser, Safari, Chrome). Saying "go to the App Store first to receive the money" kills the funnel — that's the exact opposite of the "30 seconds, zero setup" promise. Also WebAuthn/passkey is **first-class on the web**, whereas in React Native it's polyfill hell (`createKeypair` blows up in RN, requiring crypto/Buffer shims). A Next.js PWA = a single codebase, both a powerful web app and a mobile app installed via "Add to Home Screen." If a true native app is needed, we move to Expo in v2. **Web-first also keeps the passkey door open for v2.**

### Decision 2 — Not a Soroban smart-account, but **classic Ed25519 (v1)**
**Why:** "A Face ID, seedless wallet" is a UX promise, not a cryptographic one. Keeping a classic Ed25519 key in the device's secure enclave and unlocking it with biometrics is **indistinguishable** from a real passkey in the experience the user lives — and it ships in 30 days. A true passkey smart-account (OpenZeppelin Smart Accounts), on the other hand, requires a factory contract + relayer + Soroban-token balances + RN native modules; SDF's own relayer (Launchtube) was "prototype, no SLA" (SDF is now discontinuing Launchtube — the v2 send path uses the **OpenZeppelin Relayer** instead). **The "Zero XLM" feature already comes from sponsorship, not from the account type** — meaning it's achievable today even with a classic account. Smart-account = v2 (for recovery + multi-device); placing the `RecipientAccount` interface in v1 makes the migration cheap.
> Note: the `passkey-kit` library says in its README "demo only, not audited, do not use to protect anything" → an app that holds money is not built on top of it.
>
> **Status (2026-07-25):** the passkey *smart-account* for identity/recovery/multi-device remains v2/future — but the v2 **Soroban escrow** for the *send* path, **LumenDrop**, is already **built + deployed to testnet** (29 unit + property tests over a written 14-invariant spec, plus a 7/7 escrow, 5/5 relayer and 10/10 governance on-chain proof that the recipient pays no gas) and is now the **default shareable link-send** (late-bound payout; the OpenZeppelin Relayer pays the Soroban fee, so the recipient still pays no gas) and the **SCF Integration centerpiece**, live in the deployed sponsor Worker. The **frozen classic `/c/[id]` Claimable-Balance claim stays v1**, so the app runs a **v1-claim / v2-send hybrid.** The contract is **upgradeable behind an owner** today (upgrade + pause-new-escrow only; no owner path can move escrowed funds; claims and reclaims are never pausable) and is intended to become immutable via a final upgrade that removes the upgrade entrypoint — **after** a professional audit. Mainnet is gated on that audit.

### Decision 3 — Custody: **sender-funded Claimable Balance + sponsor backend**
**Why:** Choosing the right primitive for "let the walletless recipient claim the money" is critical.
- **Claimable Balance** is Stellar's native escrow (it provides at the protocol level what Peanut does on EVM with a smart contract + relayer). With a dual predicate (recipient `unconditional` + sender `reclaim-after-7-days`), **both parties are non-custodial**: the ledger holds the money, not us.
- **But** the CB alone isn't enough: the claiming account must be funded + have a trustline. This is exactly what the **sponsor service** solves — in an atomic sandwich it sponsors the recipient's account and trustline and fee-bumps, and the recipient ends up with **0 XLM.**
- **Why a backend is mandatory:** there is no client-only "magic claim"; someone has to pay the account-creation reserve and the transaction fee. The sponsor key **only pays for create/fund + fee, can never spend principal** → the service stays non-custodial.
- **Rejected alternatives:** a "holding account" where the backend holds USDC = custodial (the thing we avoid). The "deterministic address" (SDP/Meridian) pattern = actually the Soroban smart-wallet path, which we're not taking in v1.

### Decision 4 — Hero flow: **link-send first**, request-money as the differentiation + retention layer
**Why (PM review correction):** Two flows, two jobs. **Link-send is the hero** because it delivers first value fastest — the recipient taps a link and **sees money in a target ~30 seconds**, the shortest path to an "aha" moment on first run. **Request-money is the differentiator + retention layer**, not the first-run hero: even a user with zero balance can initiate a request, the request creates demand that pulls money + a new user onto the network, and crypto universally leaves request-money underbuilt (even Venmo is bad at uneven splits). The retention engine (since yield is forbidden): **the "chase down who owes you" loop** — the strongest organic return hook in P2P. So link-send wins the first run; request-money wins the long game.

### Decision 5 — Corridor: **EU→TR inbound** (off-ramp deferred)
**Why:** Research surfaced a bombshell: **there is no live Stellar-native TRY off-ramp in Turkey.** Cash-out is two-hop (USDC→CEX→TRY), the CEXes' acceptance of Stellar-USDC is unverified, and MASAK imposes a 72h delay + $3k/day cap on the first withdrawal → "instantly spendable" breaks. The solution: **defer the off-ramp in v1**, let USDC circulate internally (1-cohort runway), and **pivot to the leg that works** — EU→TR inbound (diaspora remittance), with MyKobo (EURC/SEPA) the only solid anchor. Same community, reverse direction: now the working leg (the sender) is also the paying/motivated leg. CEX cash-out = a documented "safety valve," not the hero flow.

### Decision 6 — Notifications: **WhatsApp-first**, not SMS
**Why:** Turkey's SMS market is hostile to this use-case: P2P content is banned, and starting April 2026 a non-resident sender can't send an SMS with a URL to a TR number (the whole product is a link!). WhatsApp's penetration in Turkey is very high + utility templates are free within a 24h window. Web push, meanwhile, is for the installed PWA (on iOS, home-screen installation is required).

### Decision 7 — **No-yield, non-custodial** (regulation)
**Why:** SCF legal teams flag three things: returns/yield (securities/deposit risk), tokenized securities, and prediction/betting. Custody also brings money-transmitter classification. That's why Lumenia is strictly non-custodial (ledger escrow) and **never uses a "savings/interest/bank" framing** — only "money movement." We leave the regulated part of money transfer to licensed anchors/CEXes.

### Decision 8 — Take the Stellar Wallet SDK as **infrastructure**, write the core on top
**Why:** The mentor's advice is right — the Wallet SDK wipes out anchor/ramp (SEP-24 interactive + SEP-10 auth + SEP-12 KYC, +SEP-38 quotes; SEP-6 interactive is deprecated) and account/signing boilerplate (the most painful part, which is the real risk on the cash-out side). **But** the SDK does **not** give passkey/smart-wallet or sponsored-claim logic (classic Ed25519). So the SDK handles ~70%; the differentiating 30% (sponsored claim + request-money + link mechanics) is the core we write ourselves with `@stellar/stellar-sdk`.

---

## 5. Tech stack

Full pinned list and rationales: **[stack.md](stack.md)**. Summary:

| Layer | Choice |
|---|---|
| **Frontend** | Next.js 16 PWA + Serwist (`@serwist/turbopack`), `next/og` dynamic claim cards, TypeScript |
| **Identity** | Classic Ed25519 keypair; encrypted recovery with WebAuthn PRF + Argon2id (`@simplewebauthn` 13.x) |
| **Chain** | `@stellar/stellar-sdk@16.0.0` (sponsored-reserve sandwich + fee-bump); `@stellar/typescript-wallet-sdk@3` (SEP flows) |
| **Contract (v2 send)** | `contracts/lumen-drop` — Rust, `soroban-sdk@26.1` + OpenZeppelin Stellar contracts `0.7.2` (Ownable / Pausable / Upgradeable); testnet only |
| **Custody** | Sender-funded Claimable Balance (dual predicate) — ledger escrow, non-custodial |
| **Backend** | Single **Cloudflare Worker** sponsor service (`worker.ts`); sponsor key = env hot-key behind a `SponsorSigner` interface (AWS KMS Ed25519 raw-sign mechanically proven, not yet wired); anti-drain allowlist + rate-limit |
| **State** | **No Postgres** — **Upstash Redis** (rate-limit, waitlist, recovery ciphertext boxes, channel-account leases; in-memory fallback) + everything else **on-chain** (Horizon / Soroban) |
| **Notifications** | **Email via Resend** (interim OTP + notify, owner-gated) + in-app Horizon poll; WhatsApp Business API is a Q1-2027 long-lead item |
| **Asset / Network** | Native Circle USDC · testnet → mainnet |

**Why these versions:** `next-pwa` is dead → Serwist is the standard. `stellar-sdk@16` (not v14) because the `rpc`/sponsorship/fee-bump APIs are the same and v14 is two majors behind for no reason. AWS KMS has done Ed25519 raw-sign since November 2025 → secure custody of the sponsor key is possible.

---

## 6. Project structure

```
lumenia/  (pnpm workspaces)
├── apps/
│   ├── web/         → Next.js 16 PWA (PUBLIC, no secrets) → Vercel, getlumenia.com
│   └── sponsor/     → Cloudflare Worker sponsor service (env hot-key; KMS drop-in later)
│       ├── src/
│       │   ├── worker.ts              → Workers `fetch` entry (reuses lib/* verbatim)
│       │   ├── lib/                   → signer, anti-drain, channels, recovery box
│       │   ├── spike1b-kms-rawsign.ts → AWS KMS Ed25519 raw-sign proof
│       │   ├── spike1c-wire-parity.ts → web→sponsor XDR wire-parity proof
│       │   └── test-antidrain.ts      → anti-drain validator tests
│       └── wrangler.toml              → Worker config (nodejs_compat)
├── contracts/
│   └── lumen-drop/  → v2 Soroban escrow (Rust): late-bound-payout link drops + group drops
│       ├── src/     → lib.rs (contract) + test.rs (unit + invariant property tests)
│       ├── fuzz/    → cargo-fuzz solvency target (runs in CI on Linux)
│       └── README.md→ interface, governance, the 14-invariant spec, tooling
├── packages/
│   └── shared/      → claim-secret / asset helpers + shared types
│                      (web + sponsor cross the wire as XDR, must re-parse byte-identically)
├── stack.md         → pinned tech stack + adversarial review rulings
└── README.md        → this document
```

> Note: the working directory is historically named `faceid-wallet`; the project/monorepo root is `lumenia`.

**Why two separate services:** The sponsor backend holds a hot signing key → it must have its own network boundary and its own deploy cadence (a Cloudflare Worker, deployed independently of the web app); putting it in the same place as the public edge PWA is the wrong blast-radius.

---

## 7. Getting started

> The monorepo is **built and deployed** — the web app ships to Vercel on push (product domain **getlumenia.com**) and the sponsor runs as a Cloudflare Worker (`https://lumenia-sponsor.avakit.workers.dev`); the spikes below still run today (all on testnet except the anti-drain validator test, which runs locally).

```bash
# Requirements: Node 20+, pnpm, a testnet sponsor key
pnpm install

# Day-1 spikes (run today)
pnpm spike1          # sponsor economics: sponsored 0-XLM create + changeTrust + fee-bump + claim (testnet)
pnpm spike1b         # AWS KMS Ed25519 raw-sign proof (testnet)
pnpm spike1c         # web→sponsor XDR wire-parity proof (testnet)
pnpm test:antidrain  # anti-drain validator tests (local)
```

Sponsor Worker vars (`apps/sponsor/wrangler.toml [vars]` + secrets via `wrangler secret put`): `STELLAR_NETWORK=testnet`, `ALLOWED_ORIGIN`, `USDC_ISSUER`, `LUMENDROP_CONTRACT`, plus the sponsor secret and the Upstash/Resend secrets. Web vars: `NEXT_PUBLIC_SPONSOR_URL`, `NEXT_PUBLIC_SITE_URL`, `WEBAUTHN_RP_ID`.

---

## 8. Day-1 spikes

Three gates that must pass before writing any feature code (if one fails, the architecture changes):

1. **Sponsor economics:** on testnet, does a sponsored 0-XLM `createAccount` + `changeTrust` + fee-bump + `claim` with KMS-Ed25519 return `SUCCESS`? Is a malicious inner tx **rejected** (anti-drain)?
2. **PRF round-trip:** on real iOS Safari 18.4+ and Android Chrome, is keygen → PRF → encrypt → store → recover → signature accepted by the network?
3. **WhatsApp flow:** link → OG card render → claim in the WhatsApp in-app browser → does the **Argon2id fallback trigger automatically**?

> 🔑 **The single most critical validation (non-code, 1 afternoon):** Does any Turkish CASP (BTCTurk/Paribu) accept USDC over the **Stellar network**? If not, a bridge step is added to cash-out. The entire corridor decision branches on this — **test it first.**

---

## 9. Known risks

| Risk | Mitigation |
|---|---|
| **Turkey off-ramp broken** (no Turkish CASP confirmed to accept USDC on the *Stellar* network; MASAK ~$3k/day cap + 72h first withdrawal) | Off-ramp framed honestly as a **next-milestone infrastructure bet, not solved**. Mitigation: **CCTP is live on Stellar (~May 2026)** → bridge Stellar-USDC to a chain a TR CASP accepts, or a **USDC-funded card** (RedotPay; note KAST cannot be funded from Stellar-USDC). v1 leans on internal circulation + EU→TR inbound. |
| **WhatsApp webview blocks passkey** | Argon2id primary recovery, PRF upgrade |
| **Sponsor service single choke-point** | **AWS KMS Ed25519 raw-sign is now available (since 2025-11-07), proven mechanically (Spike #1b) and code-complete behind the signer interface (13/13 offline tests, byte-parity with the SDK's own signing) — the live AWS key is not provisioned yet, so the deployed service still uses an env hot-key**; a **kill-switch** can halt every value-moving endpoint; anti-drain validator hardened to op SOURCE+PARAMETER level (**60/60 unit + 6/6 integration tests**, gating the live `/feebump`); web→sponsor XDR **wire-parity proven (Spike #1c + live browser claim)**; plus per-IP/per-account rate-limit + fee cap. |
| **Competitor: Sling Money** ($15M, Solana) | Corridor strategy; being a global competitor; frame Sling as validation |
| **Regulation (MASAK/CASP)** | Strictly non-custodial; leave off-ramp to a licensed CEX; lawyer before mainnet |
| **Serwist + Turbopack** newest combo | Day-1 spike; fallback `--webpack` |

Detailed risk table and the "mempool-class" assumption traps that were caught: [stack.md §2](stack.md).

**Security posture (stated honestly).** The product runs on **testnet**; the only real money is a
deliberately capped **mainnet canary** kept as on-chain evidence, with spend caps, a kill-switch and a
15-minute watchdog around it. Full public mainnet stays gated behind the audit below. For the v2 escrow contract a **static-analysis, property-test, fuzz and mutation-testing pass is complete** (Scout, strict clippy, cargo-audit/deny, 29 unit + invariant property tests, mutation testing) — that is self-assessment, **not** an audit, and **a professional audit is pending** before any mainnet move. Full policy and disclosure: [SECURITY.md](SECURITY.md) · contract interface, governance and the invariant specification: [contracts/lumen-drop/README.md](contracts/lumen-drop/README.md).

---

## 10. Roadmap

**v1 — Instaward MVP (30 days, testnet)** ✅ **shipped** — the hero flow:
- Sponsor backend (sponsored create + fee-bump) — now a **Cloudflare Worker** with an env hot-key signer (KMS raw-sign mechanically proven, drops in later)
- **Link-send claim flow** (Claimable Balance) — the hero
- PWA claim page + dynamic OG cards (`next/og`)
- Full **recovery** (shipped ahead of plan, not "Argon2id only"): password + **email-OTP** + a **WebAuthn-PRF "Face ID"** upgrade over a zero-knowledge ciphertext box
- North-star metric: **net-new funded recipients that take a retained second action** (raw address count is sybil-gameable, so it is gated on unique-human + a retained action)

**v1.5 — SCF Build** — the retention layer + Integration track:
- ✅ **Request-money** (push-only) + **uneven splits** — shipped on testnet (SEP-7 "pay from any wallet" still deferred to this track)
- ✅ **Onward-send** + **sender-reclaim** ("take it back"), both sponsor-paid so the user pays no gas — shipped
- ✅ **v2 Soroban escrow (LumenDrop)** — built + deployed to testnet; the default shareable link-send + the Integration centerpiece. Hardened 2026-07-25 (soroban-sdk 26.1, owner-gated pause/upgrade, 29 tests, tool-clean) — **a professional audit is still pending**
- **WhatsApp auto-notifications** (Business API) — still future (email via Resend is the interim channel)
- EU→TR inbound on-ramp (MyKobo EURC/SEPA + on-chain EURC→USDC swap)
- Mainnet, real USDC (gated on an audit)
- _claim-to-second-action ≥ 25% as a retention hypothesis to measure (not a v1 success gate)_

**v2**
- Migration to OZ Smart Accounts (real passkey signer, social recovery, multi-device)
- "Send to phone" (deterministic address, no link needed)
- Integrated TRY cash-out if validated

---

## 11. Why Stellar

**NOT cheap/fast fees** (Solana/Base match those). The real muscle is **the stack itself**: native Claimable Balances (escrow without a smart contract) + protocol-level Sponsored Reserves (the recipient pays no gas — zero XLM — with no custom relayer) + passkey + native USDC. To do this, Peanut sets up a vault contract + relayer on every chain; Stellar gives it in the protocol.

**But we're not a monopoly** — Daimo/Peanut offer walletless claim links (sponsor-paid fees) on other chains. The honest positioning: not *"only possible on Stellar,"* but **"zero custom-contract risk + zero setup for the recipient + native USDC + EM rails — and the social primitive that Stellar's consumer ecosystem is missing."** Value metric for SCF: **net-new funded Stellar addresses created via claim** (not TVL — ecosystem activation).

---

## 12. Competitors

| Product | Chain | Status |
|---|---|---|
| **The recipient's own Turkish bank app** (FAST + Kolay Adres) | — (domestic banking) | The real **do-nothing alternative**: instant, free, domestic. For money already inside Turkey, this beats us — we don't try to win the domestic leg. |
| **Morse** (ex-Sling Money) | Solana | Ships the **same link UX**, MiCA-licensed, Turkey in **closed beta** — same EM thesis, different chain. The biggest threat. |
| **Peanut Protocol** | EVM (20+) | The exact same mechanic, but locked to EVM, infra-flavored. Not on Stellar. |
| **Daimo** | ETH + rollup | The best "request money" UX in crypto — but pivoted to B2B. |
| **LOBSTR** | Stellar | A close threat with a **thin moat**: it **already** sends to email/phone with a claimable-balance claim. Still account-leaning rather than a fully walletless Face-ID claim, but the gap is small. |

**Lumenia's honest edge:** the **cross-border EU→TR leg** + an **open, shareable claim link** (not a closed in-app transfer). The moat is **distribution, not technology** — the mechanic is proven and copyable.

**Verdict:** claim-link is **crowded on EVM, funded on Solana (Morse), and under-built on Stellar** — LOBSTR already does email/phone claimable-balance claim, and Sendit/Beans are adjacent, but no one ships a **non-custodial, browser-complete walletless claim on the EU→TR corridor**. The mechanic is proven, the chain lane is open, the moat = distribution (not "only possible here").

---

*Network: testnet-first · Regulation: no-yield, non-custodial*
