# SOW 2 D3 operations note: the retirement switch, the KMS signer, the watchdog heartbeat

Status: **2026-10-08. Code done and tested; every step that touches a deployed Worker, AWS or the
chain is the owner's and is marked "owner" below with the exact command.** Each log section has a
row per step; rows still marked _pending_ are filled in when the owner runs them. Nothing here
contains a secret: secrets are named, never shown. The two Worker URLs are the public ones the
web app already calls.

Companion documents: [`SOW2_READINESS_REPORT.md`](SOW2_READINESS_REPORT.md) (D3 section: what each
hardening item changed, the tests that hold it, the adversarial runs) and
[`../ops/RUNBOOK_SPONSOR_KEY.md`](../ops/RUNBOOK_SPONSOR_KEY.md) (key custody and incident response).

| Worker | Network | Public URL |
|---|---|---|
| `lumenia-sponsor` | testnet | https://lumenia-sponsor.avakit.workers.dev |
| `lumenia-sponsor-mainnet` | mainnet (real money) | https://lumenia-sponsor-mainnet.avakit.workers.dev |

All commands run from `apps/sponsor` unless a path says otherwise.

---

## 1. The retirement switch

### 1.1 What it is

One variable: `PILOT_MODE`. With `PILOT_MODE = "1"` (the mainnet Worker today) only wallets the
owner approved by hand may move money IN (`/send-link`, `/v2-deposit`), each with a budget of
transactions. Unset, the allowlist is gone: every wallet may deposit, `/pilot-status` answers
`{"pilot": false, "approved": true, "state": "open"}` for any wallet, and the web shows real money
as open to everyone.

Only `apps/sponsor/src/lib/pilot.ts` and `apps/sponsor/src/worker.ts` read the variable. Everything
else stays exactly as it is when it flips:

| Survives the flip unchanged | Variable / mechanism | Mainnet value |
|---|---|---|
| Per-transfer cap | `MAX_DROP_USDC` | 5 USDC |
| Per-day escrow cap, all senders | `MAX_DAY_USDC` | 50 USDC |
| Per-sender day cap (new in D3) | `MAX_DAY_USDC_PER_SENDER` | 25 USDC |
| Smallest escrow (per share for a group link) | `MIN_DROP_USDC` | 0.01 USDC |
| Escrow counter fails closed | `CAPS_FAIL_CLOSED` | 1 |
| Group link size | `MAX_POOL_SLOTS` (code ceiling 8) | 6 |
| Sponsored accounts per day / per connection | `MAX_DAY_ACCOUNTS` / `MAX_DAY_ACCOUNTS_PER_SOURCE` | 60 / 8 |
| Sponsor fee budget per day (new in D3) | `MAX_DAY_FEE_XLM` | 15 XLM |
| Rate limits | `RATE_CAP` / `ACCOUNT_RATE_CAP` (code defaults) | 30 / 5 per minute |
| Anti-drain validator, relay simulation and fee bounds | code | always on |
| Kill switch | `SPONSOR_HALT` env, `sponsor:halt:<network>` store key | off |
| Watchdog + auto-halt + heartbeat | Cron Trigger every 15 min | on |

The web keeps the pilot's one precondition after the flip, where money leaves: with the pilot
retired, the wallet refuses to sign any money movement on real money from an account that is not
locked with a password and backed up on this device (`backupBlocksRealMoney` in
`apps/web/lib/pilot-access.ts`, enforced in `getSigner` in `apps/web/lib/wallet.tsx`), the switch
sends such an account to `/pilot`'s secure step first, and the browser extension refuses the switch
and the send while its account has no backup. The rules are held by `test:pilotaccess` (as pure
functions) and the extension's `test:router` and `test:send`; their use inside the web's wallet
provider (`apps/web/lib/wallet.tsx`) is not under test, because no component test exists. A device
with no account yet learns the switch from `/pilot-status` asked without a key. Everyone sees this
once per device before using real money, on the first switch or on arriving on real money (a mainnet
claim, a device already there). "Not now" on arrival returns to practice money only when this account
may switch back; otherwise the device stays where it is and the note shows again next time, so a
claim recipient the pilot has not approved is never stranded on practice money: "Real money on
Lumenia is an early pilot. It has not been reviewed by an outside security firm, so keep amounts
small, and never send what you cannot afford to lose. Transfers are capped at $5 each."

### 1.2 Flipping it on mainnet (NOT NOW)

Mainnet keeps `PILOT_MODE = "1"` until the written legal opinion the Customer Development Plan
names (section 7.4) is in hand. When it is, the flip is:

0. The web from the D3 commit is live in production. A web build from before it reads the answer
   `"state": "open"` as no state at all and shows everyone "Join the pilot", so the Worker must not
   flip first.
1. Delete the line `PILOT_MODE = "1"` from `[env.mainnet.vars]` in `wrangler.toml`.
2. `npx wrangler deploy --env mainnet`
3. `curl -s https://lumenia-sponsor-mainnet.avakit.workers.dev/health` shows `"pilotMode": false`.
4. `curl -s https://lumenia-sponsor-mainnet.avakit.workers.dev/pilot-status` answers
   `{"pilot":false,"approved":true,"state":"open"}`, with or without `?pubkey=`: a device with no
   account yet asks without one, and the open answer is given before the rate limiter.

Rollback: put the line back and deploy again. The allowlist and every wallet's approval are kept in
the store while the switch is off, so turning it back on restores the pilot exactly as it was.

### 1.3 The dress rehearsal (testnet)

The rehearsal turns the allowlist ON on the testnet Worker (where it never was), proves a wallet that
was never approved is refused, approves one wallet, turns the allowlist OFF, proves both wallets
send, and proves the caps and the halt still refuse. `pnpm --filter @lumenia/sponsor rehearse` runs
each phase's probes and appends them, stamped, to a log. Two throwaway testnet wallets are written to
the log folder before they are funded, and every deposit's link key before the deposit is posted, so
step 11 can take every deposit back.

Owner steps, testnet only (each `wrangler deploy` replaces the vars of the deploy before it, so the
`--var` flag is the whole switch and `wrangler.toml` is not edited):

| # | Step | Command |
|---|---|---|
| 1 | Allowlist ON | `npx wrangler deploy --var PILOT_MODE:1` |
| 2 | Probe the gate | `pnpm --filter @lumenia/sponsor rehearse -- --target https://lumenia-sponsor.avakit.workers.dev --phase gated` |
| 3 | Approve wallet W1 (the script prints its address) | `STELLAR_NETWORK=testnet KV_REST_API_URL=... KV_REST_API_TOKEN=... pnpm --filter @lumenia/sponsor pilot approve <W1>` |
| 4 | Probe the approval | `... rehearse -- --target <testnet url> --phase approved` |
| 5 | Allowlist OFF | `npx wrangler deploy` |
| 6 | Probe the open state | `... rehearse -- --target <testnet url> --phase open` |
| 7 | Halt by environment | `npx wrangler deploy --var SPONSOR_HALT:1` |
| 8 | Probe the halt | `... rehearse -- --target <testnet url> --phase halted` |
| 9 | Resume | `npx wrangler deploy` |
| 10 | Probe the resume | `... rehearse -- --target <testnet url> --phase resumed` |
| 11 | Take the rehearsal's deposits back (any time after step 10; each expires two minutes after it was made) | `... rehearse -- --target <testnet url> --phase reclaim` |

The log is `apps/sponsor/adversarial-out/rehearsal/rehearsal-log.md` (gitignored folder); its rows go
into section 1.4. Start with that folder empty (or pass `--out <a new folder git ignores>`): the keys
file records the Worker it was made for, and the script refuses to continue a rehearsal against a
different `--target`, so a local dry run's wallets, approval and deposits are never reused. Step 11
can be run again until every deposit reads taken back; a deposit it could not take back, or whose
take-back answered 202, stays in its retry set; only the escrow's own answers settle one: "nothing
here" (`Error(Contract, #2)`) for a deposit that never landed, "already claimed" (`#3`) for one that
was taken back. A keys file from an older version of the tool records no target; `--adopt` continues it.

Between steps 1 and 5 the testnet product refuses sends from every wallet that is not approved, and
between steps 7 and 9 it refuses everything that moves money. Both windows are a few minutes; keep
them away from the nightly live claim run (05:23 UTC).

### 1.4 Rehearsal log

**Dry run, 2026-10-08 14:48-14:52 UTC, local `wrangler dev` of the D3 code (after the third review
round) against the live testnet ledger and RPC, with a freshly started local stand-in for the store
(`pnpm --filter @lumenia/sponsor fake-kv`) and an empty log folder.** Each phase is one restart of
the Worker with the variables named. Every row passed.

| Time (UTC) | Phase | Step | Result |
|---|---|---|---|
| 14:48:54 | gated (`PILOT_MODE=1`) | `/health` shows `pilotMode: true` | PASS |
| 14:49:17 | gated | two throwaway wallets onboarded and given test USDC (onboarding is never gated); their keys were written to the log folder first | PASS |
| 14:49:17 | gated | `/pilot-status` for the never-approved W2: `{"pilot":true,"state":"none","approved":false,"used":0,"limit":5}` | PASS |
| 14:49:18 | gated | a real 0.05 USDC deposit from W2: 403 `this wallet is not on the pilot allowlist yet` | PASS |
| 14:49:19 | gated | the same from W1 before its approval: 403, same sentence | PASS |
| (between) | | `pilot approve W1` in the testnet namespace | done |
| 14:49:20 | approved | `/pilot-status` for W1: `{"pilot":true,"state":"approved","approved":true,"used":0,"limit":5}` | PASS |
| 14:49:28 | approved | a real 0.05 USDC deposit from W1: 200, tx [`9f535fbe...587f6`](https://stellar.expert/explorer/testnet/tx/9f535fbe77f232ddd3fc5d0bb8b4692113809651bc8864c8433dc099d54587f6) | PASS |
| 14:49:28 | approved | the same from W2: still 403 | PASS |
| 14:49:33 | open (`PILOT_MODE` unset) | `/health` shows `pilotMode: false`; `/pilot-status` for W2: `{"pilot":false,"approved":true,"state":"open"}` | PASS |
| 14:49:38 | open | a real 0.05 USDC deposit from W1: 200, tx [`53639913...453ca`](https://stellar.expert/explorer/testnet/tx/5363991380ec2ee0e023d0c974a2d72622d83f6f0017f136bb17217f87c453ca) | PASS |
| 14:49:43 | open | the same from W2, never approved: 200, tx [`1bcdaab0...76f6d`](https://stellar.expert/explorer/testnet/tx/1bcdaab025e1a2a0b8a2c173acea0eb0d2592238184a4be3a96ae13d7f876f6d) | PASS |
| 14:49:44 | open | a 0.005 USDC deposit from W2: 400 `canary cap: amount 0.005 USDC is below the minimum of 0.01 USDC` (the caps still refuse) | PASS |
| 14:49:51 | halted (`SPONSOR_HALT=1`) | `/health` shows `{"halted":true,"source":"env"}`; all 11 value routes and both grant routes answer 503 with the halt's own answer; a read route (`/pilot-status`) still answers 200 | PASS |
| 14:50:02 | resumed | `/health` shows `{"halted":false}`; none of the 13 routes answers the halt | PASS |
| 14:51:39 | reclaim | the approved deposit from W1 taken back after its 2-minute expiry: tx [`49824145...5e443`](https://stellar.expert/explorer/testnet/tx/49824145cd72ff6d9a600cc6421cd0f99096ea29ddfdfd75186acda92185e443) | PASS |
| 14:51:48 | reclaim | the open deposit from W1 taken back: tx [`5b708943...71f3f`](https://stellar.expert/explorer/testnet/tx/5b70894306944e28e0afc95e439e532e8283440fe3db3eb942bd454687971f3f) | PASS |
| 14:51:53 | reclaim | the open deposit from W2 taken back: tx [`c711f6af...8311b`](https://stellar.expert/explorer/testnet/tx/c711f6af7a612ffded68e417f1a58ae6ea5c4e898df21d4ac43136f56d98311b) | PASS |

Two earlier dry runs the same day also passed every row: 13:15-13:19 UTC (its three deposits were
taken back in its own reclaim phase) and 11:14-11:16 UTC on the first cut. That first tool kept no
link keys and had no reclaim phase, and nobody took its three deposits back at the time. A
take-back needs only the depositing wallet's signature and the 32 link bytes, which each deposit
transaction carries, so the link records were rebuilt from the three deposit transactions and the
current tool's reclaim phase took all three back at 14:52 UTC: [`4169a9b2...4a5bd`](https://stellar.expert/explorer/testnet/tx/4169a9b2f4a96bd46cce164195c82594d49ae9c0c5dd09781a6e209bb474a5bd),
[`3d2faa06...78e40`](https://stellar.expert/explorer/testnet/tx/3d2faa06b2de6be9fe208cd8e0cfe901fe25978a5de0ad5dc43485e131c78e40), [`f7242505...99f7d`](https://stellar.expert/explorer/testnet/tx/f7242505bf16b2439a13cb66fec87b8dd396e7e0223dd327a603ecd663d99f7d).
No rehearsal deposit is left in the testnet escrow.

**On the deployed testnet Worker (owner, section 1.3):** _pending_. Paste
`rehearsal-log.md` here with its timestamps.

---

## 2. The KMS signer

### 2.1 What changes and what does not

The sponsor's key moves out of the Worker's environment into AWS KMS. The sponsor ACCOUNT does not
change: the KMS key is ADDED as a signer (weight 1, thresholds 1/1/1) of the existing account with one
`SetOptions`, so the address, the XLM float, the sponsored reserves, the channel accounts and the
web's sponsor pin all stay. The sponsor accounts hold no trustline (XLM only, on Horizon on
2026-10-08). The code was split for this in D3: `SPONSOR_ACCOUNT_ID` names the account (every
operation source, fee-bump source and sponsored reserve), and the signer only signs. KMS mode refuses
to start without `SPONSOR_ACCOUNT_ID`, so the account is never derived from a key. `/health` shows
`"account"`, `"accountSource"` (`"SPONSOR_ACCOUNT_ID"` or `"signer"`) and
`"signer": {"kind": "kms" | "env", "publicKey": ...}`.

The KMS key's own address is treated as sponsor-controlled exactly like the account: no request may
name it as a recipient, sender, throwaway or home, or as the source of an operation, because the
KMS signature is also that address's master signature. A signer that fails (a KMS outage) gives the
day's fee charge back, so retries during an outage do not spend the fee budget. During a KMS outage
only the routes that sign fail: `/health` still answers, with `"ok": false` and
`"signer": {"available": false}`, and the read and recovery routes stay up.

The 2-of-3 owner multisig is a different account (the escrow contract's owner) and is not touched.

### 2.2 Cutover steps (owner; testnet first, then mainnet)

Detailed in [`../ops/RUNBOOK_SPONSOR_KEY.md`](../ops/RUNBOOK_SPONSOR_KEY.md) section 2. One KMS key and
one IAM user per network.

| # | Step | Command or action |
|---|---|---|
| 1 | Create the key (`ECC_NIST_EDWARDS25519`, `SIGN_VERIFY`), the IAM user (`kms:Sign`, `kms:GetPublicKey`, `kms:DescribeKey` on that key only), CloudTrail on | AWS console or CLI |
| 2 | First live check: one offline signature verified locally, prints the key's G address. No secret on a command line: each is read into the shell and unset afterwards | in `apps/sponsor`: `read -r KMS_KEY_ID && export KMS_KEY_ID`, `read -rs AWS_ACCESS_KEY_ID && export AWS_ACCESS_KEY_ID`, `read -rs AWS_SECRET_ACCESS_KEY && export AWS_SECRET_ACCESS_KEY`, then `KMS_REGION=eu-central-1 pnpm run kms-check`, then `unset KMS_KEY_ID AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY` |
| 3 | Dry run: the UNSIGNED SetOptions, its hash and the account's signers and thresholds, written to a gitignored file; no secret needed | in `apps/sponsor`: `pnpm run add-signer --network testnet --account <sponsor G> --signer <KMS G> --out .cutover/testnet-setoptions.json` |
| 4 | Read the file, record the hash, then submit exactly that transaction | `read -rs SPONSOR_SECRET && export SPONSOR_SECRET`, `pnpm run add-signer --network testnet --submit --in .cutover/testnet-setoptions.json --hash <hash>`, `unset SPONSOR_SECRET` (mainnet also needs `I_UNDERSTAND_MAINNET=1`) |
| 5 | Expect the watchdog to page and halt within 15 minutes (section 4); confirm the hash, then clear the halt | `curl -H "authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/sponsor:halt:testnet"` and the same for `sponsor:halt:testnet:reason` |
| 6 | Name the account first (vars) and deploy | in the network's block of `wrangler.toml`: `KMS_REGION = "eu-central-1"`, `SPONSOR_ACCOUNT_ID = "<sponsor G>"`; `npx wrangler deploy` (or `--env mainnet`) |
| 7 | The credentials (secrets, names only) | `npx wrangler secret put AWS_ACCESS_KEY_ID` and `npx wrangler secret put AWS_SECRET_ACCESS_KEY` (`--env mainnet` for mainnet) |
| 8 | The key id LAST: this is the switch, and `secret put` deploys at once | `npx wrangler secret put KMS_KEY_ID` (the ARN; a secret because it names the AWS account) |
| 9 | Verify from outside | `/health`: `"signer": {"kind": "kms", "publicKey": "<KMS G>"}`, `"account": "<sponsor G>"` and `"accountSource": "SPONSOR_ACCOUNT_ID"` |
| 10 | One real signature per network | testnet: `pnpm --filter @lumenia/web exec playwright test e2e/claim.spec.ts`; mainnet: one small claim inside the pilot caps |
| 11 | CloudTrail shows one `Sign` per sponsor signature | screenshot of the entry matched to the transaction |
| 12 | Remove the hot key from the Worker | `npx wrangler secret delete SPONSOR_SECRET` (`--env mainnet`), then `npx wrangler secret list` (screenshot: no `SPONSOR_SECRET` row) |

### 2.3 Rollback

For one week after step 12 the hot key stays a signer of the account at weight 1, kept offline. To
roll back, in this order: `npx wrangler secret put SPONSOR_SECRET`, then
`npx wrangler secret delete KMS_KEY_ID` (each deploys at once; `SPONSOR_ACCOUNT_ID` can stay). After
the week, lowering the hot key's weight to 0 is a separate decision (runbook section 3) that this
cutover does not make, and that needs a second, independent cold signer first. Until then the honest description is "the
production signer runs on KMS; the old key remains a signer, offline, as the rollback until
<date>".

### 2.4 Cutover log

| | Testnet | Mainnet |
|---|---|---|
| `kms-check` result and the KMS G address | _pending_ | _pending_ |
| SetOptions hash (stellar.expert) | _pending_ | _pending_ |
| The account's signer list after it (Horizon `/accounts/<G>`) | _pending_ | _pending_ |
| Watchdog page + auto-halt on the SetOptions, and the clear | _pending_ | _pending_ |
| `/health` after the deploy (`signer.kind`) | _pending_ | _pending_ |
| The first KMS-signed transaction | _pending_ | _pending_ |
| CloudTrail `Sign` entry matched to it | _pending_ | _pending_ |
| `wrangler secret list` without `SPONSOR_SECRET` | _pending_ | _pending_ |
| Rollback date (hot key at weight 1 until) | _pending_ | _pending_ |

---

## 3. The watchdog heartbeat and the dead-man workflow

Every watchdog run (the Cron Trigger, every 15 minutes on each Worker) ends by writing
`watchdog:<network>:lastrun`, an ISO timestamp, and `/health` reports it as
`"watchdog": {"lastRun": ..., "ageSeconds": ...}`. A run writes the stamp even when every check in it
failed: the stamp says the watchdog ran, the pages say what it found.

A second stamp, `watchdog:<network>:lastfull`, is written only by a run in which every check
completed, and `/health` reports it as `watchdog.lastFullRun`. The workflow also fails when it is
older than 3 hours, when either stamp is more than 5 minutes in the future, when `/health` is not a
JSON object, and when the mainnet Worker reports `alerting.configured` other than true (testnet
reports it and passes). Only the Worker's scheduled run halts or writes: `runWatchdog` without
`{ autoHalt: true, heartbeat: true }` is read-only, which is what the local smoke test uses.

`.github/workflows/watchdog-heartbeat.yml` reads both `/health` pages from outside Cloudflare twice an
hour (at minutes 7 and 37) and fails when a page cannot be fetched or its stamp is missing or older
than 45 minutes (three missed runs). A failure opens one issue labelled `watchdog-heartbeat`, or
comments on the open one; the next healthy run closes it. It also runs on demand (Actions, "Run
workflow").

What GitHub itself says about scheduled workflows, and what it means here: they run only on the
default branch, the shortest interval is 5 minutes, runs can be delayed or dropped under load, and in a
public repository they are disabled after 60 days without repository activity. So the threshold is 45
minutes, not 16, and a quiet repository must re-enable the workflow (Actions tab) after 60 days. This
repository's other scheduled workflows have started 4 to 7 hours after their cron time, so the real
detection delay of this one is unmeasured and may be hours: the workflow is a second line, and an
independent cron monitor pinged by each watchdog run would be the first (not built).

Before the D3 Worker is deployed, `/health` carries no stamp and the workflow fails with "no watchdog
stamp in /health (deploy the D3 Worker ...)". That first failure is expected.

Log:

| | |
|---|---|
| First green run of the workflow (link) | _pending: after the push and both deploys_ |
| `/health` stamp on the testnet Worker | _pending_ |
| `/health` stamp on the mainnet Worker | _pending_ |

Rollback: disable the workflow in the Actions tab. The stamp costs one store write per run.

---

## 4. The auto-halt

The watchdog halts the sponsor on its own on exactly two findings, the two signatures of a key in
someone else's hands:

- "Sponsor SOURCED a forbidden operation" (a payment, merge, offer, claimable balance or set_options
  whose source is the sponsor account);
- "Escrow WASM CHANGED - the contract was upgraded" (the deployed escrow bytecode differs from
  `LUMENDROP_WASM_HASH`).

It writes `sponsor:halt:<network>` and a stamped reason next to it; every value route and both
approval routes of that network answer 503 within about 5 seconds, and `/health` shows
`"halt": {"halted": true, "source": "store", "reason": "<time> watchdog auto-halt: <finding>"}`. It
never halts on the float, the onboarding capacity, the escrow's state expiry, a governance event or a
check that failed to run, because a halt also blocks the exit routes (claims and take-backs) and must
not strand recipients over a condition that is not a theft. Those page a person instead.

The key is per network: a testnet halt never stops mainnet. The older bare key `sponsor:halt` still
halts both networks at once when an operator means exactly that.

The KMS cutover's own `SetOptions` is a sponsor-sourced `set_options`, so it trips the first finding by
design (section 2.2, step 5). That is the live proof of the auto-halt; the cutover log records it.

To resume after confirming the finding was expected:
`curl -H "authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/del/sponsor:halt:<network>"` and
the same for `sponsor:halt:<network>:reason` (the token is typed into the shell, never printed).

For the wasm finding after an upgrade you made, first set `LUMENDROP_WASM_HASH` to the new hash (the
page names it) and deploy that Worker, and only then delete the halt key: the pin wins, so deleting
the key first lasts only until the next run, about 15 minutes later, which halts again and emails at
once whatever the alert cooldown. A forbidden operation older than 24 hours, and a wasm mismatch that
a second read 2 seconds later does not repeat, page without halting. Each of our own sponsor-sourced
SetOptions (the cutover, a rotation) trips the first finding; the run that writes that halt has
already scanned past the operation, so resume after it. During a rotation (two SetOptions), the
page for the second one may not be emailed: the halt is already set and the alert's cooldown holds
the mail. Confirm the run reached it from `/health` (`halt.reason`'s time is the first halt's; the
watchdog's `lastRun` must be later than the second SetOptions), from `wrangler tail`, or from the
account's newest operations, then resume.

Known limit, stated plainly: the store read behind the halt fails OPEN. If the store cannot be read,
the sponsor runs as if not halted, so that a counter-store outage never strands recipients. The stop
that needs no store is `npx wrangler deploy --var SPONSOR_HALT:1` (or the same var set in
`wrangler.toml`), which the rehearsal above exercised.
