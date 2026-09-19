/**
 * Anchor LIVE test: the exact `/send-out/bank` sequence against the real sandbox anchor and the
 * real testnet sponsor, with a throwaway account. NOT part of the offline gate (needs the network,
 * friendbot, the sponsor's faucet and the anchor); run it before a demo, after an anchor redeploy,
 * or after any change to lib/anchor.ts, lib/offramp.ts or the bank screen.
 *
 * What it proves, in order:
 *   1. SEP-1 discovery of `NEXT_PUBLIC_ANCHOR_HOME_DOMAIN` (default: the Turkish sandbox anchor).
 *   2. SEP-10 sign-in with the challenge verified against the anchor's published SIGNING_KEY.
 *   3. A plain SEP-6 `/withdraw` (D2: no quote, no customer fields) naming a treasury + id memo.
 *   4. The payment leaving on the SAME path the screen uses: lib/payout.ts `sendOut`, sender-signed,
 *      fee-bumped by the sponsor under its PAYOUT policy.
 *   5. The anchor settling the withdrawal, read through `withSession` (renews the token on 401/403)
 *      with the same tolerant polling the screen uses.
 *
 * It spends 1 practice dollar from the sponsor's testnet faucet and nothing else. Testnet only:
 * the faucet 403s on any other network and this file refuses to run against mainnet.
 *
 * RUN: pnpm --filter @lumenia/web test:anchor-live
 *      (env: NEXT_PUBLIC_ANCHOR_HOME_DOMAIN, NEXT_PUBLIC_SPONSOR_URL optional)
 */
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { authenticate, readAnchorInfo, readWithdrawal, readWithdrawLimits, startWithdrawal, withSession, type AnchorSession, type AnchorWithdrawalState } from "./anchor";
import { activeNetwork } from "./network";
import { sendOut } from "./payout";
import { localSignerFromSeed } from "./signer";

const HOME = (process.env.NEXT_PUBLIC_ANCHOR_HOME_DOMAIN ?? "tr-mock-anchor.fly.dev").trim();
const SPONSOR = (process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev").replace(/\/$/, "");
const AMOUNT = "1.00";
const SETTLE_TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 3_000;
const MAX_POLL_MISSES = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
function step(msg: string) {
  console.log(`[${at()}] ${msg}`);
}

async function main() {
  const net = activeNetwork();
  if (net.isMainnet || net.passphrase !== Networks.TESTNET) throw new Error("this live test runs on testnet only");
  const horizon = new Horizon.Server(net.horizonUrl);
  const usdc = new Asset("USDC", (await (await fetch(`${SPONSOR}/health`)).json() as { usdcIssuer: string }).usdcIssuer);

  // 1. A throwaway account, funded by friendbot, holding the pinned USDC trustline.
  const kp = Keypair.random();
  const signer = localSignerFromSeed(kp.rawSecretKey());
  step(`throwaway account ${kp.publicKey()}`);
  const fb = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(kp.publicKey())}`);
  if (!fb.ok) throw new Error(`friendbot ${fb.status}`);
  const acc = await horizon.loadAccount(kp.publicKey());
  const trust = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(120)
    .build();
  trust.sign(kp);
  const trustRes = await horizon.submitTransaction(trust);
  step(`trustline opened: ${trustRes.hash}`);

  // 2. One practice dollar from the sponsor's faucet (the sandbox anchor's minimum cash-out).
  const faucet = await fetch(`${SPONSOR}/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipientPublicKey: kp.publicKey() }),
  });
  const faucetBody = (await faucet.json()) as { hash?: string; amount?: string; error?: string };
  if (!faucet.ok || !faucetBody.hash) throw new Error(`faucet: ${faucet.status} ${JSON.stringify(faucetBody)}`);
  step(`faucet paid ${faucetBody.amount} USDC: ${faucetBody.hash}`);

  // 3. The screen's sequence: discover, read limits, sign in, open a plain withdrawal.
  const info = await readAnchorInfo(HOME);
  if (info.door !== "sep6") throw new Error(`the anchor opens the ${info.door} door; the bank screen needs sep6`);
  step(`SEP-1: ${info.homeDomain}, signing key ${info.signingKey.slice(0, 8)}..., door ${info.door}`);
  const limits = await readWithdrawLimits(info, "USDC");
  step(`published withdraw limits: min ${limits.min} max ${limits.max} fee ${limits.feePercent}%`);
  const session: AnchorSession = { info, token: await authenticate(info, signer, net), signer, net };
  step("SEP-10: challenge verified against SIGNING_KEY, signed, token received");
  const opened = await withSession(session, (token) =>
    startWithdrawal(info, token, { assetCode: "USDC", account: kp.publicKey(), amount: AMOUNT }),
  );
  if (opened.kind !== "ready-to-pay") throw new Error("the anchor did not name where to pay");
  step(`SEP-6 withdraw ${opened.id}: pay ${opened.destination.slice(0, 8)}... memo ${opened.memo} (${opened.memoType})`);
  step(`anchor said: ${opened.note ?? "(nothing)"}`);
  if (opened.memoType !== "id" && opened.memoType !== "text") throw new Error(`memo type ${opened.memoType} is not payable here`);

  // 4. Pay, exactly as the screen does: sender-signed payment, sponsor fee-bump via /payout.
  const paid = await sendOut({
    sponsorUrl: SPONSOR,
    signer,
    amount: AMOUNT,
    destination: opened.destination,
    memo: opened.memo ?? undefined,
    memoKind: opened.memoType,
    onHandedOver: ({ hash }) => step(`payment handed to the sponsor: ${hash}`),
  });
  step(`payment confirmed on the ledger: ${paid.hash}`);

  // 5. Wait for the anchor, tolerantly, renewing the session if it forgets us.
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let misses = 0;
  let final: AnchorWithdrawalState | null = null;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let state: AnchorWithdrawalState;
    try {
      state = await withSession(session, (token) => readWithdrawal(info, token, opened.id));
      misses = 0;
    } catch (e) {
      if (++misses >= MAX_POLL_MISSES) throw e;
      step(`status read failed (${misses}/${MAX_POLL_MISSES}), retrying: ${(e as Error).message}`);
      continue;
    }
    if (state.status === "settled" || state.status === "refunded" || state.status === "failed") {
      final = state;
      break;
    }
  }
  if (!final) throw new Error("the anchor did not settle inside the wait");
  if (final.status !== "settled") throw new Error(`anchor ended in ${final.status}: ${"reason" in final ? final.reason : ""}`);
  step(`anchor settled withdrawal ${opened.id}`);

  console.log("\nRESULT");
  console.log(`  network        testnet (${net.horizonUrl})`);
  console.log(`  anchor         ${info.homeDomain}`);
  console.log(`  account        ${kp.publicKey()}`);
  console.log(`  trustline tx   ${trustRes.hash}`);
  console.log(`  faucet tx      ${faucetBody.hash}`);
  console.log(`  payment tx     ${paid.hash}`);
  console.log(`  withdrawal id  ${opened.id}`);
  console.log(`  memo           ${opened.memo} (${opened.memoType})`);
  console.log(`  anchor note    ${opened.note ?? "(none)"}`);
  console.log(`  total          ${at()}`);
  console.log("\nANCHOR LIVE TEST PASS");
}

main().catch((e) => {
  console.error(`\nANCHOR LIVE TEST FAIL at ${at()}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
