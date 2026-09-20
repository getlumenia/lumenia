/**
 * Anchor LIVE test, TRY IN: a plain SEP-6 deposit against the real sandbox anchor with a throwaway
 * account that already holds the USDC trustline (the state every Lumenia account is in, because the
 * sponsor opens the trustline at creation). Groundwork for the deposit screen the event build adds
 * (HACKATHON_DURING.md 2.1): it proves the sequence and records the status walk and the hashes, and
 * it is the recorded fallback if the sandbox's settlement queue starves on the day.
 *
 * Since the hackathon build (2026-09-19) every step goes through the PRODUCT client in
 * lib/anchor.ts, the same calls the /add-money/bank screen makes: `startDeposit`,
 * `simulateBankTransfer` and `readDeposit`. It was written against the raw endpoints first
 * (2026-09-18) and switched over once that client existed.
 *
 *   1. SEP-1 + SEP-10 (challenge verified against the anchor's SIGNING_KEY before signing).
 *   2. GET /sep6/deposit?asset_code=USDC&account=<G>&amount=<TRY>&funding_method=bank_account
 *      -> id, instructions (bank name, IBAN, reference), eta, min/max, extra_info.message.
 *   3. The sandbox bank: POST /sep6/tx/{id}/simulate-bank-transfer {"amount":"<TRY>"} (no auth).
 *   4. Poll GET /sep6/transaction?id=... until completed (or error); record every status seen,
 *      the on-chain payment id and the USDC amount that landed.
 *
 * Spends nothing real. Testnet only. RUN: pnpm --filter @lumenia/web test:anchor-deposit-live
 *   (env: AMOUNT_TRY, default 100; NEXT_PUBLIC_ANCHOR_HOME_DOMAIN, default the sandbox anchor)
 */
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { authenticate, readAnchorInfo, readDeposit, simulateBankTransfer, startDeposit, withSession, type AnchorSession } from "./anchor";
import { activeNetwork, USDC_ISSUER } from "./network";
import { localSignerFromSeed } from "./signer";

const HOME = (process.env.NEXT_PUBLIC_ANCHOR_HOME_DOMAIN ?? "tr-mock-anchor.fly.dev").trim();
const AMOUNT_TRY = process.env.AMOUNT_TRY ?? "100.00";
const WAIT_MS = 3 * 60_000;
const POLL_MS = 3_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const step = (m: string) => console.log(`[${at()}] ${m}`);

async function main() {
  const net = activeNetwork();
  if (net.isMainnet || net.passphrase !== Networks.TESTNET) throw new Error("testnet only");
  const horizon = new Horizon.Server(net.horizonUrl);
  const usdc = new Asset("USDC", USDC_ISSUER.testnet);

  // 1. A throwaway account in the state the sponsor leaves every account in: funded + trustline.
  const kp = Keypair.random();
  const signer = localSignerFromSeed(kp.rawSecretKey());
  const fb = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(kp.publicKey())}`);
  if (!fb.ok) throw new Error(`friendbot ${fb.status}`);
  const acc = await horizon.loadAccount(kp.publicKey());
  const trust = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(120)
    .build();
  trust.sign(kp);
  const trustHash = (await horizon.submitTransaction(trust)).hash;
  step(`account ${kp.publicKey()}, trustline ${trustHash}`);

  // 2. SEP-1 + SEP-10 through the product client.
  const info = await readAnchorInfo(HOME);
  if (info.door !== "sep6") throw new Error(`anchor door is ${info.door}`);
  const session: AnchorSession = { info, token: await authenticate(info, signer, net), signer, net };
  step(`SEP-10 ok at ${info.homeDomain} (signing key ${info.signingKey.slice(0, 8)}...)`);

  // 3. Plain SEP-6 deposit through the product client: bare asset code, the trustlined account, TRY.
  const dep = await withSession(session, (token) =>
    startDeposit(info, token, { assetCode: "USDC", account: kp.publicKey(), amount: AMOUNT_TRY }),
  );
  step(`deposit ${dep.id}: eta ${dep.eta}s, fee ${dep.feePercent}%`);
  for (const i of dep.instructions) step(`  instruction ${i.key}: ${i.value}${i.description ? ` (${i.description})` : ""}`);
  step(`  anchor said: ${dep.note ?? "(nothing)"}`);
  const first = await withSession(session, (token) => readDeposit(info, token, dep.id));
  step(`status right after opening: ${first.status}${first.status === "waiting" ? ` / ${first.stage} (${first.raw})` : ""}`);

  // 4. The sandbox bank transfer, through the guarded client call (refuses off the test network).
  await simulateBankTransfer(info, dep.id, AMOUNT_TRY, net);
  step("simulated bank transfer accepted");

  // 5. Status walk until a terminal state.
  const seen: string[] = [];
  const deadline = Date.now() + WAIT_MS;
  let final: Awaited<ReturnType<typeof readDeposit>> | null = null;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const st = await withSession(session, (token) => readDeposit(info, token, dep.id));
    const label = st.status === "waiting" ? `waiting/${st.stage}(${st.raw})` : st.status;
    if (seen[seen.length - 1] !== label) {
      seen.push(label);
      step(`status ${label}`);
    }
    if (st.status !== "waiting") {
      final = st;
      break;
    }
  }
  if (!final) throw new Error(`no terminal status inside the wait; statuses seen: ${seen.join(" -> ")}`);
  if (final.status !== "settled") throw new Error(`terminal status ${final.status}: ${JSON.stringify(final).slice(0, 300)}`);

  const bal = await horizon.loadAccount(kp.publicKey());
  const usdcBal = bal.balances.find((b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER.testnet);

  console.log("\nRESULT");
  console.log(`  anchor              ${info.homeDomain}`);
  console.log(`  account             ${kp.publicKey()}`);
  console.log(`  trustline tx        ${trustHash}`);
  console.log(`  deposit id          ${dep.id}`);
  const ins = (k: string) => dep.instructions.find((i) => i.key === k)?.value ?? "?";
  console.log(`  reference           ${ins("external_transfer_memo")} to IBAN ${ins("bank_account_number")}`);
  console.log(`  status walk         ${seen.join(" -> ")}`);
  console.log(`  amount in / out     ${final.amountIn} TRY -> ${final.amountOut} USDC (fee ${final.amountFee})`);
  console.log(`  stellar payment     ${final.stellarTransactionId}`);
  console.log(`  recipient USDC now  ${usdcBal?.balance ?? "0"}`);
  console.log(`  total               ${at()}`);
  console.log("\nANCHOR DEPOSIT LIVE TEST PASS");
}

main().catch((e) => {
  console.error(`\nANCHOR DEPOSIT LIVE TEST FAIL at ${at()}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
