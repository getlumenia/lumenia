/**
 * LEGACY-CONTRACT FALLBACK PROOF (testnet) — the migration safety net for a contract upgrade.
 *
 * When the escrow contract is replaced, links already sitting in someone's chat still point at
 * drops held by the SUPERSEDED contract, and only that contract can release them. This proves
 * the relayer keeps those exits working while sending all NEW escrow to the current contract:
 *
 *   1. a drop deposited into the SUPERSEDED contract is claimable through the relayer
 *      (walletless + gasless, exactly as before the upgrade);
 *   2. a drop deposited into the CURRENT contract is claimable with no `contract` argument
 *      (the default path is unchanged);
 *   3. a foreign contract id is REJECTED — the fallback is an allowlist, not a free-for-all;
 *   4. NEW escrow (/v2-deposit) into a superseded contract is REJECTED — old escrows are
 *      exit-only, so the population there can only shrink.
 *
 * RUN: SPONSOR_SECRET=S… USDC_ISSUER_SECRET=S… pnpm --filter @lumenia/sponsor test:legacy
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
import { relayClaimHandler, relayDepositHandler } from "./lib/soroban-relay.js";

const NET = Networks.TESTNET;
const RPC = new rpc.Server("https://soroban-testnet.stellar.org");
const HZ = new Horizon.Server("https://horizon-testnet.stellar.org");

const CURRENT = process.env.LUMENDROP_CONTRACT ?? "CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S";
/** The interim hardened build — a real superseded escrow with the same interface. */
const LEGACY = process.env.LUMENDROP_LEGACY ?? "CAKEJAGCATVMJB6CMB6LM736DHUJ37YOTOER23SWRNDHPLTU2ZJUDIAB";
const USDC = new Asset("USDC", "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC");
const UNIT = 10_000_000n;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}
const ISSUER = Keypair.fromSecret(need("USDC_ISSUER_SECRET"));
const config = makeConfig({
  network: "testnet",
  sponsorSecret: need("SPONSOR_SECRET"),
  usdcIssuer: USDC.getIssuer() ?? "",
  lumendropContract: CURRENT,
  lumendropLegacyContracts: [LEGACY],
});
const signer = signerFromSecret(config.sponsorSecret);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
/** Build + sign a contract invoke as `source`, and submit it directly (no relayer). */
async function invoke(source: Keypair, contract: string, method: string, args: xdr.ScVal[]) {
  const acc = await RPC.getAccount(source.publicKey());
  const tx = new TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await RPC.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`sim ${method}: ${sim.error}`);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(source);
  const sent = await RPC.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send ${method}: ${JSON.stringify(sent.errorResult)}`);
  let g = await RPC.getTransaction(sent.hash);
  for (let i = 0; i < 30 && g.status === "NOT_FOUND"; i++) {
    await sleep(1500);
    g = await RPC.getTransaction(sent.hash);
  }
  if (g.status !== "SUCCESS") throw new Error(`${method} tx ${g.status}`);
  return sent.hash;
}
/** Read the exact message the link key must sign, from a specific contract. */
async function claimMessage(contract: string, source: string, linkPub: Uint8Array, payout: string) {
  const acc = await RPC.getAccount(source);
  const tx = new TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET })
    .addOperation(
      new Contract(contract).call(
        "claim_message",
        nativeToScVal(1, { type: "u32" }),
        xdr.ScVal.scvBytes(Buffer.from(linkPub)),
        Address.fromString(payout).toScVal(),
      ),
    )
    .setTimeout(60)
    .build();
  const sim = await RPC.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`claim_message on ${contract}: ${sim.error}`);
  return scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval) as Uint8Array;
}

const B = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));
const addr = (p: string) => Address.fromString(p).toScVal();
const expiry7d = () => nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600), { type: "u64" });

/** Deposit `usdcAmount` behind a fresh link key in `contract`; returns the link keypair. */
async function depositInto(contract: string, sender: Keypair, usdcAmount: bigint) {
  const link = Keypair.random();
  await invoke(sender, contract, "deposit", [
    addr(sender.publicKey()),
    B(link.rawPublicKey()),
    nativeToScVal(usdcAmount * UNIT, { type: "i128" }),
    expiry7d(),
  ]);
  return link;
}

/** A payout account that can hold USDC (fresh, trustlined). */
async function newPayout(): Promise<Keypair> {
  const kp = Keypair.random();
  await friendbot(kp.publicKey());
  await classicTx(kp, Operation.changeTrust({ asset: USDC }));
  return kp;
}

async function main() {
  console.log("============================================================");
  console.log(" LEGACY-CONTRACT FALLBACK PROOF (testnet)");
  console.log(`  current: ${CURRENT.slice(0, 10)}…   superseded: ${LEGACY.slice(0, 10)}…`);
  console.log("============================================================\n");

  console.log("[1] fund a sender with USDC");
  const sender = Keypair.random();
  await friendbot(sender.publicKey());
  await classicTx(sender, Operation.changeTrust({ asset: USDC }));
  await classicTx(ISSUER, Operation.payment({ destination: sender.publicKey(), asset: USDC, amount: "20" }));

  console.log("[2] a drop in the SUPERSEDED contract — the 'link already sent' case");
  const oldLink = await depositInto(LEGACY, sender, 3n);
  check("3 USDC escrowed in the superseded contract", (await usdcBalance(sender.publicKey())) === "17.0000000");

  const payoutA = await newPayout();
  const msgA = await claimMessage(LEGACY, payoutA.publicKey(), oldLink.rawPublicKey(), payoutA.publicKey());
  const resA = await relayClaimHandler(config, signer, {
    method: "claim",
    linkHex: Buffer.from(oldLink.rawPublicKey()).toString("hex"),
    payout: payoutA.publicKey(),
    sigHex: Buffer.from(oldLink.sign(Buffer.from(msgA))).toString("hex"),
    contract: LEGACY,
  });
  check("the relayer claimed it from the superseded contract", !!resA.hash, resA.hash.slice(0, 12) + "…");
  check("the payout received the 3 USDC", (await usdcBalance(payoutA.publicKey())) === "3.0000000");

  console.log("[3] a drop in the CURRENT contract — the default path, no `contract` argument");
  const newLink = await depositInto(CURRENT, sender, 4n);
  const payoutB = await newPayout();
  const msgB = await claimMessage(CURRENT, payoutB.publicKey(), newLink.rawPublicKey(), payoutB.publicKey());
  const resB = await relayClaimHandler(config, signer, {
    method: "claim",
    linkHex: Buffer.from(newLink.rawPublicKey()).toString("hex"),
    payout: payoutB.publicKey(),
    sigHex: Buffer.from(newLink.sign(Buffer.from(msgB))).toString("hex"),
  });
  check("the relayer claimed it from the current contract", !!resB.hash, resB.hash.slice(0, 12) + "…");
  check("the payout received the 4 USDC", (await usdcBalance(payoutB.publicKey())) === "4.0000000");

  console.log("[4] the fallback is an ALLOWLIST — a foreign contract is refused");
  const foreign = "CDUL6GQBQKJYG26YZDJHTZF7G73EKUAWA3LTPK7LXODHPCUPK5AU76KF"; // the USDC SAC, not an escrow
  let refused = false;
  let reason = "";
  try {
    await relayClaimHandler(config, signer, {
      method: "claim",
      linkHex: Buffer.from(Keypair.random().rawPublicKey()).toString("hex"),
      payout: payoutB.publicKey(),
      sigHex: "00".repeat(64),
      contract: foreign,
    });
  } catch (e) {
    refused = true;
    reason = (e as Error).message;
  }
  check("a contract outside the allowlist is rejected", refused, reason);
  check("the rejection happens BEFORE any network spend", /contract not allowed/.test(reason), reason);

  console.log("[5] superseded escrows are EXIT-ONLY — new deposits there are refused");
  const strayLink = Keypair.random();
  const strayAcc = await RPC.getAccount(sender.publicKey());
  const strayTx = new TransactionBuilder(strayAcc, { fee: "1000000", networkPassphrase: NET })
    .addOperation(
      new Contract(LEGACY).call(
        "deposit",
        addr(sender.publicKey()),
        B(strayLink.rawPublicKey()),
        nativeToScVal(1n * UNIT, { type: "i128" }),
        expiry7d(),
      ),
    )
    .setTimeout(60)
    .build();
  const straySim = await RPC.simulateTransaction(strayTx);
  if (rpc.Api.isSimulationError(straySim)) throw new Error(`stray deposit sim: ${straySim.error}`);
  const strayPrepared = rpc.assembleTransaction(strayTx, straySim).build();
  strayPrepared.sign(sender);
  let depositRefused = false;
  let depositReason = "";
  try {
    await relayDepositHandler(config, signer, {
      xdr: strayPrepared.toEnvelope().toXDR("base64"),
      senderPublicKey: sender.publicKey(),
    });
  } catch (e) {
    depositRefused = true;
    depositReason = (e as Error).message;
  }
  check("a /v2-deposit into a superseded contract is rejected", depositRefused, depositReason);
  check("new escrow can only ever grow in the CURRENT contract", /wrong contract/.test(depositReason), depositReason);

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ LEGACY FALLBACK PROOF PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\n💥", e?.message ?? e);
  process.exit(1);
});
