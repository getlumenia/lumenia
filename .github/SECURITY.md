# Security Policy

Lumenia moves money by link, so we take security reports seriously.

**Real user funds ARE at risk.** Most of the product runs on Stellar testnet, but a capped,
allowlisted **mainnet pilot** has been moving real Circle USDC since 2026-07-26 — hand-approved
wallets only, $5 per transfer, $50 per day. Treat anything reaching the mainnet deployment as a
real-money finding.

**The full policy — scope table, severity scale, and the honest posture (no professional audit yet,
sponsor key still an env hot key) — lives in [/SECURITY.md](../SECURITY.md). This page is the short
version; where they could ever differ, that one is canonical.**

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Preferred channel — GitHub's private reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (GitHub Private Vulnerability Reporting).
3. Describe the issue, the impact, and steps to reproduce.

If you can't use that channel, email **mericcintosunn@gmail.com** with `SECURITY` in the subject
line. If you'd like, mention a way to reach you and we'll follow up.

**Response targets:** acknowledgement within 3 business days; an initial assessment within 10
business days; a fix or a documented mitigation plan, with the mainnet pilot paused while we work
on anything that touches it. Please give us reasonable time to ship a fix before any public
disclosure; we're happy to credit you once it's resolved.

**Reproduce on testnet.** The same code paths run there and the money is free-minted. Do not test
against the mainnet deployment, and never touch funds or accounts that are not yours — if a
finding only shows up on mainnet, describe it and we will reproduce it ourselves.

## What's in scope

- **The escrow contract** (`contracts/lumen-drop`) — mainnet
  `CAC5JYQ2XEEVJ54EXC7KCG6MTARO5CSUQ2WNKSOM6FALCCU5UTEIWGR4`, testnet
  `CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S`, plus the superseded testnet ids that
  still hold exit-only drops. It custodies escrowed USDC, including real USDC — the highest-value
  target here.
- **Sponsor service** (`apps/sponsor`), both the testnet and the mainnet Worker — the anti-drain
  allowlist, canary caps, pilot allowlist, fee cap, and rate limiting that stop a client-supplied
  transaction from spending the sponsor's reserve or funds. If you can get the sponsor to sign or
  fee-bump something it shouldn't, that's the highest-severity class.
- **Claim / send / request link mechanics** (`apps/web/app/c`, `apps/web/app/v2/c`, `apps/web/lib`)
  — anything that could expose a bearer key, let a link be claimed by the wrong party, or leak the
  URL fragment to a server.
- **Key handling on the client** — the on-device keystore, its encryption, and the encrypted
  recovery box.

## What's out of scope

- The **testnet** deployment holding no real value (funds are free-minted play money) — report the
  underlying flaw, not "testnet funds can be moved."
- Findings from automated scanners without a demonstrated, realistic impact.
- Denial-of-service via volumetric traffic against hosted infrastructure.
- Anything requiring a compromised end-user device or a malicious browser extension.

## Supported versions

The project is pre-1.0 and evolves on `main`. Only the current `main` branch and the live
deployments (testnet, and the capped mainnet pilot) are supported; there are no back-ported
security releases yet.

Thank you for helping keep Lumenia safe.
