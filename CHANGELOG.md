# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/).

> **Testnet pilot.** Every release so far runs on the Stellar **test network**. No
> real money is used; balances are free-minted test USDC. Amounts and metrics reflect
> testing activity, not economic volume.

## [Unreleased]

- Community-health and presentation layer: contributing guide, code of conduct,
  security policy, issue/PR templates, and this changelog.

## [0.1.0] — 2026-07-18

The first end-to-end testnet pilot: send and request money by link, where the
recipient claims it walletless, seedless, and pays no gas.

### Added

- **Walletless claim flow.** A sender-funded Claimable Balance (dual predicate:
  recipient claims, or the sender reclaims after 7 days) is claimed by a recipient
  who holds **0 XLM** — the sponsor covers the account reserve and the transaction
  fee via a sponsored create + fee-bump. Proven end-to-end in a real browser on
  testnet.
- **Sponsor service** (`apps/sponsor`) with endpoints for account creation, claim
  fee-bumping, onward-send, a test-USDC faucet, demo links, an anonymous event
  beacon, a waitlist, and a feedback channel.
- **Anti-drain validator** — an allowlist that checks every operation's source and
  sensitive parameters before the sponsor signs, so a client transaction can never
  spend the sponsor's reserve or funds. Separate, tighter policies for the claim and
  send paths. Covered by 25/25 unit tests and 6/6 integration tests.
- **Durable rate limiting** (per-IP and per-account) across serverless instances,
  plus a per-bump fee cap.
- **Request money** — create a link that asks someone to pay you; the payer opens it
  and pushes the payment (no pull/debit), with honest handling for the with- and
  without-account cases.
- **Onward send** and an off-chain **split** helper.
- **Product web app** (`apps/web`) in the "Periwinkle" design system: landing,
  how-it-works, a live `/demo` that mints a real testnet claim link, a tools hub
  (transaction verify, link check, USD→TRY, cost), guides (`/learn`), `/stats` (real
  counts read from the public ledger), an honest `/cash-out` guide, and about /
  roadmap / privacy / terms / brand / developers pages.
- **On-device key handling** — a classic Ed25519 key generated on-device, stored in
  an IndexedDB keystore and optionally locked with an Argon2id-derived key.
- **Hermetic CI** — typecheck, the anti-drain validator, and production builds on
  every push and PR, with a single `ci-passed` gate and grouped Dependabot updates.

### Security

- The URL fragment carrying a bearer key is read only on the client and stripped from
  the address bar after use; it is never sent to a server.
- Money surfaces never expose wallet, crypto, or ledger-level error codes to users.

[Unreleased]: https://github.com/getlumenia/lumenia/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/getlumenia/lumenia/releases/tag/v0.1.0
