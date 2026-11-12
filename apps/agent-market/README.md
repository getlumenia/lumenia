# Lumenia Payout Agent: the worker behind the NEAR Agent Market listing

You give it a list of names and dollar amounts. It answers with one claim link per person and a receipt. Whoever opens a link gets the USDC in a brand-new NEAR account, with no wallet to install and no gas to pay. Links nobody opens come back to our treasury after the expiry you chose. During the hackathon the money is Circle's testnet USDC on NEAR testnet: real contract, real links, no real money.

This workspace app (`@lumenia/agent-market`) is the self-hosted "poller" that stands behind the listing on https://market.near.ai. It polls the market for hires, escrows the payouts on NEAR through the Lumenia NEAR library (`@lumenia/near`, `packages/near`, the same library behind the `near_*` tools of `apps/web/lib/agent-mcp.ts`), and delivers the links. Every link is `https://getlumenia.com/claim#<secret>`: Lumenia's NEAR claim screen (`apps/web/app/claim`), the secret in the URL fragment, which browsers never send to the server. `LISTING.md` is the record of the listing itself.

## Live listing

- Page: https://market.near.ai/a/lumenia-payout (handle `lumenia-payout`, agent id `8d0a0f96-a0e4-4ab8-8a02-3f13513a3f5d`, category finance, price 0.50 USDC per job, SLA 600 s, status live since 2026-11-11).
- A2A card: https://lumenia-payout.market.near.ai/.well-known/agent-card.json; x402 payees: https://lumenia-payout.market.near.ai/.well-known/x402.
- Registered through `POST /v1/agents/register` (the code-only path). Until the maintainer adopts it (`POST /v1/agents/me/adoption-code` with the agent token, then open the returned URL while signed in), it stays out of the Discover catalogue and cannot withdraw; hiring it by handle and the x402 calls work regardless.
- Since 2026-11-12 the worker runs on a small Ubuntu VPS as the systemd service `lumenia-agent-market` (`ops/lumenia-agent-market.service`, with the bundle and its two dependencies in `/opt/lumenia/agent-market` and state and receipts in `/var/lib/lumenia`), so it answers hires whether or not the maintainer's machine is on. Exactly one worker runs at a time: two pollers could take one job twice.

## For a buyer: how to hire it

From Claude Code (or any MCP client), connect the market once:

```sh
claude mcp add --transport http agent-market https://market.near.ai/mcp
```

Then ask in plain words, with the payouts spelled out one per line:

> Hire the Lumenia Payout Agent (handle `lumenia-payout`) on NEAR Agent Market with this brief:
> Ali: 1.00 workshop
> Ayse: 2.00 workshop
> expires_in_hours: 72

The market's `prepare_job` tool saves the hire and returns a link where you approve it and pay the service fee (0.50 USDC). The first MCP call opens a sign-in page. A JSON block works too and is exact:

```json
{"payouts":[{"label":"Ali","amount_usdc":"1.00","memo":"workshop"},{"label":"Ayse","amount_usdc":"2.00"}],"expires_in_hours":72}
```

The brief reaches the worker as plain text (`job.description`), so what matters is that the lines or the JSON block are in it. Rules: 1 to 10 payouts per job, 0.10 to 20.00 USDC each in whole cents, distinct labels up to 40 characters, memo up to 64 characters, expiry 1 to 168 hours (default 72). A brief outside these rules is declined with a full refund and a message that says exactly what to change.

### What comes back

Within the 600 s SLA (a batch takes about ten seconds), the deliverable is:

1. A table, one row per person: label, amount, memo, claim link (`https://getlumenia.com/claim#...`), expiry, and the escrow transaction on the explorer.
2. A JSON receipt (`schema: lumenia.agent-market.receipt/1`): job and assignment ids, the contract id, each link's public key and transaction hash, expiry, totals.
3. `receipt.csv` attached as a file (RFC 4180), the same rows.

All links of one job are funded in a single NEAR transaction: either every link exists or nothing was spent. A link is a bearer secret (whoever holds it can claim it), so forward each one over a private channel. `pnpm --filter @lumenia/agent-market dry-run` prints an example deliverable from `examples/brief.md` without touching the chain or the market.

### Owner test mode

The listing's notes describe a free owner test run (`test_run: true` on `prepare_job` / `create_job`): price 0, nothing held, outside reputation. In the public docs read on 2026-11-11 the only traces of it are `Job.isTestRun` in the OpenAPI schema and the owner setting `allow_admin_test_runs`; the hire tool's argument is not documented. Try it first; if the tool does not take it, the documented fallback is a paid self-hire (the price minus the 5 percent fee comes back to your balance). Either way the worker cannot tell a test run from a paid hire (the poll row carries no flag) and treats both the same: it escrows real testnet USDC and delivers real links. There is no testnet marketplace.

## For the operator: running the poller

Requirements: the repository's toolchain (Node 24, pnpm 9.12 through corepack, `pnpm install` once at the root), a funded NEAR testnet account (USDC plus a little NEAR for gas) registered on the USDC contract (the `register()` call of `@lumenia/near`, a one-time 0.00125 NEAR storage deposit), and the agent API token from the listing's Edit page. All commands run from the repository root:

```sh
pnpm --filter @lumenia/agent-market build      # tsc --noEmit, then the vite bundle: dist/worker.js
pnpm --filter @lumenia/agent-market test       # vitest, offline: 70 tests
pnpm --filter @lumenia/agent-market typecheck  # src + test + vite.config.ts
pnpm --filter @lumenia/agent-market dry-run    # parse examples/brief.md and print the deliverable; no chain, no market
cp apps/agent-market/.env.example apps/agent-market/.env   # fill in AGENT_MARKET_TOKEN and the funder key, see the table
pnpm --filter @lumenia/agent-market once       # one poll, then exit (prints a JSON summary)
pnpm --filter @lumenia/agent-market worker     # poll forever (SIGINT/SIGTERM stop it after the current assignment)
pnpm --filter @lumenia/agent-market reclaim    # take back expired unclaimed links, then exit (no market token needed)
```

The raw command behind the scripts, from `apps/agent-market`: `node --env-file-if-exists=.env dist/worker.js [--once | --reclaim | --dry-run --brief <file>] [--state <file>]`. The maintainer does not use a `.env`: the token sits in `~/.lumenia-near/agent-market.env` and `~/.lumenia-near/run-agent-market.sh` exports the rest before running `node apps/agent-market/dist/worker.js` from the checkout (the shape is in `ops/launchd/README.md`).

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_MARKET_TOKEN` | (required) | Agent API token, starts with `aat_`. Shown once when minted; never in the repository, never in a log line. |
| `AGENT_MARKET_BASE_URL` | `https://market.near.ai` | Market API base. |
| `POLL_INTERVAL_S` | `45` | Seconds between polls (the market asks for 30 to 60; clamped to 30..3600). |
| `RECLAIM_EVERY_S` | `3600` | How often the loop looks for expired links to take back. |
| `STATE_FILE` | `~/.lumenia-near/agent-market-state.json` | Handled assignments, link records, reclaim log (mode 0600). |
| `MAX_PAYOUTS_PER_JOB` | `10` | Job limits as promised in LISTING.md. |
| `MIN_PAYOUT_USDC` / `MAX_PAYOUT_USDC` | `0.10` / `20` | Per-payout bounds (the library's `MAX_LINK_USDC` also applies). |
| `DEFAULT_EXPIRES_HOURS` | `72` | Expiry when the brief names none. |
| `NEAR_NETWORK` | `testnet` | The library refuses anything else. |
| `NEAR_RPC_URL` | `https://rpc.testnet.near.org` | Comma-separated list enables failover; the maintainer uses `https://test.rpc.fastnear.com`. |
| `LUMENIA_CONTRACT_ID` | `lumenia-near.testnet` | The escrow. |
| `USDC_CONTRACT_ID` | `3e2210e1...8af` | Circle's testnet USDC. |
| `FUNDER_ACCOUNT_ID` | `lumenia-funder.testnet` | The treasury that pays. |
| `FUNDER_PRIVATE_KEY` or `FUNDER_KEY_FILE` | (one required for live runs) | `ed25519:...` or a near-cli keychain JSON (default path `~/.near-credentials/testnet/<funder>.json`). Read at signing time, never written. |
| `WEB_ORIGIN` | `https://getlumenia.com` | Origin of the claim links (`<WEB_ORIGIN>/claim#<secret>`). The worker defaults to the product; the library alone would default to its local dev page. |
| `DAILY_BUDGET_USDC` / `MAX_LINK_USDC` | `50` / `20` | The library's rolling 24 h budget and per-link cap. |
| `LUMENIA_DATA_DIR` | `~/.lumenia-near` | Where `links.json` (receipts, budget) lives; the maintainer uses `~/.lumenia-near/mcp-data`. |

The budget is shared with the MCP server by construction: the worker drives the same `Lumenia` class over the same `links.json`, so every link the worker funds counts against the MCP server's `DAILY_BUDGET_USDC` and the other way round, when both point at one `LUMENIA_DATA_DIR`. That file assumes one writer at a time; run the worker and the MCP server on the same data directory only if they do not pay at the same moment, or give the worker its own `LUMENIA_DATA_DIR` (then the budgets are separate, which is the maintainer's setup).

### How it is built

`@lumenia/near` is imported through the workspace link as TypeScript source (`packages/near/src`), which `apps/web` runs through `tsx` and plain Node cannot run. So `pnpm build` type-checks with `tsc --noEmit` and then lets vite bundle `src/worker.ts` into one Node file, `dist/worker.js`, with the library inlined and `near-api-js`, `zod` and `node:*` left external (they resolve from this package's `node_modules` at run time). `vite.config.ts` holds that build and the vitest settings; rebuild after every change to this folder or to `packages/near`. The library's own link path is `/c` (its standalone claim page); `src/rail.ts` re-paths every receipt to Lumenia's `/claim` as it is written, before the deposit is broadcast, so the receipt log, the deliverable and the restart safety net all carry the link that works (the same wrapper lives in `apps/web/lib/agent-mcp.ts`; both go away when the package grows a configurable link path).

### Keeping it alive through 30 November

The loop is a plain Node process. Pick one:

- launchd (the maintainer's Mac): `ops/launchd/README.md`, a `--once` run every minute from `~/.lumenia-near/run-agent-market.sh`, logs in `~/.lumenia-near/logs`.
- pm2: `pnpm --filter @lumenia/agent-market build && cd apps/agent-market && pm2 start ops/ecosystem.config.cjs && pm2 save` (restarts on crash, reads `.env`).
- systemd: `ops/lumenia-agent-market.service` (edit the user and paths, put the variables in `/etc/lumenia/agent-market.env`).
- cron: `ops/crontab.example` runs `--once` every minute and `--reclaim` hourly under `flock`.

Not GitHub Actions: a scheduled workflow has a 5 minute floor and no persistent disk, and the budget ledger (`links.json`) and the state file must survive between runs, otherwise the worker forgets what it paid. Not a Cloudflare Worker cron either, for now: the library persists receipts with synchronous `node:fs` writes and reads the funder key from a file, both of which workerd lacks; the honest port is a KV-backed async store inside the library, not a shim in this folder. The code is laid out for it (`src/worker.ts` is a class driven by `pollOnce()` and `reclaim()` over two interfaces, `MarketApi` and `PayoutRail`), so that port touches `packages/near`, not this worker.

## What happens when things go wrong

| Situation | What the worker does | Money |
|---|---|---|
| Brief has no payouts, or breaks a rule | `decline` with reason `rejected` and a detail that teaches the format and names each problem; the job is never started | nothing spent, hire refunded in full |
| Treasury cannot cover the job (budget left, USDC held, per-link cap, not registered) | same, reason `rejected`, with the numbers | nothing spent, refunded |
| RPC unreachable during the pre-flight read | waits for the next poll, nothing is declined | nothing spent |
| Deposit refused or refunded by the escrow (library throws "Nothing was spent") | `decline` with reason `failed` and the library's reason | nothing on chain, refunded |
| RPC error after the deposit was broadcast | the library confirms the drops on chain and the worker delivers; the hash may be unknown and the table says so | links live |
| Worker dies between deposit and submit | next poll resumes: the deposit call is idempotent on the assignment id (the library returns the first batch), the CSV is not uploaded twice, the deliverable is submitted | links live, delivered |
| `submit` fails (5xx after retries, network) | retried on the next poll from the stored deliverable | links live |
| `receipt.csv` upload fails | submits without the file and says so; the JSON block carries the same rows | links live, delivered |
| Buyer requests changes | re-submits the same deliverable with a note quoting the feedback (as data), once per feedback message, and posts one thread message | escrowed money cannot change; unclaimed links return after expiry |
| Dispute ruling asks for a redo | same, with a redo note, once per ruling | same |
| Rework requested for a job this machine never saw | rebuilds the record from the library's receipt log; if there is none, posts a message that a human will look, and stops | untouched |
| Market shows no deliverable although the worker submitted | re-sends at most once every ten minutes | links live |
| Expired, unclaimed links | the hourly reclaim pass (or `pnpm --filter @lumenia/agent-market reclaim`) takes them back and logs the transaction | returned to the treasury |
| A declined job whose deposit landed after all (RPC error twice) | the reclaim pass sees the receipts under the assignment's reference, adopts the links, and reclaims them after expiry | returned after expiry; the buyer was already refunded |
| Competition entries, assignments not `in_progress` | skipped | untouched |

Every outcome is written to the state file before and after the call that caused it, so a restart never pays twice: the worker's own record is the second guard, the library's idempotency reference (`agent-market:<assignment id>`) is the first.

Security notes: the brief is data, never instructions; labels and memos are escaped before they reach Markdown; claim links (both `/claim#` and the package's `/c#` shape) and the market token are scrubbed from every log line; the state file is written with mode 0600 through a temp file and rename; the library refuses `NEAR_NETWORK` other than `testnet`; nothing in this folder holds a key or a token.

## Human-only steps (see LISTING.md for the field values)

Done on 2026-11-11: the listing exists and is live (registered by code), the token is in `~/.lumenia-near/agent-market.env`, the treasury `lumenia-funder.testnet` is registered on the USDC contract, and a real `--once` poll from this folder returned `"seen": 0` with no errors. Still the maintainer's:

1. Adopt the agent (`POST /v1/agents/me/adoption-code` with the agent token, open the returned URL while signed in) so it appears in Discover and can withdraw.
2. Keep the poller running: since 2026-11-12 the VPS service (`systemctl status lumenia-agent-market`, logs with `journalctl -u lumenia-agent-market`). Done: adoption (step 1) and the test hire (step 3) on 2026-11-12.
3. Hire the agent yourself once (test run or paid self-hire), open the links, confirm a claim on `getlumenia.com/claim`.
4. Watch the treasury and the budget (`near_balances` in the Lumenia MCP, or the package's CLI) and the state file; top up before 30 November if the hackathon traffic drains it.

## Layout

- `src/market.ts`: the market client (poll, start, message, progress, decline, submit, file upload) with retries on 5xx/429 and `MarketError` on 4xx.
- `src/brief.ts`: the brief reader and validator (JSON block, then `Label: amount memo` / table / CSV rows, then a teaching decline).
- `src/deliverable.ts`: Markdown table + JSON receipt + CSV.
- `src/worker.ts`: the loop and the per-assignment state machine; also the CLI (`--once`, `--reclaim`, `--dry-run --brief`).
- `src/reclaimer.ts`: expired links back to the treasury, and the declined-but-landed safety net.
- `src/state.ts`: the JSON state file. `src/rail.ts`: the slice of the Lumenia NEAR library the worker uses, as an interface, with the real wrapper and the `/claim` re-pathing store. `src/dry-run.ts`: the offline rail.
- `test/`: 70 tests, no network: brief parsing, deliverable goldens, state idempotency, the market client against a local HTTP mock, the worker state machine over fakes, the reclaimer, and the real `Lumenia` class over the NEAR package's in-memory chain (`packages/near/test/helpers.ts`).
- `examples/`: three briefs (JSON, rows, one that is declined). `ops/`: launchd, pm2, systemd, cron. `vite.config.ts`: the bundle and the test runner.

## Honest status

- The market client follows the pages read on 2026-11-11 (`skill/SKILL.md`, `flows/worker-lifecycle.md`, `reference/agent-api.md`, `openapi.json`, `flows/messaging.md`) and is tested against a mock of them. It has been run against the live API once, from this folder on 2026-11-11 with the real token: `GET /v1/agents/me/assignments` answered and the poll printed `{"seen": 0, "outcomes": {}}`. No hire has reached it yet, so start, progress, submit, decline and the file upload are still proven by the mock only.
- The on-chain path is the library's (`createPayLinks`, one `ft_transfer_call` for the whole job), proven by the library's own tests and by this folder's wiring test over the in-memory chain, not by a live run from this worker.
- Lock words per payout are not offered: nothing in the contract or the claim page implements them, so the listing does not promise them.
