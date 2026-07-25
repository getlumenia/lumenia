/**
 * ============================================================================
 *  SPIKE #10 — Gasless v2 reclaim (C2 recovery lever for the DEFAULT send path)
 * ============================================================================
 *
 *  The default bearer-link send is v2 (Soroban LumenDrop), whose abandoned-link
 *  recovery is a CONTRACT `reclaim(link)` — NOT a classic claimClaimableBalance. This
 *  proves the new /v2-reclaim relayer: a 0-XLM sponsored sender deposits a drop with a
 *  short expiry, abandons it, and after expiry reclaims it GASLESSLY (the sponsor
 *  fee-bumps the sender-signed `reclaim` invoke) — their USDC returns, they pay no gas.
 *  Mirror of the classic spike9, for v2.
 *
 *  RUN: SPONSOR_SECRET=S… USDC_ISSUER_SECRET=S… pnpm --filter @lumenia/sponsor spike10
 *  NEEDS: internet (Horizon + Soroban RPC + friendbot). Testnet, no real money.
 * ============================================================================
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
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { makeConfig } from "./lib/config.js";
import { signerFromSecret } from "./lib/signer.js";
import { horizon, submit, friendbot, nativeBalance, trustlineBalance } from "./lib/stellar.js";
import { createAccountHandler } from "./lib/create-account.js";
import { relayDepositHandler, relayReclaimHandler } from "./lib/soroban-relay.js";

const NET = Networks.TESTNET;
const RPC = new rpc.Server("https://soroban-testnet.stellar.org");
// Overridable so the same proof can gate a redeploy (hardening passes deploy NEW contract ids).
const CONTRACT =
  process.env.LUMENDROP_CONTRACT ?? "CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S";
const USDC = new Asset("USDC", "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC");
const need = (n: string) => process.env[n] ?? (() => { throw new Error(`set ${n}`); })();
const ISSUER = Keypair.fromSecret(need("USDC_ISSUER_SECRET"));
const SPONSOR = Keypair.fromSecret(need("SPONSOR_SECRET"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(step: string, msg: string) {
  console.log(`\n[${step}] ${msg}`);
}

/** Assemble + sender-sign a contract invoke, then return its XDR for the relayer to fee-bump. */
async function signInvoke(sender: Keypair, call: xdr.Operation): Promise<string> {
  const src = await RPC.getAccount(sender.publicKey());
  const tx = new TransactionBuilder(src, { fee: "2000000", networkPassphrase: NET })
    .addOperation(call)
    .setTimeout(120)
    .build();
  const sim = await RPC.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(sender);
  return prepared.toXDR();
}

async function main() {
  console.log("============================================================");
  console.log(` SPIKE #10 — Gasless v2 reclaim vs live LumenDrop ${CONTRACT.slice(0, 8)}…`);
  console.log("============================================================");

  const config = makeConfig({ network: "testnet", sponsorSecret: SPONSOR.secret(), usdcIssuer: USDC.getIssuer()!, lumendropContract: CONTRACT });
  const HZ = horizon(config);
  const signer = signerFromSecret(SPONSOR.secret());
  const sender = Keypair.random(); // a fresh 0-XLM sponsored sender
  const link = Keypair.random(); // the drop id (its public key)
  const linkPub = Buffer.from(link.rawPublicKey());

  log("1", "Onboard a 0-XLM sponsored sender (create-account) + issue 10 USDC");
  {
    const created = await createAccountHandler(HZ, config, signer, { recipientPublicKey: sender.publicKey() });
    const tx = TransactionBuilder.fromXDR(created.xdr, NET) as Transaction;
    tx.sign(sender);
    await submit(HZ, tx);
    const acc = await HZ.loadAccount(ISSUER.publicKey());
    const pay = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET })
      .addOperation(Operation.payment({ destination: sender.publicKey(), asset: USDC, amount: "10" }))
      .setTimeout(120)
      .build();
    pay.sign(ISSUER);
    await submit(HZ, pay);
  }
  console.log(`   sender: ${await trustlineBalance(HZ, sender.publicKey(), "USDC", USDC.getIssuer()!)} USDC, ${await nativeBalance(HZ, sender.publicKey())} XLM`);

  log("2", "Sender deposits a 6 USDC drop with a SHORT expiry — gaslessly via /v2-deposit");
  const expiry = Math.floor(Date.now() / 1000) + 5; // ledger timestamp ≈ wall clock; reclaimable ~5s on
  {
    const call = new Contract(CONTRACT).call(
      "deposit",
      Address.fromString(sender.publicKey()).toScVal(),
      xdr.ScVal.scvBytes(linkPub),
      nativeToScVal(60_000_000n, { type: "i128" }), // 6 USDC
      nativeToScVal(BigInt(expiry), { type: "u64" }),
    );
    const xdrStr = await signInvoke(sender, call);
    await relayDepositHandler(config, signer, { xdr: xdrStr, senderPublicKey: sender.publicKey() });
  }
  const usdcAfterDeposit = await trustlineBalance(HZ, sender.publicKey(), "USDC", USDC.getIssuer()!);
  console.log(`   ✔ deposited; sender USDC now escrowed: ${usdcAfterDeposit} (was 10, 6 in the drop)`);

  log("3", "Drop ABANDONED (no one claims). Wait past expiry, then RECLAIM gaslessly via /v2-reclaim");
  void expiry;
  await sleep(15000); // comfortably past the ~5s expiry + ledger-close lag
  {
    const call = new Contract(CONTRACT).call("reclaim", xdr.ScVal.scvBytes(linkPub));
    const xdrStr = await signInvoke(sender, call);
    const res = await relayReclaimHandler(config, signer, { xdr: xdrStr, senderPublicKey: sender.publicKey() });
    console.log(`   ✔ /v2-reclaim relayed → ${res.hash.slice(0, 16)}…`);
  }

  const usdcAfter = await trustlineBalance(HZ, sender.publicKey(), "USDC", USDC.getIssuer()!);
  const xlmAfter = await nativeBalance(HZ, sender.publicKey());
  const usdcReturned = Number.parseFloat(usdcAfter) === 10;
  const stillGasless = xlmAfter === "0.0000000";
  const pass = usdcReturned && stillGasless;

  console.log("\n============================================================");
  console.log(pass ? " ✅ SPIKE #10 PASS" : " ❌ SPIKE #10 FAIL");
  console.log("============================================================");
  console.log(` sender USDC returned to 10 (6 reclaimed) : ${usdcReturned}  [${usdcAfter}]`);
  console.log(` sender still 0 XLM (gasless v2 reclaim)  : ${stillGasless}  [${xlmAfter}]`);
  console.log("\n The v2 default-send path now has a gasless reclaim: /v2-reclaim fee-bumps the");
  console.log(" sender's contract reclaim(link). The contract only pays the recorded sender.");
  if (!pass) process.exit(1);
}

main().catch((e) => { console.error("\n💥 SPIKE #10 crashed:", (e as Error).message); process.exit(1); });
