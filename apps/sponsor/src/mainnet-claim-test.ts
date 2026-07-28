/**
 * MAINNET CLAIM TEST — walk one real link through the exact path the claim page uses.
 *
 * A link that has never been claimed is a promise, not evidence. This runs the whole flow on
 * mainnet with real money: the sponsor creates a fresh account with a USDC trustline for a
 * recipient who holds nothing, the link key signs a payout to it, the relayer submits the claim
 * and pays the fee, and the USDC lands. The recipient's XLM balance is asserted to be unchanged.
 *
 * RUN: LINK_SECRET=S… pnpm --filter @lumenia/sponsor exec tsx src/mainnet-claim-test.ts
 */
import {
  rpc,
  Horizon,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

const NET = Networks.PUBLIC;
const RPC = new rpc.Server("https://mainnet.sorobanrpc.com");
const HZ = new Horizon.Server("https://horizon.stellar.org");
const SPONSOR = (process.env.SPONSOR_URL ?? "https://lumenia-sponsor-mainnet.avakit.workers.dev").replace(/\/$/, "");
const CONTRACT = process.env.LUMENDROP_CONTRACT ?? "CAC5JYQ2XEEVJ54EXC7KCG6MTARO5CSUQ2WNKSOM6FALCCU5UTEIWGR4";
const USDC = new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

async function usdcBalance(pub: string): Promise<string> {
  const acc = await HZ.loadAccount(pub);
  const l = acc.balances.find((b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC.getIssuer());
  return l ? l.balance : "0";
}
async function xlmBalance(pub: string): Promise<string> {
  const acc = await HZ.loadAccount(pub);
  return (acc.balances.find((b: any) => b.asset_type === "native") as any).balance;
}

async function main() {
  const secret = process.env.LINK_SECRET;
  if (!secret) throw new Error("set LINK_SECRET (the #fragment of the claim link)");
  const link = Keypair.fromSecret(secret);
  const linkHex = Buffer.from(link.rawPublicKey()).toString("hex");

  console.log("============================================================");
  console.log(" MAINNET CLAIM TEST — real money, real network");
  console.log("============================================================\n");
  console.log(`  drop: ${linkHex.slice(0, 16)}…`);

  console.log("\n[1] a recipient who holds nothing at all");
  const payout = Keypair.random();
  console.log(`  ${payout.publicKey()}`);

  console.log("[2] the sponsor creates their account + USDC trustline (they pay nothing)");
  const created = (await (
    await fetch(`${SPONSOR}/create-account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipientPublicKey: payout.publicKey() }),
    })
  ).json()) as { xdr?: string; error?: string };
  if (!created.xdr) throw new Error(created.error ?? "create-account failed");
  const sandwich = TransactionBuilder.fromXDR(created.xdr, NET) as Transaction;
  sandwich.sign(payout); // the recipient co-signs their own account creation
  await HZ.submitTransaction(sandwich);
  const xlmBefore = await xlmBalance(payout.publicKey());
  check("account exists with a USDC trustline", (await usdcBalance(payout.publicKey())) === "0.0000000");
  check("recipient holds 0 XLM of their own", Number.parseFloat(xlmBefore) === 0, `${xlmBefore} XLM`);

  console.log("[3] the link key signs a payout to that address");
  const src = await RPC.getAccount(payout.publicKey());
  const view = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: NET })
    .addOperation(
      new Contract(CONTRACT).call(
        "claim_message",
        nativeToScVal(1, { type: "u32" }),
        xdr.ScVal.scvBytes(Buffer.from(link.rawPublicKey())),
        Address.fromString(payout.publicKey()).toScVal(),
      ),
    )
    .setTimeout(60)
    .build();
  const sim = await RPC.simulateTransaction(view);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`claim_message: ${sim.error}`);
  const msg = scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval) as Uint8Array;

  console.log("[4] the relayer submits the claim and pays the fee");
  const res = await fetch(`${SPONSOR}/v2-claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "claim",
      linkHex,
      payout: payout.publicKey(),
      sigHex: Buffer.from(link.sign(Buffer.from(msg))).toString("hex"),
    }),
  });
  const text = await res.text();
  check("/v2-claim → 200", res.ok, text.slice(0, 120));
  if (!res.ok) throw new Error(text);
  const { hash } = JSON.parse(text) as { hash: string };

  console.log("[5] the money");
  check("the recipient received 0.5 USDC", (await usdcBalance(payout.publicKey())) === "0.5000000");
  check("the recipient still paid no gas", (await xlmBalance(payout.publicKey())) === xlmBefore);

  console.log("\n  claim tx : https://stellar.expert/explorer/public/tx/" + hash);
  console.log("  recipient: https://stellar.expert/explorer/public/account/" + payout.publicKey());
  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ MAINNET CLAIM TEST PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\n💥", e?.message ?? e);
  process.exit(1);
});
