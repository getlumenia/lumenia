# RUNBOOK — a bounded mainnet evidence run

> **What this is:** a handful of real-money claim links, so a reviewer can click one and watch USDC
> move on the public network. **What it is not:** a product launch. The app stays testnet for
> users; these are a few links with tiny amounts behind tight caps.
>
> **Nothing in this repo spends money by itself.** Every step below is yours to run.

## Why this does not need KMS or a multisig

Both protect value that does not exist here. A multisig guards against someone stealing the owner
key and upgrading the contract to take user funds — the only funds present are your own ~$10, and
at this size a single key is actually *better*, because you can pause in thirty seconds without
coordinating co-signers. KMS guards the sponsor's XLM float, which will hold about 8 XLM.

The risk that *is* real once a sponsor is on a public URL is strangers spending its float. That is
covered by what already ships: the anti-drain validator, rate limits, the canary caps below, and
the kill-switch. Keep the float small and the caps low, and the worst case stays a rounding error.

**When this stops being true:** the moment other people's money is in the contract. Then the
decision packet's KMS + timelock + multisig items come back, and so does the audit.

## Cost

Measured, not estimated (XLM ≈ $0.18 at the time of writing — re-check before you buy):

| | |
|---|---|
| Contract deploy (21 KB wasm upload + instance) | ~5 XLM |
| Sponsor account minimum balance | 1 XLM |
| Each walletless recipient (account + USDC trustline) | 1.5 XLM ≈ $0.27 — *locked, not spent* |
| Per transaction | ~0.005 XLM — negligible |
| USDC in the drops | your choice; it comes back when you claim to your own wallet |

**Buy about $10 of XLM and $5 of USDC.** That covers the deploy, the sponsor float, four or five
walletless claims, and the drops themselves, with room to spare. The reserves are recoverable
later by merging the demo accounts.

---

## 1. Money into Freighter

Buy XLM, then swap a few dollars of it to USDC inside Freighter (it opens the USDC trustline for
you). Keep the rest as XLM.

**Your Freighter secret is never used below.** You only ever *send* to addresses you are about to
generate.

## 2. Generate the demo keys

```bash
pnpm --filter @lumenia/sponsor mainnet-demo keys
```

Two throwaway keypairs are printed once — save both secrets somewhere safe for the length of the
demo:

- **SPONSOR** — pays fees and recipient reserves. Needs XLM only, never USDC.
- **SENDER** — the money in the drops. Needs a little XLM and the USDC.

## 3. Fund them from Freighter

| To | Amount |
|---|---|
| sponsor address | **~10 XLM** (covers the contract deploy in step 4 and the float) |
| sender address | **~3 XLM** + the USDC you want to demo (e.g. 5 USDC) |

## 4. Deploy the escrow to mainnet

```bash
cd contracts/lumen-drop
stellar contract build
shasum -a 256 target/wasm32v1-none/release/lumen_drop.wasm      # note this hash

stellar keys add mainnet-deployer --secret-key                  # paste the SPONSOR secret
stellar contract deploy \
  --wasm target/wasm32v1-none/release/lumen_drop.wasm \
  --source mainnet-deployer --network mainnet \
  -- --token CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75 \
     --owner <THE SPONSOR ADDRESS>
```

`CCW67TSZ…MI75` is Circle's mainnet USDC as a Soroban contract. It is derived deterministically
from the asset, and the same derivation reproduces our known testnet address exactly — but derive
it yourself if you want to be sure.

The owner being the sponsor address is fine for a demo. For anything with other people's money it
must be a timelock plus multisig, which is what the decision packet covers.

Note the **contract id** and the **wasm hash** — both go into the next step.

## 5. Configure and deploy the mainnet sponsor

It is a **separate Worker** (`lumenia-sponsor-mainnet`), so nothing here can affect the testnet
product. Fill in the two blanks in `apps/sponsor/wrangler.toml` under `[env.mainnet.vars]`:

```toml
LUMENDROP_CONTRACT  = "C…"        # from step 4
LUMENDROP_WASM_HASH = "…"         # from step 4
```

Then the secrets and the deploy:

```bash
cd apps/sponsor
wrangler secret put SPONSOR_SECRET   --env mainnet    # the sponsor secret from step 2
wrangler secret put USDC_ISSUER      --env mainnet    # GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
wrangler secret put KV_REST_API_URL  --env mainnet    # same Upstash as testnet is fine
wrangler secret put KV_REST_API_TOKEN --env mainnet
wrangler secret put RESEND_API_KEY   --env mainnet    # optional, for watchdog email
wrangler secret put ALERT_NOTIFY_TO  --env mainnet    # optional, your email
wrangler deploy --env mainnet
```

`CAPS_FAIL_CLOSED = "1"` is already set for mainnet: if the cap counter is unreachable, the
sponsor creates **no** escrow rather than falling back. Caps are **5 USDC per drop, 50 per day**.

Check it: `curl https://lumenia-sponsor-mainnet.<your-subdomain>.workers.dev/health`

## 6. Point the site at it (for mainnet links only)

The claim page reads the network from the link itself (`?n=public`), so one deployment serves
both. Add these to Vercel (Production) and redeploy:

```
NEXT_PUBLIC_LUMENDROP_CONTRACT_MAINNET = C…            # from step 4
NEXT_PUBLIC_SPONSOR_URL_MAINNET        = https://lumenia-sponsor-mainnet.….workers.dev
```

Until both are set, a mainnet link refuses to claim and says so — it never silently falls back to
testnet. Testnet links are unaffected either way.

## 7. Create the links

```bash
SENDER_SECRET=S… LUMENDROP_CONTRACT=C… \
SPONSOR_URL=https://lumenia-sponsor-mainnet.….workers.dev \
  pnpm --filter @lumenia/sponsor mainnet-demo links 4 0.5
```

Four drops of 0.5 USDC. It prints the claim links and the transaction hashes.

**Each link's `#fragment` is the key to real money.** Anyone who sees a link can claim it. Send
them one at a time, not in a public channel.

## 8. Verify before you send

Open one link yourself in a private window and claim it. You should see the money land and a
`stellar.expert/explorer/public/...` link — that is the evidence. Then create a replacement for
the one you spent.

Worth sending alongside the links:
- the contract: `https://stellar.expert/explorer/public/contract/<contract id>`
- a claim transaction, which shows the recipient paying no fee

## 9. Afterwards

- Claim any unclaimed links to your own wallet, or wait 7 days and reclaim them — the money is
  never stuck either way.
- Merge the demo recipient accounts back to recover the locked reserves.
- Leave the mainnet Worker deployed or `wrangler delete --env mainnet`; it costs nothing idle.
- The watchdog is already running on 15-minute cron against the mainnet contract and sponsor.

## If something looks wrong

```bash
# halt every value-moving endpoint immediately (no deploy needed)
curl -H "authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/set/sponsor:halt/1"

# stop new escrow at the contract (claims and reclaims keep working)
stellar contract invoke --id <contract> --source mainnet-deployer --network mainnet \
  -- pause --caller <sponsor address>
```

Full incident sequence: [RUNBOOK_SPONSOR_KEY.md](RUNBOOK_SPONSOR_KEY.md) §4.
