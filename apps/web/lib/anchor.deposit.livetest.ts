/**
 * Anchor LIVE test, TRY IN: a plain SEP-6 deposit against the real sandbox anchor with a throwaway
 * account that already holds the USDC trustline (the state every Lumenia account is in, because the
 * sponsor opens the trustline at creation). Groundwork for the deposit screen the event build adds
 * (HACKATHON_DURING.md 2.1): it proves the sequence and records the status walk and the hashes, and
 * it is the recorded fallback if the sandbox's settlement queue starves on the day.
 *
 * It deliberately uses the RAW SEP-6 endpoints for the deposit itself (no `startDeposit` in
 * lib/anchor.ts yet: that client code is event work, decision D27). SEP-1 discovery and SEP-10
 * sign-in come from lib/anchor.ts, exactly as the product does them.
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
import { authenticate, readAnchorInfo, withSession, type AnchorSession } from "./anchor";
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

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

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

  // 3. Plain SEP-6 deposit: bare asset code, the account the sponsor trustlined, amount in TRY.
  const q = new URLSearchParams({ asset_code: "USDC", account: kp.publicKey(), amount: AMOUNT_TRY, funding_method: "bank_account" });
  const opened = await withSession(session, async (token) => {
    const r = await getJson(`${info.transferServer}/deposit?${q}`, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error("auth"), { status: r.status });
    return r;
  });
  if (opened.status !== 200) throw new Error(`/deposit ${opened.status}: ${JSON.stringify(opened.body)}`);
  const dep = opened.body as {
    id: string;
    how?: string;
    eta?: number;
    min_amount?: number;
    max_amount?: number;
    fee_percent?: number;
    instructions?: Record<string, { value: string; description?: string }>;
    extra_info?: { message?: string };
  };
  step(`deposit ${dep.id}: eta ${dep.eta}s, limits ${dep.min_amount}-${dep.max_amount} TRY, fee ${dep.fee_percent}%`);
  for (const [k, v] of Object.entries(dep.instructions ?? {})) step(`  instruction ${k}: ${v.value}${v.description ? ` (${v.description})` : ""}`);
  step(`  anchor said: ${dep.extra_info?.message ?? dep.how ?? "(nothing)"}`);

  // 4. The sandbox bank transfer (unauthenticated on the mock; a real bank does this off-chain).
  const sim = await getJson(`${info.transferServer}/tx/${encodeURIComponent(dep.id)}/simulate-bank-transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: AMOUNT_TRY }),
  });
  step(`simulate-bank-transfer -> ${sim.status} ${JSON.stringify(sim.body).slice(0, 160)}`);
  if (sim.status !== 200 && sim.status !== 201) throw new Error("the sandbox bank refused the transfer");

  // 5. Status walk until completed.
  const seen: string[] = [];
  const deadline = Date.now() + WAIT_MS;
  let final: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const r = await withSession(session, async (token) => {
      const x = await getJson(`${info.transferServer}/transaction?id=${encodeURIComponent(dep.id)}`, { headers: { authorization: `Bearer ${token}` } });
      if (x.status === 401 || x.status === 403) throw Object.assign(new Error("auth"), { status: x.status });
      return x;
    });
    const t = (r.body as { transaction?: Record<string, unknown> })?.transaction;
    const status = String(t?.status ?? "?");
    if (seen[seen.length - 1] !== status) {
      seen.push(status);
      step(`status ${status}${t?.message ? ` (${String(t.message)})` : ""}`);
    }
    if (status === "completed" || status === "error" || status === "refunded") {
      final = t ?? null;
      break;
    }
    if (status === "pending_trust") step("  (pending_trust would mean no trustline; ours is open, so this should never appear)");
  }
  if (!final) throw new Error(`no terminal status inside the wait; statuses seen: ${seen.join(" -> ")}`);
  if (final.status !== "completed") throw new Error(`terminal status ${String(final.status)}: ${JSON.stringify(final).slice(0, 300)}`);

  const bal = await horizon.loadAccount(kp.publicKey());
  const usdcBal = bal.balances.find((b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER.testnet);

  console.log("\nRESULT");
  console.log(`  anchor              ${info.homeDomain}`);
  console.log(`  account             ${kp.publicKey()}`);
  console.log(`  trustline tx        ${trustHash}`);
  console.log(`  deposit id          ${dep.id}`);
  console.log(`  reference           ${dep.instructions?.external_transfer_memo?.value ?? "?"} to IBAN ${dep.instructions?.bank_account_number?.value ?? "?"}`);
  console.log(`  status walk         ${seen.join(" -> ")}`);
  console.log(`  amount in / out     ${String(final.amount_in)} TRY -> ${String(final.amount_out)} USDC (fee ${String(final.amount_fee)})`);
  console.log(`  stellar payment     ${String(final.stellar_transaction_id)}`);
  console.log(`  recipient USDC now  ${usdcBal?.balance ?? "0"}`);
  console.log(`  total               ${at()}`);
  console.log("\nANCHOR DEPOSIT LIVE TEST PASS");
}

main().catch((e) => {
  console.error(`\nANCHOR DEPOSIT LIVE TEST FAIL at ${at()}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
