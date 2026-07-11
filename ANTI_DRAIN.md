# Anti-Drain Protection — how the sponsor stays safe

> **Plain-language write-up (Instawards D3).** Anyone can re-run the checks; see “Re-run the tests” below.

## The risk

Lumenia’s sponsor service does two things for a brand-new recipient: it **creates + funds their account** (pays the ~1.5 XLM reserve) and **pays the transaction fee** (fee-bump). That is exactly what makes the recipient need *no wallet and no gas*.

But a service that hands out reserves and pays fees is a natural target: if an attacker could make the sponsor sign the *wrong* transaction, they could drain the sponsor’s balance — by making it fund large balances, sponsor arbitrary trustlines, or move value. The whole point of the safeguard is: **the sponsor must sign only the exact, harmless transaction shape it expects — nothing else.**

## The defense (three layers)

**1. An allowlist validator (not a denylist).** Before the sponsor fee-bumps any client transaction (`/feebump`), it runs [`apps/sponsor/src/lib/anti-drain.ts`](apps/sponsor/src/lib/anti-drain.ts). A single unexpected operation — or an allowed operation with an unexpected parameter — is **rejected**. It checks every operation’s **source** *and* its **sensitive parameters**, not just the operation type:

| Check | Why it stops a drain |
|---|---|
| Only a fixed set of op types is allowed | No `setOptions`, `accountMerge`, path payments, offers, etc. |
| The sponsor may **only** source `beginSponsoring` / `createAccount` | It can never be tricked into sourcing a `payment` or `changeTrust` (which would spend its own money) |
| `createAccount.startingBalance` must be **0** | The sponsor can’t be made to fund a large XLM balance |
| `changeTrust` must be the **expected asset**, recipient-sourced | No sponsoring a trustline for an arbitrary/liquidity-pool asset |
| `claimClaimableBalance.balanceId` must **match** the expected balance | The claim can only target the intended Claimable Balance |
| `payment` is rejected unless its destination is explicitly allow-listed | No value leaves to an attacker |
| Missing a constraint (asset / balanceId) **fails closed** (strict-by-default) | A forgotten field rejects rather than silently allowing anything |

**2. A fee cap.** Every fee-bump is bounded to a small fixed maximum (`FEE_BUMP_MAX_STROOPS`). Even a flood of *valid* claims can only ever cost the sponsor a tiny, capped fee per request. (Honest note: the server also *chooses* the fee itself — a fixed per-op rate on a 1-op claim — so the client cannot influence it at all; the cap is defense-in-depth against a future code change, not the only thing preventing a client-set fee.)

**3. Per-IP + per-account rate limiting** ([`apps/sponsor/src/lib/rate-limit.ts`](apps/sponsor/src/lib/rate-limit.ts)) throttles bursts on both `/create-account` and `/feebump`. The deployed limiter is **durable across serverless instances** (a fixed-window counter in Upstash Redis via Vercel Marketplace); it degrades to in-memory per-instance buckets if the store is unset or unavailable, so the limiter's own infrastructure can never block a legitimate claim.

## What is proven

- **18/18 unit tests** ([`apps/sponsor/src/test-antidrain.ts`](apps/sponsor/src/test-antidrain.ts)) — 4 legitimate shapes accepted, 14 drain vectors rejected (sponsor-sourced payment/changeTrust, `startingBalance > 0`, wrong asset, wrong `balanceId`, wrong tx source, too many ops, wrong destinations, a third-party-sourced op, and the strict-mode fail-closed cases). The tests import the **same** module the live `/feebump` uses.
- **Integration tests** ([`apps/sponsor/src/test-integration.ts`](apps/sponsor/src/test-integration.ts)) drive the running service over HTTP: a happy claim lands USDC, a malicious payment is rejected with a 400, and a burst is rate-limited (429).
- **Live evidence:** the anti-drain gate ran on a real browser claim on testnet — the claim went through the validator + fee-bump and the recipient received 20 USDC while holding 0 XLM.

## Honest scope (testnet sprint)

- The live rate limit was proven with a real concurrent burst against the deployed service (2026-07-11): 12 simultaneous `/create-account` requests for one account → exactly 5×200 (the per-account cap) + 7×429, across serverless instances. Full **abuse-at-scale** handling (bot farms, IP rotation, proof-of-humanity) remains the mainnet upgrade — explicitly out of scope for this SOW.
- The sponsor key is an **env hot-key** for testnet; a KMS raw-signer drops in behind the same interface later (mechanically proven by Spike #1b).

## Re-run the tests

```bash
pnpm install
pnpm --filter @lumenia/sponsor test:antidrain     # 18/18, no network
pnpm --filter @lumenia/sponsor test:integration   # happy / drain-rejection / rate-limit (testnet)
```
