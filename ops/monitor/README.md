# Monitoring — what runs, and what these configs are for

## What actually runs today: the Worker watchdog ✅

`apps/sponsor/src/lib/watchdog.ts`, on a **Cloudflare Cron Trigger every 15 minutes**
(`[triggers] crons` in `apps/sponsor/wrangler.toml`). It runs on infrastructure we already
operate, so there is nothing extra to host. Its checks:

| Check | Fires when | Why it matters |
|---|---|---|
| **Sponsor float** | native balance < `SPONSOR_MIN_XLM` (default 50 XLM), fewer than `SPONSOR_MIN_RECIPIENTS` (default 25) onboardings left in the spendable balance, or the account is unreadable | Top-ups stopped, or something is spending faster than expected. |
| **Sponsor sourced value** | the sponsor account is the SOURCE of a `payment`, `path_payment_strict_send`, `path_payment_strict_receive`, `account_merge`, `manage_sell_offer`, `manage_buy_offer`, `create_passive_sell_offer`, `create_claimable_balance` or `set_options` | The sponsor only creates accounts and pays fees. One of these is the signature of a stolen key; `set_options` is how a stolen key adds a signer before it moves anything. |
| **Escrow governance** | a `paused` / `unpaused` / ownership event on the escrow, **or the deployed wasm hash changes** | These are rare and human-initiated. An unexpected one means the owner key is compromised. |
| **Escrow state expiry** | the instance or code entry archives within `SPONSOR_MIN_TTL_DAYS` (default 21) | Archived state stops every claim and reclaim until someone restores it. |
| **Fee budget** | 80 percent of the day's `MAX_DAY_FEE_XLM` is spent | Past it every value route refuses until UTC midnight. |

The wasm-hash check exists because **an `upgrade` emits no event** — OpenZeppelin's implementation
just calls `update_current_contract_wasm`, so watching events alone would miss the single most
serious action anyone can take against the contract. The expected hash is pinned in
`LUMENDROP_WASM_HASH`, and a mismatch now HALTS the sponsor (below). For a planned upgrade: halt by
hand, upgrade, set the new hash in `LUMENDROP_WASM_HASH` and deploy, then resume.

Alerts go to `wrangler tail` (always) and by email when `RESEND_API_KEY` + `ALERT_NOTIFY_TO` are
set. Cursors live in the same Upstash store as the rate limiter. With a cursor the forbidden-operation
scan walks forward from it, up to 10 pages of 100 operations a run, and pages "scan is behind" when
more remain (payments TO the sponsor are listed too, so incoming traffic can bury an operation). With
no cursor (a first run, no store, or a key the store lost) it reads the account's newest 100
operations, and a forbidden operation there that is older than 24 hours pages without halting.

### The auto-halt

The watchdog halts the sponsor on its own on exactly two findings, the two signatures of a key in
someone else's hands: **the sponsor SOURCED a forbidden operation** (the list above) created in the
last 24 hours, and **the escrow wasm hash changed**, confirmed by a second read about 2 seconds after
the first. It writes `sponsor:halt:<network>` and `sponsor:halt:<network>:reason` in the store, for
the network of the Worker's own config; every value route and both approval routes of that network
answer 503 within about 5 seconds, exits included. Everything else (the float, the capacity floor,
state expiry, a governance event, an older forbidden operation, an unconfirmed wasm read, a check
that failed to run) pages a person and never halts. A halt that is new, because the key was absent
before the run wrote it, is emailed at once whatever the alert cooldown says.

To resume: `curl -H "authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/sponsor:halt:<network>"`
and the same for `sponsor:halt:<network>:reason`. **After a wasm halt for an upgrade you made, set
`LUMENDROP_WASM_HASH` to the new hash and deploy that Worker FIRST, and only then delete the halt
key**: the pin wins over everything else, so deleting the key first lasts only until the next run
compares the new wasm with the old pin and halts again. The page names the exact hash to pin. Every
sponsor-sourced `SetOptions` (the KMS cutover, each step of a rotation) trips the first finding by
design. Runbook: `ops/RUNBOOK_SPONSOR_KEY.md` section 4.

**What has run live, and what has not.** On testnet on 2026-07-25 a live `pause` produced the
governance page naming the transaction hash (a page only: governance events never halt), and a
deliberately wrong pinned hash produced the wasm-changed page. The forbidden-operation tripwire and
the auto-halt itself have not run live yet: the KMS cutover's own `SetOptions` is the planned first
proof (runbook section 2, step 3). Offline, every tripwire and the halt are held by
`test:watchdog-offline`. Verify yours with:

```bash
SPONSOR_SECRET=S... pnpm --filter @lumenia/sponsor test:watchdog        # runs every check, prints findings
SPONSOR_SECRET=S... LUMENDROP_WASM_HASH=deadbeef pnpm --filter @lumenia/sponsor test:watchdog   # prints the wasm page
```

This smoke test is READ-ONLY: it runs the watchdog without `autoHalt` and `heartbeat`, so even from a
shell that holds the production `KV_REST_API_*` variables it writes no halt key, no heartbeat stamp,
no scan cursor and no alert cooldown, and sends no email (it fails if it wrote anything to the store).
The deadbeef command therefore pages on the console and halts nothing: only a run started with
`autoHalt`, which only the Worker's scheduled handler passes, can halt. The halt itself is proven
offline by `pnpm --filter @lumenia/sponsor test:watchdog-offline`.

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
