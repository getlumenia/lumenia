# Monitoring — what runs, and what these configs are for

## What actually runs today: the Worker watchdog ✅

`apps/sponsor/src/lib/watchdog.ts`, on a **Cloudflare Cron Trigger every 15 minutes**
(`[triggers] crons` in `apps/sponsor/wrangler.toml`). It runs on infrastructure we already
operate, so there is nothing extra to host. Three checks:

| Check | Fires when | Why it matters |
|---|---|---|
| **Sponsor float** | native balance < `SPONSOR_MIN_XLM` (default 50 XLM), or the account is unreadable | Top-ups stopped, or something is spending faster than expected. |
| **Sponsor sourced value** | the sponsor account is the SOURCE of a `payment`, `path_payment_*`, `account_merge` or an offer | The sponsor only creates accounts and pays fees. One of these is the signature of a stolen key. |
| **Escrow governance** | a `paused` / `unpaused` / ownership event on the escrow, **or the deployed wasm hash changes** | These are rare and human-initiated. An unexpected one means the owner key is compromised. |

The wasm-hash check exists because **an `upgrade` emits no event** — OpenZeppelin's implementation
just calls `update_current_contract_wasm`, so watching events alone would miss the single most
serious action anyone can take against the contract. The expected hash is pinned in
`LUMENDROP_WASM_HASH`; **update it whenever you intentionally upgrade**, or the watchdog will page
you about your own deploy.

Alerts go to `wrangler tail` (always) and by email when `RESEND_API_KEY` + `ALERT_NOTIFY_TO` are
set. Cursors live in the same Upstash store as the rate limiter; without a store every check still
runs, it just re-scans a bounded recent window instead of resuming exactly.

**Both tripwires were verified against real testnet transactions** (2026-07-25): a live `pause`
produced a page naming the transaction hash, and a deliberately wrong pinned hash produced the
wasm-changed page. Verify yours with:

```bash
SPONSOR_SECRET=S… pnpm --filter @lumenia/sponsor test:watchdog        # runs every check, prints findings
SPONSOR_SECRET=S… LUMENDROP_WASM_HASH=deadbeef pnpm --filter @lumenia/sponsor test:watchdog   # must page
```

## What these JSON files are: an OpenZeppelin Monitor deployment, not yet run

OpenZeppelin Monitor is the richer, purpose-built tool — but it is a **separate always-on process**
(Docker or a Rust binary) and we do not run a host for one. These configs are kept ready for when
there is somewhere to put them; they are a superset of the watchdog's coverage, not a replacement
for something missing.

> **Status: DRAFT — not deployed.** Validate every file against the schema of the Monitor version
> you deploy (the JSON schema evolves) before going live.

| Config | Watches |
|---|---|
| `monitors/lumendrop_governance.json` | `pause` / `unpause` / `upgrade` / ownership functions on the escrow |
| `monitors/lumendrop_activity.json` | `claim` / `claim_share` / `reclaim` / `reclaim_pool` events — volume anomalies |
| `monitors/sponsor_account.json` | all transactions touching the sponsor account |

```bash
git clone https://github.com/openzeppelin/openzeppelin-monitor && cd openzeppelin-monitor
# copy this directory's networks/, monitors/, triggers/ into ./config/, then fill in:
#   - the real webhook / Slack URL in triggers/ops_webhook.json
#   - the sponsor G… address + the CURRENT LumenDrop C… id (see docs/HANDOFF.md)
docker compose up -d
```

Testnet today; at mainnet cutover duplicate the network file for pubnet and repoint the monitors'
`networks` arrays.
