/**
 * ON-CHAIN GOVERNANCE PROOF — the LumenDrop upgrade/pause safety net, against the LIVE
 * testnet contract. Proves, with real transactions:
 *
 *   1. deposit works normally (baseline escrow)
 *   2. a NON-owner cannot pause and cannot upgrade (owner surface is auth-gated)
 *   3. the owner CAN pause → new deposits FAIL while paused → but a claim of an
 *      already-escrowed drop STILL SUCCEEDS (invariant 14: exits never pause) → unpause
 *   4. the owner upgrades the contract wasm (to the same uploaded hash) and the
 *      PRE-UPGRADE drop is claimable AFTER the upgrade (versioned storage survives)
 *
 * RUN: USDC_ISSUER_SECRET=S... OWNER_SECRET=S... LUMENDROP_CONTRACT=C... WASM_HASH=<hex64> \
 *      pnpm --filter @lumenia/sponsor exec tsx src/lumendrop-governance-proof.ts
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
const CONTRACT = process.env.LUMENDROP_CONTRACT ?? die("set LUMENDROP_CONTRACT");
const WASM_HASH = process.env.WASM_HASH ?? die("set WASM_HASH (hex, from `stellar contract upload`)");
const USDC = new Asset("USDC", "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC");
const ISSUER = Keypair.fromSecret(process.env.USDC_ISSUER_SECRET ?? die("set USDC_ISSUER_SECRET"));
const OWNER = Keypair.fromSecret(process.env.OWNER_SECRET ?? die("set OWNER_SECRET"));
const UNIT = 10_000_000n;

function die(msg: string): never {
  throw new Error(msg);
}
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
async function invokeFails(source: Keypair, method: string, args: xdr.ScVal[]): Promise<boolean> {
  try {
    await invoke(source, method, args);
    return false;
  } catch {
    return true;
  }
}
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
const expiry7d = () => nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600), { type: "u64" });

async function main() {
  console.log("============================================================");
  console.log(" GOVERNANCE PROOF — LumenDrop " + CONTRACT.slice(0, 10) + "… (testnet)");
  console.log("============================================================\n");

  console.log("[1] set up a funded USDC sender + two link keys");
  const sender = Keypair.random();
  const linkA = Keypair.random(); // claimed while paused
  const linkB = Keypair.random(); // claimed after the upgrade
  await friendbot(sender.publicKey());
  await classicTx(sender, Operation.changeTrust({ asset: USDC }));
  await classicTx(ISSUER, Operation.payment({ destination: sender.publicKey(), asset: USDC, amount: "20" }));

  console.log("[2] baseline: two deposits escrow normally");
  await invoke(sender, "deposit", [addr(sender.publicKey()), B(linkA.rawPublicKey()), nativeToScVal(5n * UNIT, { type: "i128" }), expiry7d()]);
  await invoke(sender, "deposit", [addr(sender.publicKey()), B(linkB.rawPublicKey()), nativeToScVal(5n * UNIT, { type: "i128" }), expiry7d()]);
  check("two 5-USDC drops escrowed", (await usdcBalance(sender.publicKey())) === "10.0000000");

  console.log("[3] a NON-owner cannot pause or upgrade (owner surface is auth-gated)");
  check("stranger's pause is rejected", await invokeFails(sender, "pause", [addr(sender.publicKey())]));
  check(
    "stranger's upgrade is rejected",
    await invokeFails(sender, "upgrade", [B(Buffer.from(WASM_HASH, "hex")), addr(sender.publicKey())]),
  );

  console.log("[4] owner pauses → new deposits FAIL, but a claim still EXITS (invariant 14)");
  await invoke(OWNER, "pause", [addr(OWNER.publicKey())]);
  check("paused() reads true on-chain", (await view("paused", [])) === true);
  const linkC = Keypair.random();
  check(
    "deposit while paused is rejected",
    await invokeFails(sender, "deposit", [addr(sender.publicKey()), B(linkC.rawPublicKey()), nativeToScVal(1n * UNIT, { type: "i128" }), expiry7d()]),
  );
  const payoutA = Keypair.random();
  await friendbot(payoutA.publicKey());
  await classicTx(payoutA, Operation.changeTrust({ asset: USDC }));
  const msgA = (await view("claim_message", [nativeToScVal(1, { type: "u32" }), B(linkA.rawPublicKey()), addr(payoutA.publicKey())])) as Uint8Array;
  await invoke(sender, "claim", [B(linkA.rawPublicKey()), addr(payoutA.publicKey()), B(linkA.sign(Buffer.from(msgA)))]);
  check("claim SUCCEEDS while paused (exits never pause)", (await usdcBalance(payoutA.publicKey())) === "5.0000000");
  await invoke(OWNER, "unpause", [addr(OWNER.publicKey())]);
  check("unpaused", (await view("paused", [])) === false);

  console.log("[5] owner upgrades the wasm → the PRE-upgrade drop still claims (storage survives)");
  await invoke(OWNER, "upgrade", [B(Buffer.from(WASM_HASH, "hex")), addr(OWNER.publicKey())]);
  check("upgrade tx succeeded (owner-signed)", true);
  const payoutB = Keypair.random();
  await friendbot(payoutB.publicKey());
  await classicTx(payoutB, Operation.changeTrust({ asset: USDC }));
  const msgB = (await view("claim_message", [nativeToScVal(1, { type: "u32" }), B(linkB.rawPublicKey()), addr(payoutB.publicKey())])) as Uint8Array;
  await invoke(sender, "claim", [B(linkB.rawPublicKey()), addr(payoutB.publicKey()), B(linkB.sign(Buffer.from(msgB)))]);
  check("pre-upgrade drop claimed AFTER the upgrade", (await usdcBalance(payoutB.publicKey())) === "5.0000000");
  const owner = await view("get_owner", []);
  check("owner survives the upgrade", owner === OWNER.publicKey(), String(owner).slice(0, 8) + "…");

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ GOVERNANCE PROOF PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\n💥", e?.message ?? e);
  process.exit(1);
});
