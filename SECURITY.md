# Security Policy

Lumenia moves money by link. We take security reports seriously and will work with you in
good faith. **Everything is on Stellar TESTNET today — no real user funds are at risk.**

## Reporting a vulnerability

Email **mericcintosunn@gmail.com** with `SECURITY` in the subject. Please include:

- what you found, and where (file/contract id/endpoint);
- a proof of concept or the exact steps to reproduce;
- the impact you believe it has.

Please do **not** open a public issue for a vulnerability, and please do not test against
anything but testnet.

**Response targets:** acknowledgement within 3 business days; an initial assessment (severity
+ whether we can reproduce) within 10 business days; a fix or a documented mitigation plan
before we move that component to mainnet. We will credit you in the fix notes unless you ask
us not to.

There is no paid bounty program today. We intend to join an ecosystem bug-bounty program after
the contract audit lands.

## Scope

| In scope | Notes |
|---|---|
| `contracts/lumen-drop` (the LumenDrop Soroban escrow) | The highest-value target: it custodies escrowed USDC. |
| `apps/sponsor` (the relayer / fee sponsor) | Cloudflare Worker; anti-drain validator, rate-limit, channel pool, signer seam. |
| `apps/web` claim + send + request flows | Especially anything that could leak a link secret (it lives only in the URL `#fragment`). |

Out of scope: findings that require a compromised user device; social engineering; volumetric
DoS against third-party infrastructure (Horizon, RPC providers, Cloudflare); missing best
practices with no demonstrated impact; and anything about the testnet USDC issuer, which is a
throwaway test asset.

## Severity scale

We use a standard four-level scale, judged by impact on user funds first:

- **Critical** — direct theft or permanent loss of escrowed funds; forging a claim to an
  attacker-chosen payout; any path that lets a non-sender move another user's escrow.
- **High** — funds temporarily unrecoverable (stranded escrow); bypass of the sender-reclaim or
  expiry gating; sponsor key exposure or unbounded sponsor spend.
- **Medium** — bounded fee-griefing; rate-limit or anti-drain bypass without fund loss; link
  secret exposure requiring an unusual precondition.
- **Low** — informational, defense-in-depth, and hardening findings.

## Current security posture (stated honestly)

- **No professional audit has been performed yet.** We have completed a static-analysis, fuzz
  and property-test pass with free tooling (Scout, clippy strict, cargo-audit, cargo-deny,
  proptest invariants, mutation testing) — that is self-assessment, not an audit. A
  professional audit is planned via the Stellar/Soroban security audit support program.
- The escrow contract is currently **upgradeable behind an owner** (upgrade + pause-new-escrow
  only; no owner path can move escrowed funds) and is intended to become **immutable after the
  audit** by shipping a final wasm with the upgrade entrypoint removed.
- Pausing can only stop NEW escrow. Claims and reclaims are never pausable, so escrowed funds
  can always exit.
- The link secret that authorizes a claim lives only in the URL fragment and is never sent to
  any server.

### Operational controls that are live today (testnet)

- **Canary caps.** A hard per-drop and rolling-UTC-day ceiling on the escrow the sponsor will
  facilitate, enforced on both escrow-creating paths. The per-drop cap needs no network call, so
  an outage cannot disable it; the per-day total uses an atomic reserve-then-check so concurrent
  requests cannot slip past it. Amounts come from the transaction XDR — what the ledger will
  actually execute — not from a client-supplied field. On a store outage the caps fail open by
  default (the per-drop cap and the rate limits still bound the damage); `CAPS_FAIL_CLOSED=1`
  flips that, and is the recommended mainnet setting.
- **Kill-switch.** Every value-moving sponsor endpoint can be halted at once.
- **Watchdog.** A cron job runs every 15 minutes on the sponsor Worker and alerts on: sponsor
  float below a floor, any value operation *sourced by* the sponsor (it should only ever create
  accounts and pay fees), and escrow governance activity — pause/unpause/ownership events plus
  the deployed wasm hash, checked directly because an `upgrade` emits no event.
- **Migration safety net.** A drop can only be released by the contract holding it, so the
  sponsor and the web app read and exit superseded escrow contracts while new escrow only ever
  enters the current one. A contract repoint therefore cannot strand a link that was already sent.
