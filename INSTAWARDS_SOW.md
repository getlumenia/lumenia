# Instawards Statement of Work (SOW) — Lumenia

> **30-Day Scoped Engagement.** This is the awarded, accepted contract of record that the sprint executes against. The in-product/evidence copy lives at [apps/web/public/instawards-sow.html](apps/web/public/instawards-sow.html) (same content). Network: **Stellar testnet** (mainnet is a later phase). Scope: the **link-send hero flow only**. Posture: **non-custodial, no yield**.

---

## 1. Project & Team Information

| Field | Value |
|---|---|
| Project Name | Lumenia |
| Builder / Team Name | Meriç Cintosun |
| Primary Contact | Meriç Cintosun (mericcintosunn@gmail.com) |
| Ambassador Chapter | Stellar Türkiye |
| Ambassador Chapter Lead | İrem Koçi (Stellar Türkiye) |
| Date Submitted | 2026-06-21 |
| Suggested Sprint Start Date | 2026-06-25 |

---

## 2. Instawards Overview & Intent

Instawards fund short, clearly scoped, execution-focused work that can be completed and demonstrated within 30 days or less. This SOW is a shared commitment between the Builder and the Ambassador Chapter Lead on what will be delivered, why it matters, and how success is verified.

---

## 3. Problem Statement & Objective

**Problem being addressed.** In crypto, even receiving money requires the recipient to have a wallet, save a seed phrase, and hold the native asset for fees — a setup most people never complete. This is what breaks cross-border transfers from the EU to Turkey: the sender is ready, but the recipient stalls at "install a wallet first." Lumenia removes that wall: you send USDC by link, and the recipient claims it with no app, no seed phrase, and no setup.

**Objective of this Instaward.** In 30 days, a live testnet demo where a recipient taps a link and receives USDC with no wallet, no setup, and no gas on their side, provable by a transaction hash on a public testnet explorer. This proves the receive half; converting held dollars to local currency is delegated to a licensed provider (see §4) and is the next milestone, not something Lumenia builds or operates.

**Success metric (binary).** At least one verifiable end-to-end testnet claim: a link tap that lands USDC in a freshly sponsored 0-XLM account, evidenced by a public on-chain tx hash. **No partial credit.**

**Why achievable.** The hard parts are already proven on testnet: three working spikes (a sponsored 0-XLM claim, external KMS-style Ed25519 signing, and wire parity between the web and the sponsor) plus an anti-drain validator with 14/14 passing tests. The 30 days integrate these proven parts into one live flow.

**Trust model (bearer claim-link).** The link carries a one-time claim ticket in the URL `#fragment` (never sent to servers), not a permanent key; the recipient's key is generated on-device at claim time. Before claim, the USDC sits in a Stellar Claimable Balance on the ledger, not on any Lumenia server, claimable via the ticket or reclaimed by the sender after 7 days (a lost link is not stranded). Lumenia never holds funds. Production hardening (an optional claim password and on-device key recovery) is out of scope here.

---

## 4. Scope of Work (30-Day Deliverables)

### 4.1 In-Scope Deliverables

| Deliverable | Description | Why it matters |
|---|---|---|
| **D1: Live sponsor service (testnet)** | Deployed HTTP service with two endpoints: `/create-account` (sponsors a 0-XLM account and a USDC trustline) and `/feebump` (validates the client transaction against the anti-drain allowlist, fee-bumps it, submits, and confirms). Env hot-key signer, with per-IP and per-account rate-limiting and a fee cap. | Lets a recipient receive USDC with no XLM and no gas. It is the backend the live claim runs on. |
| **D2: End-to-end walletless claim (testnet)** | The recipient taps the link, a value-first page shows the amount, they claim, and a sponsored 0-XLM account receives the USDC while the recipient holds 0 XLM throughout. | The hero moment, independently verifiable via tx hash. |
| **D3: Anti-drain protection, wired and tested** | The anti-drain validator gating every live `/feebump`, with 14/14 tests passing against the deployed code, a public repo, and a short technical write-up. | A service that funds accounts and fees can be drained; this shows the safeguard is real and inspectable. |

### 4.2 Out-of-Scope (Explicitly Not Included)

Mainnet and real money, live fiat conversion by Lumenia (delegated), account recovery and passkeys, request-money and bill-split, WhatsApp auto-notifications, production KMS/HSM, DB and SEP-7, and multi-corridor or abuse-at-scale handling.

**Cash-out (delegated, not operated).** Converting dollars to local currency is handled by a licensed provider (for example Binance, which publicly supports USDC deposits on Stellar) under its own license; Lumenia hands off to it and never converts or holds fiat. In this scope it is an integration design and a UI placeholder, not a live conversion. Local currency (TRY) is added only once a licensed path is confirmed.

### 4.3 Budget

**$5,000.** Execution, not exploration: the hard risks are already retired by three testnet spikes and a validator with 14/14 passing tests, so the 30 days integrate them into one live demo. The budget covers sponsor-service infrastructure, RPC and hosting for a continuously running testnet deployment, and demo production. It is scoped to a single hero flow on testnet, with mainnet reserved for later.

---

## 5. 30-Day Execution Plan & Timeline

As a solo builder, the timeline is kept deliberately conservative: infrastructure is front-loaded, with slack left for hardening and the demo.

| Week | Planned work | Expected output |
|---|---|---|
| **Week 1** | Stand up the Node sponsor service (CJS, `stellar-sdk@16`) and ship `/create-account` (begin-sponsoring, `createAccount(0)`, `changeTrust`, then end-sponsoring). Deploy to a public testnet URL with basic secret and RPC config. Drive it from a CLI script. | A reachable sponsor service, and one real testnet account created via CLI (sponsored 0-XLM, USDC trustline open, 0 XLM held) with a verifiable tx hash. |
| **Week 2** | Ship `/feebump` (validate against the anti-drain allowlist, fee-bump, submit, then confirm). Wire the existing claim page (Next.js 16) to both endpoints, and verify wire parity over the real HTTP boundary. | The first end-to-end walletless claim in a real browser on testnet: a link tap puts USDC in the account with 0 XLM held, plus an on-screen verifiable tx hash. |
| **Week 3** | Harden the service: per-IP and per-account rate-limiting and a fee cap, integration tests (happy claim, drain rejection, rate-limit), and error handling. Publish and clean the public repo. | Anti-drain enforced on every fee-bump, a passing test suite, rate-limited endpoints, and a published public repo. |
| **Week 4** | Polish the flow and UI (including the delegated cash-out placeholder). Record the 60-second demo. Assemble the evidence package. | A demo video, a tx-hash and explorer package, and a short write-up; D1, D2 and D3 closed. |

---

## 6. Evidence of Completion (Required)

| Deliverable | Evidence type | Description |
|---|---|---|
| **D1: Live sponsor service** | Explorer link + public repo | A successful sponsored account creation and a fee-bumped claim on a testnet explorer, from the live service; the anti-drain check is runnable in the repo. |
| **D2: End-to-end walletless claim** | Tx hash (link) + 60-second demo video | Click the tx hash to confirm the claim on a testnet explorer, then watch a 60-second video of a link opened on a phone, funds arriving, with no setup and no gas. |
| **D3: Anti-drain protection** | Screenshot + public repo + write-up | A "14 tests passed" screenshot, the repo to re-run the tests, and a short plain-language write-up. |

The Ambassador Chapter Lead assesses each deliverable's evidence as Present / Partial / Missing.
