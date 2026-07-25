/**
 * RELAYER PROOF — the v2 /v2-claim relayer handler, against the LIVE testnet contract.
 * Mirrors the web client's claimV2 (read claim_message → sign with the link key) and drives the
 * REAL relayClaimHandler (the same code the deployed /v2-claim function runs): a sender deposits,
 * a payout is chosen, the link key signs it, and the SPONSOR relayer submits + pays the fee.
 *
 * RUN: SPONSOR_SECRET=S... USDC_ISSUER_SECRET=S... \
 *      pnpm --filter @lumenia/sponsor exec tsx src/lumendrop-relay-test.ts
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
import { makeConfig } from "./lib/config.js";
import { signerFromSecret } from "./lib/signer.js";
import { relayClaimHandler } from "./lib/soroban-relay.js";
import { createAccountHandler } from "./lib/create-account.js";

const NET = Networks.TESTNET;
const RPC = new rpc.Server("https://soroban-testnet.stellar.org");
const HZ = new Horizon.Server("https://horizon-testnet.stellar.org");
// Overridable so the same proof can gate a redeploy (hardening passes deploy NEW contract ids).
const CONTRACT =
  process.env.LUMENDROP_CONTRACT ?? "CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S";
const USDC = new Asset("USDC", "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC");
const need = (n: string) => process.env[n] ?? (() => { throw new Error(`set ${n}`); })();
const ISSUER = Keypair.fromSecret(need("USDC_ISSUER_SECRET"));
const SPONSOR = Keypair.fromSecret(need("SPONSOR_SECRET"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`); ok ? pass++ : fail++; };

async function friendbot(pub: string) { const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`); if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`); }
async function classic(source: Keypair, ...ops: xdr.Operation[]) {
  const acc = await HZ.loadAccount(source.publicKey());
  const b = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET });
  for (const o of ops) b.addOperation(o);
  const tx = b.setTimeout(60).build(); tx.sign(source); await HZ.submitTransaction(tx);
}
async function usdcHolder(kp: Keypair, receive?: string) {
  await friendbot(kp.publicKey());
  await classic(kp, Operation.changeTrust({ asset: USDC }));
  if (receive) await classic(ISSUER, Operation.payment({ destination: kp.publicKey(), asset: USDC, amount: receive }));
}
async function usdcBal(pub: string) { const a = await HZ.loadAccount(pub); const l = a.balances.find((b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC.getIssuer()); return l ? l.balance : "0"; }
async function xlmBal(pub: string) { const a = await HZ.loadAccount(pub); return a.balances.find((b: any) => b.asset_type === "native")!.balance; }
/** Deposit `amountStroops` USDC behind `linkPub`, sender-signed Soroban invoke. */
async function deposit(sender: Keypair, linkPub: Buffer, amountStroops: bigint) {
  const src = await RPC.getAccount(sender.publicKey());
  const tx = new TransactionBuilder(src, { fee: "2000000", networkPassphrase: NET })
    .addOperation(new Contract(CONTRACT).call("deposit",
      Address.fromString(sender.publicKey()).toScVal(),
      xdr.ScVal.scvBytes(linkPub),
      nativeToScVal(amountStroops, { type: "i128" }),
      nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600), { type: "u64" }),
    )).setTimeout(60).build();
  const sim = await RPC.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(sender);
  await sorobanSubmit(prepared);
}
/** Read claim_message from the contract (as the client does) + sign it with the link key. */
async function signClaim(sourcePub: string, link: Keypair, payout: string): Promise<string> {
  const src = await RPC.getAccount(sourcePub);
  const view = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: NET })
    .addOperation(new Contract(CONTRACT).call("claim_message",
      nativeToScVal(1, { type: "u32" }), xdr.ScVal.scvBytes(Buffer.from(link.rawPublicKey())), Address.fromString(payout).toScVal(),
    )).setTimeout(60).build();
  const sim = await RPC.simulateTransaction(view);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const message = scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval) as Uint8Array;
  return Buffer.from(link.sign(Buffer.from(message))).toString("hex");
}
async function sorobanSubmit(tx: any) {
  const sent = await RPC.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(JSON.stringify(sent.errorResult));
  let g = await RPC.getTransaction(sent.hash);
  for (let i = 0; i < 40 && g.status === "NOT_FOUND"; i++) { await sleep(1500); g = await RPC.getTransaction(sent.hash); }
  if (g.status !== "SUCCESS") throw new Error(`tx ${g.status}`);
}

async function main() {
  console.log("============================================================");
  console.log(" RELAYER PROOF — /v2-claim handler vs live LumenDrop " + CONTRACT.slice(0, 8) + "…");
  console.log("============================================================\n");

  const config = makeConfig({ network: "testnet", sponsorSecret: SPONSOR.secret(), usdcIssuer: USDC.getIssuer()!, lumendropContract: CONTRACT });
  const signer = signerFromSecret(SPONSOR.secret());

  console.log("[1] set up a sender (XLM + 20 USDC) + a fresh payout (trustline) + a link key");
  const sender = Keypair.random();
  const payout = Keypair.random();
  const link = Keypair.random();
  await Promise.all([usdcHolder(sender, "20"), usdcHolder(payout)]);
  const linkPub = Buffer.from(link.rawPublicKey());

  console.log("[2] sender deposits 8 USDC behind the link (sender-signed Soroban invoke)");
  {
    const src = await RPC.getAccount(sender.publicKey());
    const tx = new TransactionBuilder(src, { fee: "2000000", networkPassphrase: NET })
      .addOperation(new Contract(CONTRACT).call("deposit",
        Address.fromString(sender.publicKey()).toScVal(),
        xdr.ScVal.scvBytes(linkPub),
        nativeToScVal(80_000_000n, { type: "i128" }),
        nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600), { type: "u64" }),
      )).setTimeout(60).build();
    const sim = await RPC.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(sender);
    await sorobanSubmit(prepared);
  }
  check("8 USDC escrowed (sender 20 → 12)", (await usdcBal(sender.publicKey())) === "12.0000000");

  console.log("[3] read claim_message (as the client does) + link key signs the chosen payout");
  const src = await RPC.getAccount(payout.publicKey());
  const view = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: NET })
    .addOperation(new Contract(CONTRACT).call("claim_message",
      nativeToScVal(1, { type: "u32" }), xdr.ScVal.scvBytes(linkPub), Address.fromString(payout.publicKey()).toScVal(),
    )).setTimeout(60).build();
  const sim = await RPC.simulateTransaction(view);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const message = scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval) as Uint8Array;
  const sigHex = Buffer.from(link.sign(Buffer.from(message))).toString("hex");

  console.log("[4] the SPONSOR relayer submits the claim + pays the fee (REAL relayClaimHandler)");
  const res = await relayClaimHandler(config, signer, { method: "claim", linkHex: linkPub.toString("hex"), payout: payout.publicKey(), sigHex });
  check("relayer returned a tx hash", typeof res.hash === "string", res.hash.slice(0, 12) + "…");
  check("payout received the 8 USDC (walletless + gasless)", (await usdcBal(payout.publicKey())) === "8.0000000");

  console.log("\n[5] CLAIM-PAGE path: sponsor creates a fresh 0-XLM account + trustline, then v2-claim into it");
  const sender2 = Keypair.random();
  const link2 = Keypair.random();
  const payout2 = Keypair.random(); // a brand-new walletless recipient (no friendbot)
  await usdcHolder(sender2, "20");
  await deposit(sender2, Buffer.from(link2.rawPublicKey()), 60_000_000n); // 6 USDC
  {
    // the sponsored 0-XLM account + USDC trustline (the same /create-account the claim page uses)
    const created = await createAccountHandler(HZ, config, signer, { recipientPublicKey: payout2.publicKey() });
    const sandwich = TransactionBuilder.fromXDR(created.xdr, NET);
    sandwich.sign(payout2);
    await HZ.submitTransaction(sandwich);
  }
  const sig2 = await signClaim(payout2.publicKey(), link2, payout2.publicKey());
  await relayClaimHandler(config, signer, { method: "claim", linkHex: Buffer.from(link2.rawPublicKey()).toString("hex"), payout: payout2.publicKey(), sigHex: sig2 });
  check("sponsored 0-XLM account received the v2 claim (6 USDC)", (await usdcBal(payout2.publicKey())) === "6.0000000");
  check("the recipient holds 0 XLM (walletless + gasless, end to end)", (await xlmBal(payout2.publicKey())) === "0.0000000");

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ RELAYER PROOF PASS (${pass}/${pass + fail})` : ` ❌ FAIL (${fail} failed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error("\n💥", (e as Error).message); process.exit(1); });
