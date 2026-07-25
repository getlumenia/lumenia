/**
 * LIVE v2 CHECK — a real money loop against the DEPLOYED sponsor Worker over HTTP.
 *
 * This is the post-deploy smoke test: it exercises the same endpoints a browser would, so it
 * proves the deployed configuration (contract id, canary caps, legacy allowlist) is what we
 * think it is — not just that the code compiles.
 *
 *   1. gasless deposit into the CURRENT escrow via /v2-deposit
 *   2. walletless + gasless claim via /v2-claim (recipient pays nothing)
 *   3. the canary cap actually rejects an over-limit send
 *   4. a claim against a SUPERSEDED escrow still works (links already in the wild)
 *
 * RUN: USDC_ISSUER_SECRET=S… pnpm --filter @lumenia/sponsor exec tsx src/live-v2-check.ts
 *      [SPONSOR_URL=https://…]
 */
import {
  rpc,
  Horizon,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

const SPONSOR = (process.env.SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev").replace(/\/$/, "");
const NET = Networks.TESTNET;
const RPC = new rpc.Server("https://soroban-testnet.stellar.org");
const HZ = new Horizon.Server("https://horizon-testnet.stellar.org");
const CURRENT = process.env.LUMENDROP_CONTRACT ?? "CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S";
const LEGACY = process.env.LUMENDROP_LEGACY ?? "CDYEDHBPMDOOZSJGB2Z6JVK7GS3S5CWNXNGTEPMJFS25TAWSYHTXA2RF";
const USDC = new Asset("USDC", "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC");
const UNIT = 10_000_000n;

function need(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`set ${n}`);
  return v;
}
const ISSUER = Keypair.fromSecret(need("USDC_ISSUER_SECRET"));

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

async function friendbot(pub: string) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${pub}: ${r.status}`);
}
async function classicTx(source: Keypair, ...ops: xdr.Operation[]) {
  const acc = await HZ.loadAccount(source.publicKey());
  const b = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET });
  for (const o of ops) b.addOperation(o);
  const tx = b.setTimeout(60).build();
  tx.sign(source);
  await HZ.submitTransaction(tx);
}
async function usdcBalance(pub: string): Promise<string> {
  const acc = await HZ.loadAccount(pub);
  const l = acc.balances.find((b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC.getIssuer());
  return l ? l.balance : "0";
}
async function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${SPONSOR}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const B = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));
const addr = (p: string) => Address.fromString(p).toScVal();
const expiry7d = () => nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600), { type: "u64" });

/** Build + sign a `deposit` invoke the sender authorizes but does not pay gas for. */
async function buildDeposit(contract: string, sender: Keypair, link: Keypair, usdc: bigint) {
  const acc = await RPC.getAccount(sender.publicKey());
  const tx = new TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET })
    .addOperation(
      new Contract(contract).call(
        "deposit",
        addr(sender.publicKey()),
        B(link.rawPublicKey()),
        nativeToScVal(usdc * UNIT, { type: "i128" }),
        expiry7d(),
      ),
    )
    .setTimeout(120)
    .build();
  const sim = await RPC.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`deposit sim: ${sim.error}`);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(sender);
  return prepared.toEnvelope().toXDR("base64");
}

async function claimMessage(contract: string, source: string, link: Keypair, payout: string) {
  const acc = await RPC.getAccount(source);
  const tx = new TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET })
    .addOperation(
      new Contract(contract).call(
        "claim_message",
        nativeToScVal(1, { type: "u32" }),
        B(link.rawPublicKey()),
        addr(payout),
      ),
    )
    .setTimeout(60)
    .build();
  const sim = await RPC.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`claim_message: ${sim.error}`);
  return scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval) as Uint8Array;
}

async function newPayout(): Promise<Keypair> {
  const kp = Keypair.random();
  await friendbot(kp.publicKey());
  await classicTx(kp, Operation.changeTrust({ asset: USDC }));
  return kp;
}

async function main() {
  console.log("============================================================");
  console.log(` LIVE v2 CHECK — ${SPONSOR}`);
  console.log("============================================================\n");

  console.log("[0] the deployed service answers");
  const health = (await (await fetch(`${SPONSOR}/health`)).json()) as { ok?: boolean; network?: string };
  check("/health is ok on testnet", health.ok === true && health.network === "testnet");

  console.log("[1] fund a sender with USDC");
  const sender = Keypair.random();
  await friendbot(sender.publicKey());
  await classicTx(sender, Operation.changeTrust({ asset: USDC }));
  // Enough to also BUILD an over-cap transaction in step [4] — otherwise that deposit fails on
  // an insufficient balance before it ever reaches the sponsor's cap check, and would "pass"
  // for the wrong reason.
  await classicTx(ISSUER, Operation.payment({ destination: sender.publicKey(), asset: USDC, amount: "200" }));

  console.log("[2] gasless deposit into the CURRENT escrow via the live /v2-deposit");
  const link = Keypair.random();
  const dep = await post("/v2-deposit", {
    xdr: await buildDeposit(CURRENT, sender, link, 5n),
    senderPublicKey: sender.publicKey(),
  });
  check("/v2-deposit → 200", dep.status === 200, dep.text.slice(0, 90));
  check("5 USDC escrowed (sender 200 → 195)", (await usdcBalance(sender.publicKey())) === "195.0000000");

  console.log("[3] walletless + gasless claim via the live /v2-claim");
  const payout = await newPayout();
  const xlmBefore = (await HZ.loadAccount(payout.publicKey())).balances.find((b: any) => b.asset_type === "native")!.balance;
  const msg = await claimMessage(CURRENT, payout.publicKey(), link, payout.publicKey());
  const cl = await post("/v2-claim", {
    method: "claim",
    linkHex: Buffer.from(link.rawPublicKey()).toString("hex"),
    payout: payout.publicKey(),
    sigHex: Buffer.from(link.sign(Buffer.from(msg))).toString("hex"),
  });
  check("/v2-claim → 200", cl.status === 200, cl.text.slice(0, 90));
  check("the payout received the 5 USDC", (await usdcBalance(payout.publicKey())) === "5.0000000");
  const xlmAfter = (await HZ.loadAccount(payout.publicKey())).balances.find((b: any) => b.asset_type === "native")!.balance;
  check("the recipient paid no gas", xlmBefore === xlmAfter, `${xlmAfter} XLM`);

  console.log("[4] the canary cap is live — an over-limit deposit is refused");
  const bigLink = Keypair.random();
  const big = await post("/v2-deposit", {
    xdr: await buildDeposit(CURRENT, sender, bigLink, 150n), // over the 100 USDC per-drop cap, within balance
    senderPublicKey: sender.publicKey(),
  });
  check("an over-cap /v2-deposit is rejected", big.status !== 200, `${big.status}`);
  check("the rejection names the canary cap", /canary cap/.test(big.text), big.text.slice(0, 120));

  console.log("[5] a link in a SUPERSEDED escrow still claims (already-sent links keep working)");
  const oldLink = Keypair.random();
  // Deposit directly (the relayer refuses new escrow into a superseded contract, by design).
  const oldXdr = await buildDeposit(LEGACY, sender, oldLink, 3n);
  const oldTx = TransactionBuilder.fromXDR(oldXdr, NET);
  const sent = await RPC.sendTransaction(oldTx as never);
  if (sent.status === "ERROR") throw new Error(`legacy deposit: ${JSON.stringify(sent.errorResult)}`);
  for (let i = 0; i < 30; i++) {
    const g = await RPC.getTransaction(sent.hash);
    if (g.status !== "NOT_FOUND") break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const oldPayout = await newPayout();
  const oldMsg = await claimMessage(LEGACY, oldPayout.publicKey(), oldLink, oldPayout.publicKey());
  const oldClaim = await post("/v2-claim", {
    method: "claim",
    linkHex: Buffer.from(oldLink.rawPublicKey()).toString("hex"),
    payout: oldPayout.publicKey(),
    sigHex: Buffer.from(oldLink.sign(Buffer.from(oldMsg))).toString("hex"),
    contract: LEGACY,
  });
  check("/v2-claim against the superseded escrow → 200", oldClaim.status === 200, oldClaim.text.slice(0, 90));
  check("that payout received its 3 USDC", (await usdcBalance(oldPayout.publicKey())) === "3.0000000");

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ LIVE v2 CHECK PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\n💥", e?.message ?? e);
  process.exit(1);
});
