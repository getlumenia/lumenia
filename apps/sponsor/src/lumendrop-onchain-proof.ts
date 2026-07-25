/**
 * ON-CHAIN PROOF — the deployed v2 LumenDrop Soroban escrow (testnet).
 *
 * Proves the late-bound-payout + walletless/gasless + relayer-can't-redirect properties against
 * the LIVE contract: a sender deposits USDC behind a link's Ed25519 key; a fresh payout account
 * is chosen AT CLAIM TIME; the link key signs it; a RELAYER submits the claim and pays the fee;
 * the USDC lands in the payout while the payout pays nothing. Then a redirect attempt is rejected.
 *
 * RUN: USDC_ISSUER_SECRET=S... pnpm --filter @lumenia/sponsor exec tsx src/lumendrop-onchain-proof.ts
 * NEEDS: internet (soroban-testnet RPC + Horizon + friendbot) + the testnet USDC issuer secret in
 *        the env (never hardcoded — testnet-only key, but no secrets in tracked files).
 */
import {
  rpc,
  Horizon,
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Asset,
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
  BASE_FEE,
} from "@stellar/stellar-sdk";

const NET = Networks.TESTNET;
const RPC = new rpc.Server("https://soroban-testnet.stellar.org");
const HZ = new Horizon.Server("https://horizon-testnet.stellar.org");
// Overridable so the same proof can gate a redeploy (hardening passes deploy NEW contract ids).
const CONTRACT =
  process.env.LUMENDROP_CONTRACT ?? "CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S";
const USDC = new Asset("USDC", "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC");
const ISSUER = Keypair.fromSecret(
  process.env.USDC_ISSUER_SECRET ??
    (() => {
      throw new Error("set USDC_ISSUER_SECRET (the testnet USDC issuer for the deployed contract)");
    })(),
);
const UNIT = 10_000_000n; // 1 USDC = 1e7 stroops

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
/** Add a USDC trustline + (optionally) receive USDC from the issuer. */
async function usdcHolder(kp: Keypair, receive?: string) {
  await friendbot(kp.publicKey());
  await classicTx(kp, Operation.changeTrust({ asset: USDC }));
  if (receive) await classicTx(ISSUER, Operation.payment({ destination: kp.publicKey(), asset: USDC, amount: receive }));
}
async function usdcBalance(pub: string): Promise<string> {
  const acc = await HZ.loadAccount(pub);
  const l = acc.balances.find((b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC.getIssuer());
  return l ? l.balance : "0";
}

/** Invoke a contract method (write): simulate → assemble → sign(source) → submit → poll. */
async function invoke(source: Keypair, method: string, args: xdr.ScVal[]): Promise<void> {
  const acc = await RPC.getAccount(source.publicKey());
  const tx = new TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET })
    .addOperation(new Contract(CONTRACT).call(method, ...args))
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
}
/** Try a write invoke; return true if it FAILED (used for the redirect-rejection check). */
async function invokeFails(source: Keypair, method: string, args: xdr.ScVal[]): Promise<boolean> {
  try {
    await invoke(source, method, args);
    return false;
  } catch {
    return true;
  }
}
/** Read-only call (simulate) → native return value. */
async function view(method: string, args: xdr.ScVal[]): Promise<unknown> {
  const acc = await RPC.getAccount(ISSUER.publicKey());
  const tx = new TransactionBuilder(acc, { fee: "1000000", networkPassphrase: NET })
    .addOperation(new Contract(CONTRACT).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await RPC.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`view ${method}: ${sim.error}`);
  return scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval);
}

const B = (buf: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(buf));
const addr = (pub: string) => Address.fromString(pub).toScVal();

async function main() {
  console.log("============================================================");
  console.log(" ON-CHAIN PROOF — LumenDrop v2 (testnet) " + CONTRACT.slice(0, 10) + "…");
  console.log("============================================================\n");

  console.log("[1] set up a sender (USDC) + a relayer + a fresh payout (all walletless-fresh)");
  const sender = Keypair.random();
  const relayer = Keypair.random();
  const payout = Keypair.random();
  const link = Keypair.random(); // the link's ephemeral Ed25519 key (its raw pubkey = the drop id)
  await Promise.all([usdcHolder(sender, "20"), friendbot(relayer.publicKey()), usdcHolder(payout)]);
  const linkPub = link.rawPublicKey(); // 32 bytes

  console.log("[2] deposit 10 USDC behind the link (sender authorizes; USDC pulled into the contract)");
  await invoke(sender, "deposit", [
    addr(sender.publicKey()),
    B(linkPub),
    nativeToScVal(10n * UNIT, { type: "i128" }),
    nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600), { type: "u64" }),
  ]);
  check("sender's USDC dropped by 10 (escrowed)", (await usdcBalance(sender.publicKey())) === "10.0000000");

  console.log("[3] the link key signs the payout chosen NOW (late binding) — read the exact message on-chain");
  const msg = (await view("claim_message", [nativeToScVal(1, { type: "u32" }), B(linkPub), addr(payout.publicKey())])) as Uint8Array;
  const sig = link.sign(Buffer.from(msg)); // ed25519 signature over the contract's message

  console.log("[4] a RELAYER submits the claim + pays the fee (payout pays nothing) → USDC to payout");
  const payoutXlmBefore = (await HZ.loadAccount(payout.publicKey())).balances.find((b: any) => b.asset_type === "native")!.balance;
  await invoke(relayer, "claim", [B(linkPub), addr(payout.publicKey()), B(sig)]);
  check("payout received the 10 USDC", (await usdcBalance(payout.publicKey())) === "10.0000000");
  const payoutXlmAfter = (await HZ.loadAccount(payout.publicKey())).balances.find((b: any) => b.asset_type === "native")!.balance;
  check("payout paid NO gas for the claim (relayer paid)", payoutXlmBefore === payoutXlmAfter, `${payoutXlmAfter} XLM`);
  const drop = (await view("get_drop", [B(linkPub)])) as { claimed: boolean };
  check("the drop is marked claimed on-chain", drop?.claimed === true);

  console.log("[5] adversarial: a second drop, and a relayer tries to REDIRECT to an attacker");
  const sender2 = Keypair.random();
  const link2 = Keypair.random();
  const attacker = Keypair.random();
  const honest = Keypair.random();
  await Promise.all([usdcHolder(sender2, "20"), usdcHolder(attacker), usdcHolder(honest)]);
  await invoke(sender2, "deposit", [
    addr(sender2.publicKey()),
    B(link2.rawPublicKey()),
    nativeToScVal(5n * UNIT, { type: "i128" }),
    nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600), { type: "u64" }),
  ]);
  // the link signs for `honest`; a malicious relayer tries to claim to `attacker` with that sig.
  const msg2 = (await view("claim_message", [nativeToScVal(1, { type: "u32" }), B(link2.rawPublicKey()), addr(honest.publicKey())])) as Uint8Array;
  const sig2 = link2.sign(Buffer.from(msg2));
  const redirected = await invokeFails(relayer, "claim", [B(link2.rawPublicKey()), addr(attacker.publicKey()), B(sig2)]);
  check("relayer CANNOT redirect funds to a different payout", redirected);
  check("attacker received nothing", (await usdcBalance(attacker.publicKey())) === "0.0000000");
  // the honest payout still works.
  await invoke(relayer, "claim", [B(link2.rawPublicKey()), addr(honest.publicKey()), B(sig2)]);
  check("the link-signed payout still receives the 5 USDC", (await usdcBalance(honest.publicKey())) === "5.0000000");

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ ON-CHAIN PROOF PASS (${pass}/${pass + fail})` : ` ❌ FAIL (${fail} failed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}
main().catch((e) => {
  console.error("\n💥", (e as Error).message);
  process.exit(1);
});
