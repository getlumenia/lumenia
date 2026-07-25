# RUNBOOK — Sponsor key custody, rotation, and incident response

> The sponsor key signs fee-bumps and sponsored account-creations. It NEVER holds user value
> and is NEVER a signer on a user account or the escrow — its blast radius is the sponsor's
> own XLM float. Keep that float low; everything below shrinks the window in which a stolen
> key can spend it. Testnet today; every step here is mainnet-ready design.

## 1. Current state

- Signer seam: `apps/sponsor/src/lib/signer.ts` (`SponsorSigner`, sync or async `sign`).
- Testnet default: `EnvKeypairSigner` from the Worker secret `SPONSOR_SECRET`.
- KMS path: `apps/sponsor/src/lib/kms-signer.ts` — **code-complete + unit-tested (13/13,
  `pnpm --filter @lumenia/sponsor test:kms`)**, activated by config only (§2). Not yet
  provisioned against live AWS.
- Kill-switch: `apps/sponsor/src/lib/kill-switch.ts` — see §4.

## 2. KMS cutover (HUMAN step — real AWS account + small spend, ~$2.50/mo at 100k signs)

1. **Create the key** (region close to the Worker's traffic, e.g. `eu-central-1`):
   `aws kms create-key --key-spec ECC_NIST_EDWARDS25519 --key-usage SIGN_VERIFY`
2. **Least-privilege key policy** — the Worker's IAM user gets ONLY:
   ```json
   {
     "Sid": "sponsor-sign-only",
     "Effect": "Allow",
     "Principal": { "AWS": "arn:aws:iam::<acct>:user/lumenia-sponsor-worker" },
     "Action": ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"],
     "Resource": "*"
   }
   ```
   Admin actions (`kms:PutKeyPolicy`, `ScheduleKeyDeletion`, `DisableKey`, …) live ONLY on a
   separate human break-glass role. The private key is non-exportable by design. CloudTrail
   logs every `Sign` — keep it on; that log is the forensic trail.
3. **Derive the account**: `GetPublicKey` → 44-byte DER SPKI → last 32 bytes → G... address
   (the code does this at boot; `stellar keys` can cross-check).
4. **Fund + trustline** the new G... account (it becomes the sponsor account), pre-fund the
   channel accounts from it as today.
5. **Cut over the Worker** (`apps/sponsor`):
   `wrangler secret put AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`,
   `wrangler deploy` with vars `KMS_KEY_ID=<key-arn>`, `KMS_REGION=<region>` —
   `getServiceAsync()` then signs via KMS and the env hot-key is never constructed.
   Remove `SPONSOR_SECRET` once the new account is proven with one live signed tx.
6. **Verify**: `/health` shows the KMS-derived `sponsorPublicKey`; run one real
   `/create-account` + `/v2-claim`; confirm the CloudTrail `Sign` entries match 1:1.
7. **Fail-closed check**: KMS errors → the endpoint 5xxes. There is deliberately no silent
   fallback to an env key; do not add one.

## 3. Key rotation (planned)

Asymmetric KMS keys cannot auto-rotate. Rotation = **new key, then move the on-chain identity**:

1. Create the new KMS key (§2.1–2.3) → new raw pubkey.
2. On the SPONSOR ACCOUNT run a `SetOptions`: add the new pubkey as a signer (weight = master),
   then in a second `SetOptions` drop the old master weight to 0 — the account G... address
   stays the same, so no Worker/env change beyond `KMS_KEY_ID`.
   (Alternative: stand up a fresh sponsor account and drain the float across — needed only if
   the ADDRESS itself must change.)
3. Flip `KMS_KEY_ID` to the new key, deploy, verify (§2.6).
4. Disable (not delete) the old KMS key; schedule deletion after a 30-day soak.

## 4. Incident response (suspected key compromise / anomalous spend)

Symptoms: Monitor alert on unexpected sponsor outflow (ops/monitor), fee spend spike,
CloudTrail `Sign` calls you cannot attribute.

1. **HALT — instant, no deploy:**
   `curl -H "authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/set/sponsor:halt/1"`
   → every value-moving endpoint (`/create-account /feebump /send-link /sweep /v2-claim
   /v2-deposit /v2-reclaim /faucet /demo-link`) returns 503 within ~5s (cache TTL).
   Belt-and-suspenders: set the Worker var `SPONSOR_HALT=1` + `wrangler deploy` (hard stop
   that needs no KV).
2. **Freeze the key**: env-key era — treat the secret as burned; KMS era — break-glass role
   runs `aws kms disable-key` (Sign stops globally, CloudTrail keeps the evidence).
3. **Drain the float** to the treasury/cold address (the sponsor holds only XLM float —
   users' USDC sits in the escrow contract and classic claimable balances, untouched).
4. **Rotate** per §3 into a NEW key; re-fund with a LOW float; unhalt
   (`.../del/sponsor:halt`, remove `SPONSOR_HALT`).
5. **Post-mortem**: CloudTrail + Horizon history of the sponsor account; write it up; adjust
   caps/limits before raising the float again.

## 5. Standing posture

- Sponsor float: keep ≤ a few days of expected fee spend; top up from treasury on a schedule.
- Channel accounts bound per-channel exposure; the anti-drain validator
  (`test-antidrain.ts`, 44/44) bounds what a signed tx can even ask for; Upstash rate-limit
  bounds request volume. The kill-switch bounds TIME. Four independent brakes.
- OZ Monitor (ops/monitor) is the tripwire that makes §4 start in minutes, not days.
