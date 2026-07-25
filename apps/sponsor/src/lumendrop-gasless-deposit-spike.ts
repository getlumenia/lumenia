/**
 * SPIKE — gasless v2 deposit: can the sponsor FEE-BUMP a sender-signed Soroban `deposit` invoke so
 * the sender pays 0 XLM? This is the load-bearing unknown for wiring createV2Link into /send (v1
 * senders hold 0 XLM). If this passes, the /v2-deposit relayer is straightforward.
 *
 * RUN: SPONSOR_SECRET=S... USDC_ISSUER_SECRET=S... \
 *      pnpm --filter @lumenia/sponsor exec tsx src/lumendrop-gasless-deposit-spike.ts
 */
import {
  rpc, Horizon, Address, Asset, Contract, Keypair, Networks, Operation,
  TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative, xdr,
} from "@stellar/stellar-sdk";
import { makeConfig } from "./lib/config.js";
import { createAccountHandler } from "./lib/create-account.js";
import { signerFromSecret } from "./lib/signer.js";
import { relayDepositHandler } from "./lib/soroban-relay.js";

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
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`); ok ? pass++ : fail++; };

async function classic(source: Keypair, ...ops: xdr.Operation[]) {
  const acc = await HZ.loadAccount(source.publicKey());
  const b = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET });
  for (const o of ops) b.addOperation(o);
  const tx = b.setTimeout(60).build(); tx.sign(source); await HZ.submitTransaction(tx);
}
async function xlm(pub: string) { const a = await HZ.loadAccount(pub); return a.balances.find((b: any) => b.asset_type === "native")!.balance; }
async function usdc(pub: string) { const a = await HZ.loadAccount(pub); const l = a.balances.find((b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC.getIssuer()); return l ? l.balance : "0"; }

async function main() {
  console.log("============================================================");
  console.log(" SPIKE — gasless v2 deposit (sponsor fee-bumps a Soroban invoke)");
  console.log("============================================================\n");
  const config = makeConfig({ network: "testnet", sponsorSecret: SPONSOR.secret(), usdcIssuer: USDC.getIssuer()!, lumendropContract: CONTRACT });
  const signer = signerFromSecret(SPONSOR.secret());

  console.log("[1] a 0-XLM sender (sponsored account + trustline), funded with 20 USDC");
  const sender = Keypair.random();
  {
    const created = await createAccountHandler(HZ, config, signer, { recipientPublicKey: sender.publicKey() });
    const sandwich = TransactionBuilder.fromXDR(created.xdr, NET);
    sandwich.sign(sender);
    await HZ.submitTransaction(sandwich);
    await classic(ISSUER, Operation.payment({ destination: sender.publicKey(), asset: USDC, amount: "20" }));
  }
  check("sender holds 0 XLM before the deposit", (await xlm(sender.publicKey())) === "0.0000000");

  console.log("[2] sender builds + signs a deposit invoke (7 USDC); sponsor FEE-BUMPS + submits");
  const link = Keypair.random();
  const src = await RPC.getAccount(sender.publicKey());
  const inner = new TransactionBuilder(src, { fee: "2000000", networkPassphrase: NET })
    .addOperation(new Contract(CONTRACT).call("deposit",
      Address.fromString(sender.publicKey()).toScVal(),
      xdr.ScVal.scvBytes(Buffer.from(link.rawPublicKey())),
      nativeToScVal(70_000_000n, { type: "i128" }),
      nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600), { type: "u64" }),
    )).setTimeout(120).build();
  const sim = await RPC.simulateTransaction(inner);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const prepared = rpc.assembleTransaction(inner, sim).build();
  prepared.sign(sender); // the SENDER authorizes (source-account auth), pays nothing

  // The REAL /v2-deposit handler: validates (contract + `deposit` + fee cap) then fee-bumps + submits.
  let hash = "";
  try {
    const r = await relayDepositHandler(config, signer, { xdr: prepared.toXDR(), senderPublicKey: sender.publicKey() });
    hash = r.hash;
    check("relayDepositHandler validated + fee-bumped + submitted", typeof hash === "string", hash.slice(0, 12) + "…");
  } catch (e) {
    check("relayDepositHandler validated + fee-bumped + submitted", false, (e as Error).message);
  }

  console.log("[3] verify the deposit landed + the sender paid NO gas");
  if (hash) {
    const view = new TransactionBuilder(await RPC.getAccount(SPONSOR.publicKey()), { fee: "1000000", networkPassphrase: NET })
      .addOperation(new Contract(CONTRACT).call("get_drop", xdr.ScVal.scvBytes(Buffer.from(link.rawPublicKey())))).setTimeout(60).build();
    const gsim = await RPC.simulateTransaction(view);
    const drop = rpc.Api.isSimulationError(gsim) ? null : (scValToNative((gsim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval) as any);
    check("the drop exists on-chain with amount 7 USDC", drop && Number(drop.amount) === 70_000_000, drop ? `amount=${drop.amount}` : "no drop");
  }
  check("sender USDC dropped by 7 (escrowed)", (await usdc(sender.publicKey())) === "13.0000000");
  check("sender STILL holds 0 XLM (gasless — the sponsor paid the fee)", (await xlm(sender.publicKey())) === "0.0000000");

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ GASLESS-DEPOSIT SPIKE PASS (${pass}/${pass + fail})` : ` ❌ FAIL (${fail} failed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error("\n💥", (e as Error).message); process.exit(1); });
