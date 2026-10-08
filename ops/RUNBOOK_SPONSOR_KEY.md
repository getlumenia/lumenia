# RUNBOOK - Sponsor key custody, the KMS cutover, rotation, and incident response

> The sponsor key signs fee-bumps and sponsored account-creations. It NEVER holds user value
> and is NEVER a signer on a user account or the escrow - its blast radius is the sponsor's
> own XLM float. Keep that float low; everything below shrinks the window in which a stolen
> key can spend it. Written for both Workers (testnet `lumenia-sponsor`, mainnet
> `lumenia-sponsor-mainnet`); the mainnet steps carry the real-money rules.

## 1. Current state

- Signer seam: `apps/sponsor/src/lib/signer.ts` (`SponsorSigner`, sync or async `sign`).
- **The account is not the signer** (SOW 2, D3): `SponsorConfig.sponsorAccountId`
  (`lib/config.ts`, env `SPONSOR_ACCOUNT_ID`) is the address that sources operations, pays
  fee-bumps and owns the sponsored reserves; `signer.publicKey()` is only the key that signs. With
  no `SPONSOR_ACCOUNT_ID` the two are the same address (the env hot-key shape, which is what both
  Workers run until the cutover below). In KMS mode `SPONSOR_ACCOUNT_ID` is REQUIRED: without it
  the Worker refuses to start (every route answers 400, `/health` included) rather than fall back
  to the hot secret's address, which stops being right the moment section 2 step 7 deletes that
  secret. `/health` reports `account`, `signer.kind` (`"env"` or `"kms"`) with `signer.publicKey`,
  and where the account came from (`accountSource`: `"SPONSOR_ACCOUNT_ID"` or `"signer"`).
- Env hot-key signer: `EnvKeypairSigner` from the Worker secret `SPONSOR_SECRET`.
- KMS signer: `apps/sponsor/src/lib/kms-signer.ts` - code-complete and unit-tested offline
  (`pnpm --filter @lumenia/sponsor test:kms`: byte-parity with the SDK's own signatures, the
  account/signer split through every value handler and `/health`, and the transport against a
  stubbed KMS endpoint), activated by one on-chain SetOptions plus config (section 2). Until
  section 2 is executed on a Worker, that Worker is "KMS-ready, not KMS-backed", and no document
  may say otherwise.
- Kill-switch: `apps/sponsor/src/lib/kill-switch.ts` - see section 4. The watchdog
  (`lib/watchdog.ts`) halts the sponsor on its own on exactly two tripwires - see section 4.

## 2. KMS cutover: add the KMS key as a signer of the EXISTING sponsor account (HUMAN step)

The address, the XLM float, the sponsored reserves, the channel accounts and the web's sponsor pin
all stay. (There is no trustline to keep: on Horizon on 2026-10-08 both sponsor accounts, testnet
`GDQFGINJ4PMEX4GN53OHFFO657P5APN5BYEEDKRTNYC74FXUBCQTXDLL` and mainnet
`GBLBAKFVTS2GSEOUK3AKOZAO3I6T34YHNJPG4DMF5JODVWJDJIPDYZZ2`, hold XLM only, with `subentry_count`
0, the master key as their only signer and thresholds 0/0/0.) What changes is which key signs.
Testnet first, then mainnet. Cost: about USD 1 per key per month plus cents per 10,000 signatures.

No secret is ever typed on a command line in this section: a command line lands in the shell
history and on any recorded screen. Each one is read into the shell with `read -rs NAME && export
NAME` (paste, then Enter; nothing is echoed) and removed with `unset NAME` when the step is done.
Steps 2 to 4 run in `apps/sponsor`.

1. **Create the key and the IAM user, one pair PER NETWORK** (a leaked testnet credential must
   not be able to sign for the mainnet account):
   `aws kms create-key --key-spec ECC_NIST_EDWARDS25519 --key-usage SIGN_VERIFY --region eu-central-1`
   Least-privilege key policy - the Worker's IAM user gets ONLY:
   ```json
   {
     "Sid": "sponsor-sign-only",
     "Effect": "Allow",
     "Principal": { "AWS": "arn:aws:iam::<acct>:user/lumenia-sponsor-worker-<network>" },
     "Action": ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"],
     "Resource": "*"
   }
   ```
   Admin actions (`kms:PutKeyPolicy`, `ScheduleKeyDeletion`, `DisableKey`, ...) live ONLY on a
   separate human break-glass role. The private key is non-exportable by design. CloudTrail
   logs every `Sign` - keep it on; that log is the forensic trail. Keep the access key pair in a
   password manager; it leaves it only through `read -rs` (step 2) and `wrangler secret put`
   (step 4).
2. **Verify the live key before it touches any account:**
   ```
   read -r KMS_KEY_ID && export KMS_KEY_ID            # the key ARN
   read -rs AWS_ACCESS_KEY_ID && export AWS_ACCESS_KEY_ID
   read -rs AWS_SECRET_ACCESS_KEY && export AWS_SECRET_ACCESS_KEY
   KMS_REGION=eu-central-1 pnpm run kms-check
   unset KMS_KEY_ID AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
   ```
   It asks KMS for the public key, derives the G... address, signs ONE offline sample transaction
   and verifies it locally. `PASS` plus the address is the output; the address is the `--signer`
   below. A `FAIL` stops the cutover (the live KMS Ed25519 output has only ever been verified
   against a local stand-in before this step; this is the first real check).
3. **Add the signer: a dry run that signs nothing, then a submit of exactly that transaction:**
   ```
   pnpm run add-signer --network testnet \
     --account <the existing sponsor address, as /health shows it> \
     --signer <the address from step 2> \
     --out .cutover/testnet-setoptions.json
   ```
   The dry run needs no secret. It reads the account (one Horizon GET), refuses an `--out` that
   git would track (`.cutover/` is ignored; a relative path is read from the directory the command
   is typed in), and writes the UNSIGNED SetOptions, its hash, its one-hour timebound, and the
   account's signers and thresholds BEFORE the change. Read the file and record the hash: it is
   the public, verifiable trace of the cutover (a KMS-signed transaction looks like any other on
   chain, so the signer list and this hash are what a reviewer checks), and a transaction's hash
   does not cover its signatures, so the hash recorded now is the one that lands. Then:
   ```
   read -rs SPONSOR_SECRET && export SPONSOR_SECRET    # the hot key, from the password manager
   pnpm run add-signer --network testnet --submit \
     --in .cutover/testnet-setoptions.json --hash <the hash you recorded>
   unset SPONSOR_SECRET
   ```
   `--submit` refuses the file unless its transaction is still exactly the one reviewed: that
   hash, no signature on it, sourced by the account, ONE SetOptions that adds the KMS address as a
   signer of weight 1 and sets thresholds low/med/high to 1 and nothing else, inside its timebound,
   on an account whose sequence has not moved since the dry run (if it moved, run the dry run
   again). Then it signs with the master key, submits, and writes the outcome and the signers and
   thresholds AFTER the change back into the same file: keep that file, it is the cutover log. The
   master key's weight is not touched (it stays the rollback, step 8). On mainnet both runs need
   `I_UNDERSTAND_MAINNET=1` in the shell, and the tool prints no address, only the path, the hash
   and counts.
   **Expect the watchdog to page and to halt.** `set_options` sourced by the sponsor is the
   first key-compromise tripwire, and the watchdog answers it by halting that network's sponsor
   (section 4). Within 15 minutes of the submit: a page naming this hash, `/health` showing
   `halt.halted: true` with `halt.reason` naming the tripwire, every value route answering 503.
   Confirm the hash in the page (or, if no page arrived, the account's newest `set_options` on the
   explorer) matches the file, then resume (section 4, step 1, the `del` commands). The run that
   wrote the halt has already scanned past the SetOptions, so the next one does not halt again.
   This is the live proof that the auto-halt works; do it on testnet before mainnet.
4. **Tell the Worker which account it is, then give it the key, in this order.**
   `wrangler secret put` creates a new version of the Worker and deploys it at once, so
   `KMS_KEY_ID` goes in LAST: it is the switch into KMS mode, and KMS mode refuses to start
   without `SPONSOR_ACCOUNT_ID`.
   a. In `wrangler.toml`, in the block for that network (vars do not inherit across envs):
      `KMS_REGION = "eu-central-1"` and `SPONSOR_ACCOUNT_ID = "<the existing sponsor address>"`.
      Then `npx wrangler deploy` (testnet) or `npx wrangler deploy --env mainnet`. Still the hot
      key, same account; `/health` now shows `accountSource: "SPONSOR_ACCOUNT_ID"`.
   b. The credentials and the key id, as secrets (add `--env mainnet` for the mainnet Worker):
      ```
      npx wrangler secret put AWS_ACCESS_KEY_ID
      npx wrangler secret put AWS_SECRET_ACCESS_KEY
      npx wrangler secret put KMS_KEY_ID                 # the key ARN; LAST, this is the switch
      ```
      The key ARN is a secret rather than a `wrangler.toml` var: it is not a credential, but it
      names the AWS account, and `wrangler.toml` is in the public repository (`/health` leaves it
      out for the same reason). From that deploy on, `getServiceAsync()` signs through KMS and
      never constructs the hot key.
5. **Verify from outside:** `/health` shows `signer.kind: "kms"`, `signer.publicKey` = the KMS
   address, `account` = the existing address (unchanged), `sponsorPublicKey` = the same, and
   `accountSource: "SPONSOR_ACCOUNT_ID"`. A `/health` that answers 400 naming
   `SPONSOR_ACCOUNT_ID` (testnet; mainnet says only "request failed") means step 4a did not land:
   fix the var and deploy.
6. **Prove one real signature per network:** one `/create-account` + one `/v2-claim` (testnet:
   the live claim regression `apps/web/e2e/claim.spec.ts` does both; mainnet: one small claim
   inside the pilot caps). CloudTrail shows one `Sign` event per sponsor signature, 1:1 with the
   transactions; keep a screenshot of the matched entry for the evidence package.
7. **Remove the hot key from the Worker:** `npx wrangler secret delete SPONSOR_SECRET`
   (`--env mainnet` for mainnet), then `npx wrangler secret list` shows no `SPONSOR_SECRET` row
   (names only; keep the screenshot). The key is now only in the password manager, offline.
8. **Rollback, kept for ONE WEEK:** the hot key stays a signer at weight 1. To roll back, in this
   order (each command deploys at once): `wrangler secret put SPONSOR_SECRET`, then
   `wrangler secret delete KMS_KEY_ID`, which switches the Worker back to the hot key. The other
   way round, the Worker would run with neither key between the two commands, since step 7
   removed the hot one. `SPONSOR_ACCOUNT_ID` can stay: it names the same account. After the week, lowering the master weight to 0 is a separate decision (section 3);
   it is not part of the cutover, `add-signer` does not offer it, and section 3 step 0 comes first.
9. **Fail-closed check:** a KMS error reaches the client as HTTP 400 `{"error":"request failed","ref":...}`
   on mainnet (the Worker's generic redaction; the reference is in `wrangler tail`) and on testnet
   as `KMS <operation> failed: HTTP <status> <AWS error type>` (for example
   `DisabledException`). The AWS error body, which names the IAM principal and the AWS account, is
   only ever in `wrangler tail`. There is deliberately no silent fallback to an env key; do not
   add one. A KMS outage is therefore an outage of every route that signs, which the watchdog's
   float check does not see. `/health` shows it: it keeps answering, with `"ok": false` and
   `"signer": {"available": false}`, and the read and recovery routes stay up. A signature that
   fails gives its fee charge back, so retries during the outage do not spend the day's fee
   budget. The watchdog itself needs no KMS call and keeps running. Each KMS call gives up after one
   retry and five seconds, so a fresh isolate's first request (one GetPublicKey) fails in seconds
   rather than holding for most of a minute.

Real-money rules for the mainnet pass (section A4.10 of the sprint plan, repeated here): write
the file BEFORE submitting; never print `SPONSOR_SECRET`, `KV_REST_API_TOKEN`,
`PILOT_APPROVE_TOKEN` or the AWS pair, and never type them on a command line (`read -rs NAME &&
export NAME`, then `unset NAME`); filter mainnet command output before it reaches a terminal
that is being recorded; the 2-of-3 owner multisig (`docs/OWNER_MULTISIG_RUNBOOK.md`, local) is a
DIFFERENT account and is untouched by any of this.

## 3. Key rotation (planned)

Asymmetric KMS keys cannot auto-rotate. Rotation = **new key, same account**.

Every step here that changes the account's signers is a `SetOptions` sourced by the sponsor, and
the watchdog treats that as the key-compromise tripwire: within 15 minutes of EACH one it pages
(naming the transaction hash) and halts that network's sponsor, exit routes included. That is
expected. Confirm each hash is yours, and clear the halt (section 4, step 1, the `del` commands)
only after the page for the LAST SetOptions of the rotation has arrived: that run has scanned past
it, and a halt cleared earlier is written again by the run that scans the next one. Plan the
rotation for a quiet hour.

0. **Before the master key's weight ever goes to 0** (the decision after the cutover week,
   section 2 step 8), add a SECOND, independent cold signer to the account (weight 1; a key that
   never touches the Worker or AWS, for example a hardware wallet kept offline). `add-signer`
   signs with the master key only, so after the weight-0 change it can no longer change signers
   (it refuses and points here), and a KMS key disabled in an incident (section 4, step 2) cannot
   sign either. Without that second signer no key could sign the drain or the rotation.
1. Create the new KMS key (section 2, steps 1-2) -> new address.
2. On the SPONSOR ACCOUNT run a `SetOptions`: add the new address as a signer (weight 1). While
   the master key still has weight that is `add-signer` (section 2, step 3); after the weight-0
   change, run `add-signer`'s dry run (it needs no secret), sign the file's `unsignedXdr` with the
   cold signer in any Stellar signing tool that takes an XDR, and submit that. Then, in a second
   `SetOptions`, drop the old key's weight to 0 (a separate, hand-built transaction, signed the
   same way; `add-signer` deliberately only adds). The account address stays the same, so nothing
   in the web or the docs changes.
3. Flip the Worker to the new key: `npx wrangler secret put KMS_KEY_ID` with the new ARN (it
   deploys at once; `--env mainnet` for mainnet), then verify (section 2, step 5).
4. Disable (not delete) the old KMS key; schedule deletion after a 30-day soak.

## 4. Incident response (suspected key compromise / anomalous spend)

Symptoms: a watchdog page (float, a forbidden sponsor-sourced operation, a changed escrow wasm
hash, a governance event), fee spend spike, CloudTrail `Sign` calls you cannot attribute.

The watchdog halts on its own on exactly two of these: **a forbidden operation sourced by the
sponsor** (a payment or path payment, an account merge, an offer, a `create_claimable_balance` or
a `set_options`) and **a changed escrow wasm hash**, the two signatures of a stolen key. Never on
the float, the capacity floor, the state expiry, a governance event or a failed check, because a
halt also blocks the exit routes and must not strand recipients over a condition that is not a
theft. An auto-halt writes `sponsor:halt:<network>` and a stamped reason next to it; `/health`
shows `halt.source: "store"` and `halt.reason`. Our own operations trip it too: the cutover's and
each rotation's `SetOptions`, and the drain in step 3.

1. **HALT - instant, no deploy:**
   `curl -H "authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/set/sponsor:halt:mainnet/1"`
   (use `sponsor:halt:testnet` for the testnet Worker). Every value-moving endpoint
   (`/create-account /feebump /send-link /payout /sweep /v2-claim /v2-deposit /v2-reclaim /faucet
   /demo-link /cctp-relay`) and both grant routes (`/pilot-approve /pilot-reject`) return 503
   within ~5 s (cache TTL). The legacy bare key `sponsor:halt` still works and halts BOTH
   networks when the store is shared, which is right for "stop everything" and wrong for a
   rehearsal. Belt-and-suspenders: set the Worker var `SPONSOR_HALT=1` + `wrangler deploy` (hard
   stop that needs no store). **Resume:** `.../del/sponsor:halt:<network>` and
   `.../del/sponsor:halt:<network>:reason` (or remove `SPONSOR_HALT` and deploy).
   Before deleting an AUTO-halt, remove its cause, or the next run (15 minutes) writes it again:
   - the wasm tripwire: set `LUMENDROP_WASM_HASH` in that network's block of `wrangler.toml` to
     the new hash (the one in the page, after confirming the upgrade was ours) and deploy FIRST;
     the pinned hash wins over everything else the watchdog compares against, so a resume without
     the re-pin is halted again by the next run;
   - the forbidden-operation tripwire: delete the halt only once the page naming the LAST of our
     own operations (a rotation's second SetOptions, the drain) has arrived; that run has scanned
     past it.
   The store read fails OPEN by design: an outage of the counter store must not strand
   recipients; `SPONSOR_HALT=1` is the stop that needs no store.
2. **Freeze the key**: env-key era - treat the secret as burned; KMS era - break-glass role
   runs `aws kms disable-key` (Sign stops globally, CloudTrail keeps the evidence). From here the
   KMS key signs nothing, the drain and the rotation included: those are signed by the
   independent cold signer (section 3, step 0), or by the master key while it still has weight
   (the cutover week). Re-enable the KMS key (`aws kms enable-key`) for them only when it is
   certain that the KMS key and its IAM credentials are not what leaked; never when they are the
   suspect.
3. **Drain the float** to the treasury/cold address (the sponsor holds only XLM float -
   users' USDC sits in the escrow contract and classic claimable balances, untouched). The drain
   is a payment sourced by the sponsor, which the watchdog pages and halts on like any forbidden
   operation; expected, the sponsor is halted already.
4. **Rotate** per section 3 into a NEW key; re-fund with a LOW float; unhalt only after the
   watchdog has scanned the rotation's last SetOptions (step 1): a halt deleted before that is
   written again by the next run. The page for that last SetOptions may never be EMAILED (the halt
   is already set and the alert cooldown holds the mail), so confirm the scan from `/health`
   (`watchdog.lastRun` later than the SetOptions), `wrangler tail`, or the account's newest
   operations. When the Worker's AWS access key pair may have leaked too, a new KMS key is not
   enough (its policy names the same IAM user): create a new access key pair for that user,
   `wrangler secret put` both halves, then deactivate the old pair in IAM.
5. **Post-mortem**: CloudTrail + Horizon history of the sponsor account; write it up; adjust
   caps/limits before raising the float again.

## 5. Standing posture

- Sponsor float: keep <= a few days of expected fee spend; top up from treasury on a schedule.
  The per-day fee budget (`MAX_DAY_FEE_XLM`, lib/caps.ts) bounds what one day can spend in fees:
  each request counts its bid until the network decides it, then what the ledger charged (nothing
  for a transaction that never reached a ledger, a failed signature included); the watchdog pages
  at 80 percent of it.
- Channel accounts bound per-channel exposure; the anti-drain validator
  (the full `test-antidrain.ts` suite) bounds what a signed tx can even ask for; the relays
  simulate before they pay and refuse a fee above what the invoke needs; Upstash rate-limit
  bounds request volume; the onboarding budget bounds sponsored reserves per day and per source.
  The kill-switch bounds TIME. Independent brakes, none of them a store-only one except the
  budgets, which degrade per isolate rather than refuse.
- The watchdog's heartbeat (`watchdog:<network>:lastrun`, on `/health`) is read by a GitHub
  workflow scheduled every 30 minutes (`.github/workflows/watchdog-heartbeat.yml`; GitHub can start
  scheduled runs hours late or skip them, so detection can take longer), which opens one issue when
  a Worker's run stamp is missing, older than 45 minutes or more than 5 minutes in the future, when
  its full-run stamp (`watchdog:<network>:lastfull`, written only when every check completed) is
  older than 3 hours, or when the mainnet Worker reports `alerting.configured` other than true: the
  watchdog's liveness, its coverage and, on mainnet, its delivery configuration are monitored from
  a schedule that can run late.
- OZ Monitor configs (ops/monitor) remain a documented, not-deployed richer alternative.
