# Security Policy

Lumenia moves money by link. We take security reports seriously and will work with you in
good faith.

**Read this first: real user funds ARE at risk.** A capped, allowlisted **mainnet pilot** has been
moving real Circle USDC since 2026-07-26. Most of the product still runs on testnet, but "it's all
testnet" is no longer true, and a finding that reaches the mainnet deployment is a real-money
finding.

## Where the code runs

| Deployment | Money | Who can use it |
|---|---|---|
| **Testnet** — `lumenia-sponsor.avakit.workers.dev` + the escrow at `CDVZN53V…ST6S` | Free-minted test USDC, no value | Anyone. This is where you should reproduce things. |
| **Mainnet pilot** — `lumenia-sponsor-mainnet.avakit.workers.dev` + the escrow at `CAC5JYQ2…WGR4` | **Real Circle USDC** | An **owner-approved allowlist only**. Every wallet is admitted by hand; $5 per transfer, $50 per day, a per-wallet budget of 5 value operations, caps fail **closed**. As of 2026-08-28: 74 approved wallets, 69 accounts opened, 53 of them funded, 109 real-money transfers. |
| **Open public mainnet** | — | **Not open.** Raising the caps or dropping the allowlist is gated on a professional audit and the key-custody work listed under *Current security posture*. |

## Reporting a vulnerability

**Preferred — GitHub's private reporting** (enabled on this repository): the **Security** tab →
**Report a vulnerability**.

If you cannot use that channel, email **mericcintosunn@gmail.com** with `SECURITY` in the subject.
Please include:

- what you found, and where (file / contract id / endpoint);
- a proof of concept or the exact steps to reproduce;
- the impact you believe it has.

Please do **not** open a public issue for a vulnerability.

**Testing guidance.** Reproduce against **testnet**, which exists for exactly this and where the
same code paths run. Do **not** test against the mainnet deployment, and never touch funds or
accounts that are not yours — if a finding only manifests on mainnet, describe it and we will
reproduce it ourselves rather than asking you to move real money.

**Response targets:** acknowledgement within 3 business days; an initial assessment (severity
+ whether we can reproduce) within 10 business days; a fix or a documented mitigation plan, and for
anything touching the mainnet pilot we will pause it (see the kill-switch below) while we work.
We will credit you in the fix notes unless you ask us not to.

There is no paid bounty program today. We intend to join an ecosystem bug-bounty program after
the contract audit lands.

## Scope

| In scope | Notes |
|---|---|
| **`contracts/lumen-drop` (the LumenDrop Soroban escrow)** — mainnet `CAC5JYQ2XEEVJ54EXC7KCG6MTARO5CSUQ2WNKSOM6FALCCU5UTEIWGR4`, testnet `CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S` | **Explicitly in scope, and the highest-value target: it custodies escrowed USDC, including real USDC on mainnet.** The superseded testnet ids `CDYEDHBP…A2RF` and `CAKEJAGC…DIAB` are also in scope — they still hold exit-only drops. |
| `apps/sponsor` (the relayer / fee sponsor) — **both** the testnet and the mainnet Worker | Cloudflare Worker; anti-drain validator, canary caps, pilot allowlist, rate-limit, channel pool, signer seam. |
| `apps/web` claim + send + request + recovery flows | Especially anything that could leak a link secret (it lives only in the URL `#fragment`) or the encrypted recovery box. |

Out of scope: findings that require a compromised user device; social engineering; volumetric
DoS against third-party infrastructure (Horizon, RPC providers, Cloudflare); missing best
practices with no demonstrated impact; and anything about the testnet USDC issuer, which is a
throwaway test asset.

## Severity scale

We use a standard four-level scale, judged by impact on user funds first. On the mainnet pilot
these levels describe **real dollars**, bounded by the caps above.

- **Critical** — direct theft or permanent loss of escrowed funds; forging a claim to an
  attacker-chosen payout; any path that lets a non-sender move another user's escrow.
- **High** — funds temporarily unrecoverable (stranded escrow); bypass of the sender-reclaim or
  expiry gating; bypass of the pilot allowlist or the canary caps; sponsor key exposure or
  unbounded sponsor spend.
- **Medium** — bounded fee-griefing; rate-limit or anti-drain bypass without fund loss; link
  secret exposure requiring an unusual precondition.
- **Low** — informational, defense-in-depth, and hardening findings.

## Current security posture (stated honestly)

- **No professional audit has been performed yet.** We have completed a static-analysis, fuzz
  and property-test pass with free tooling (Scout, clippy strict, cargo-audit, cargo-deny,
  proptest invariants, mutation testing) — that is self-assessment, not an audit. A
  professional audit is planned via the Stellar/Soroban security audit support program. The
  mainnet pilot runs **ahead** of that audit, which is why it is allowlisted and capped.
- The escrow contract is currently **upgradeable behind an owner** (upgrade + pause-new-escrow
  only; no owner path can move escrowed funds) and is intended to become **immutable after the
  audit** by shipping a final wasm with the upgrade entrypoint removed. The honest residual: an
  owner who shipped a malicious wasm would be the one way around that, so the mainnet owner is a
  **cold key held offline**, separate from the always-online sponsor key since 2026-08-08.
  Promoting it to a 2-of-3 multisig with a timelock is open work, not done.
- The sponsor key is still an **environment hot key**. An AWS-KMS Ed25519 signer is code-complete
  behind the same interface (13/13 offline tests) but the live AWS key is **not provisioned**.
- Pausing can only stop NEW escrow. Claims and reclaims are never pausable, so escrowed funds
  can always exit.
- The link secret that authorizes a claim lives only in the URL fragment and is never sent to
  any server.

### Operational controls that are live today

- **Canary caps.** A hard per-drop and rolling-UTC-day ceiling on the escrow the sponsor will
  facilitate, enforced on both escrow-creating paths. The per-drop cap needs no network call, so
  an outage cannot disable it; the per-day total uses an atomic reserve-then-check so concurrent
  requests cannot slip past it. Amounts come from the transaction XDR — what the ledger will
  actually execute — not from a client-supplied field. On a store outage the caps fail open by
  default; **the mainnet Worker runs `CAPS_FAIL_CLOSED=1`**, so there it creates no escrow at all
  rather than falling back to the per-drop cap alone. Live values: testnet 100 / 1000 USDC,
  mainnet **5 / 50**.
- **Pilot allowlist.** On mainnet only owner-approved wallets may move value, each with a hard
  budget of ledger-confirmed value operations. It is fail-closed: an allowlist that cannot be
  read admits nobody.
- **Onboarding budget.** A per-UTC-day ceiling on how many accounts the sponsor will create, so
  the one value route with no per-account limit cannot drain the sponsor's reserve.
- **Kill-switch.** Every value-moving sponsor endpoint can be halted at once.
- **Watchdog.** A cron job runs every 15 minutes on both sponsor Workers and alerts on: spendable
  sponsor capacity below a floor, any operation *sourced by* the sponsor that it should never
  source (it should only ever create accounts and pay fees), and escrow governance activity —
  pause/unpause/ownership events plus the deployed wasm hash, checked directly because an
  `upgrade` emits no event. A check that fails to run pages rather than passing quietly.
- **Migration safety net.** A drop can only be released by the contract holding it, so the
  sponsor and the web app read and exit superseded escrow contracts while new escrow only ever
  enters the current one. A contract repoint therefore cannot strand a link that was already sent.
