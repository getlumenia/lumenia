/**
 * Concurrency proof for the WIRED /v2-claim relayer (C1 fix, live LumenDrop contract).
 *
 * Like the sponsor-sourced /create-account, the v2 relayer submits from the sponsor's
 * ONE sequence, so concurrent v2 claims collide (tx_bad_seq at send). This drives the
 * REAL relayClaimHandler with a channel pool and proves the collision is gone.
 *
 *   FIX     — N concurrent v2 claims through the channel pool → N/N succeed, 0 tx_bad_seq,
 *             every payout receives its USDC (walletless + gasless).
 *   CONTROL — the SAME handler with channels off → the sponsor's single sequence
 *             serializes → ≤1 succeeds (the bug the pool removes).
 *
 * RUN: SPONSOR_SECRET=S… USDC_ISSUER_SECRET=S… pnpm --filter @lumenia/sponsor test:v2-concurrency
 * NEEDS: internet (Horizon + Soroban RPC + friendbot). Testnet only, no real money.
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
import { ChannelManager, memoryLeaseStore } from "./lib/channels.js";
import { relayClaimHandler } from "./lib/soroban-relay.js";

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

const N = 6; // concurrent claims (enough that the single-sequence control collides)
const POOL = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function friendbot(pub: string) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}
async function classic(source: Keypair, ...ops: xdr.Operation[]) {
  const acc = await HZ.loadAccount(source.publicKey());
  const b = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET });
  for (const o of ops) b.addOperation(o);
  const tx = b.setTimeout(120).build();
  tx.sign(source);
  await HZ.submitTransaction(tx);
}
async function usdcHolder(kp: Keypair, receive?: string) {
  await friendbot(kp.publicKey());
  await classic(kp, Operation.changeTrust({ asset: USDC }));
  if (receive) await classic(ISSUER, Operation.payment({ destination: kp.publicKey(), asset: USDC, amount: receive }));
}
async function usdcBal(pub: string) {
  const a = await HZ.loadAccount(pub);
  const l = a.balances.find(
    (b) => "asset_code" in b && b.asset_code === "USDC" && "asset_issuer" in b && b.asset_issuer === USDC.getIssuer(),
  );
  return l ? l.balance : "0";
}
async function sorobanSubmit(tx: Parameters<typeof RPC.sendTransaction>[0]) {
  const sent = await RPC.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(JSON.stringify(sent.errorResult));
  let g = await RPC.getTransaction(sent.hash);
  for (let i = 0; i < 40 && g.status === "NOT_FOUND"; i++) { await sleep(1500); g = await RPC.getTransaction(sent.hash); }
  if (g.status !== "SUCCESS") throw new Error(`tx ${g.status}`);
}
async function deposit(sender: Keypair, linkPub: Buffer, amountStroops: bigint) {
  const src = await RPC.getAccount(sender.publicKey());
  const tx = new TransactionBuilder(src, { fee: "2000000", networkPassphrase: NET })
    .addOperation(new Contract(CONTRACT).call("deposit",
      Address.fromString(sender.publicKey()).toScVal(),
      xdr.ScVal.scvBytes(linkPub),
      nativeToScVal(amountStroops, { type: "i128" }),
      nativeToScVal(4_000_000_000n, { type: "u64" }),
    )).setTimeout(60).build();
  const sim = await RPC.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(sender);
  await sorobanSubmit(prepared);
}
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
async function mapPooled<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!, i); }
  }));
  return out;
}

/** Retry ONLY transient gateway hiccups (testnet Horizon/RPC 504/502/timeout) during setup. */
async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!/50[24]|timeout|Request failed|NOT_FOUND|TRY_AGAIN/i.test((e as Error).message ?? "")) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

type ClaimSetup = { link: Keypair; payout: Keypair; sigHex: string };

/**
 * total funded drops, set up in phases that avoid the issuer's OWN single-sequence
 * collision: friendbot (independent) → trustlines (each own seq) → ONE issuer tx that
 * mints to every sender (no issuer-seq contention) → deposits (each sender own seq) →
 * link signatures. The concurrency under test is the CLAIM, not this setup.
 */
async function setupDrops(total: number): Promise<ClaimSetup[]> {
  const items = Array.from({ length: total }, () => ({
    sender: Keypair.random(),
    link: Keypair.random(),
    payout: Keypair.random(),
  }));
  const accounts = items.flatMap((x) => [x.sender, x.payout]);
  // 1. fund every account (friendbot is independent per account)
  await mapPooled(accounts, 5, (kp) => withRetry(() => friendbot(kp.publicKey())));
  // 2. open the USDC trustline on each (each account sources its own tx → no collision)
  await mapPooled(accounts, 6, (kp) => withRetry(() => classic(kp, Operation.changeTrust({ asset: USDC }))));
  // 3. issuer mints 20 USDC to every sender in ONE tx — avoids the issuer-sequence collision
  await withRetry(() =>
    classic(ISSUER, ...items.map((x) => Operation.payment({ destination: x.sender.publicKey(), asset: USDC, amount: "20" }))),
  );
  // 4. each sender deposits 5 USDC behind its link (sender-sourced Soroban invoke)
  await mapPooled(items, 4, (x) => withRetry(() => deposit(x.sender, Buffer.from(x.link.rawPublicKey()), 50_000_000n)));
  // 5. read claim_message + link-key sign the chosen payout
  return mapPooled(items, 6, async (x) => ({
    link: x.link,
    payout: x.payout,
    sigHex: await withRetry(() => signClaim(x.payout.publicKey(), x.link, x.payout.publicKey())),
  }));
}

type Outcome = { ok: true } | { ok: false; badSeq: boolean; code: string };
async function claimVia(setup: ClaimSetup, config: ReturnType<typeof makeConfig>, signer: ReturnType<typeof signerFromSecret>, channels?: ChannelManager): Promise<Outcome> {
  try {
    await relayClaimHandler(config, signer, {
      method: "claim",
      linkHex: Buffer.from(setup.link.rawPublicKey()).toString("hex"),
      payout: setup.payout.publicKey(),
      sigHex: setup.sigHex,
    }, channels);
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message ?? "";
    return { ok: false, badSeq: /txBadSeq|tx_bad_seq|bad_seq/i.test(msg), code: msg.slice(0, 80) };
  }
}

async function main() {
  console.log("============================================================");
  console.log(` V2-CLAIM CONCURRENCY PROOF — channels vs live LumenDrop ${CONTRACT.slice(0, 8)}…`);
  console.log("============================================================");

  const channelKps = Array.from({ length: POOL }, () => Keypair.random());
  console.log(`\n[1] provision ${POOL} channels (friendbot)`);
  await mapPooled(channelKps, 5, (kp) => friendbot(kp.publicKey()));

  const config = makeConfig({
    network: "testnet",
    sponsorSecret: SPONSOR.secret(),
    usdcIssuer: USDC.getIssuer()!,
    lumendropContract: CONTRACT,
    channelSecrets: channelKps.map((k) => k.secret()),
  });
  const signer = signerFromSecret(SPONSOR.secret());
  const channels = new ChannelManager(config.channelSecrets, memoryLeaseStore());

  console.log(`\n[2] set up ${2 * N} funded drops (${N} for FIX + ${N} for CONTROL)`);
  const allDrops = await setupDrops(2 * N);
  const fixDrops = allDrops.slice(0, N);
  const ctlDrops = allDrops.slice(N);
  console.log(`   ✔ ${allDrops.length} drops escrowed`);

  /* ---------------- FIX: relayer WITH the channel pool ---------------- */
  console.log(`\n[FIX] ${N} concurrent v2 claims through the channel pool`);
  const fix = await Promise.all(fixDrops.map((d) => claimVia(d, config, signer, channels)));
  const fixOk = fix.filter((o) => o.ok).length;
  const fixBadSeq = fix.filter((o) => !o.ok && o.badSeq).length;
  const paid = (await mapPooled(fixDrops, 6, async (d) => (await usdcBal(d.payout.publicKey())) === "5.0000000")).filter(Boolean).length;
  const fixFail = fix.find((o) => !o.ok) as Extract<Outcome, { ok: false }> | undefined;
  console.log(`   succeeded:  ${fixOk}/${N}`);
  console.log(`   tx_bad_seq: ${fixBadSeq}  (expect 0)`);
  console.log(`   payouts paid 5 USDC: ${paid}/${N}`);
  if (fixFail) console.log(`   first fail: ${fixFail.code}`);
  const fixPass = fixOk === N && fixBadSeq === 0 && paid === N;

  /* --------------- CONTROL: same relayer, channels OFF --------------- */
  console.log(`\n[CONTROL] ${N} concurrent with channels DISABLED (sponsor-sourced)`);
  const ctl = await Promise.all(ctlDrops.map((d) => claimVia(d, config, signer, undefined)));
  const ctlOk = ctl.filter((o) => o.ok).length;
  console.log(`   succeeded: ${ctlOk}/${N}  (single sequence → at most one lands per round)`);
  const ctlProvesBug = ctlOk < N; // sponsor's single sequence cannot serve N concurrent

  const pass = fixPass && ctlProvesBug;
  console.log("\n============================================================");
  console.log(pass ? " ✅ V2-CLAIM CONCURRENCY PROOF PASS" : " ❌ V2-CLAIM CONCURRENCY PROOF FAIL");
  console.log("============================================================");
  console.log(` FIX     channel pool: ${fixOk}/${N}, 0 bad_seq, all paid : ${fixPass}`);
  console.log(` CONTROL channels off serializes (${ctlOk}/${N} < ${N})     : ${ctlProvesBug}`);
  if (!pass) process.exit(1);
}

main().catch((e) => { console.error("\n💥 v2-claim concurrency proof crashed:", (e as Error).message); process.exit(1); });
