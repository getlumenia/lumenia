# Security Policy

Lumenia moves money, so we take security seriously even while the project is a
**testnet pilot** — no real funds are ever at stake today, but the mechanics
(sponsored account creation, fee-bumping, bearer claim links) are the same ones a
mainnet launch would use, so we want them hardened now.

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Preferred channel — GitHub's private reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (GitHub Private Vulnerability Reporting).
3. Describe the issue, the impact, and steps to reproduce.

If you can't use that channel, email **security@getlumenia.com** with `SECURITY` in
the subject line. If you'd like, mention a way to reach you and we'll follow up.

We aim to acknowledge a report within **72 hours** and to share a remediation plan
within **7 days**. Please give us reasonable time to ship a fix before any public
disclosure; we're happy to credit you once it's resolved.

## What's in scope

The parts of the system where a bug could cause real harm:

- **Sponsor service** (`apps/sponsor`) — the anti-drain allowlist, fee cap, and
  rate limiting that stop a client-supplied transaction from spending the sponsor's
  reserve or funds. If you can get the sponsor to sign or fee-bump something it
  shouldn't, that's the highest-severity class.
- **Claim / send link mechanics** (`apps/web/app/c`, `apps/web/lib`) — anything
  that could expose a bearer key, let a link be claimed by the wrong party, or leak
  the URL fragment to a server.
- **Key handling on the client** — the on-device keystore and its encryption.

## What's out of scope

- The **testnet** deployment holding no real value (funds are free-minted play
  money) — report the underlying flaw, not "testnet funds can be moved."
- Findings from automated scanners without a demonstrated, realistic impact.
- Denial-of-service via volumetric traffic against the hosted preview.
- Anything requiring a compromised end-user device or a malicious browser extension.

## Supported versions

The project is pre-1.0 and evolves on `main`. Only the current `main` branch and the
live testnet deployment are supported; there are no back-ported security releases yet.

Thank you for helping keep Lumenia safe.
