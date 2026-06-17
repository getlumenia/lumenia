/**
 * ============================================================================
 *  SPIKE #1c — web→sponsor XDR wire-parity + fee-bump of a re-parsed tx (testnet)
 * ============================================================================
 *
 *  GOAL (Elliot's code-review finding #2): Spike #1 built + validated + fee-bumped
 *  the claim tx in ONE process, so "byte-for-byte identical tx between web and
 *  sponsor" was free. The real architecture sends the inner tx as XDR over the
 *  wire (web → sponsor HTTP). This spike inserts that wire boundary explicitly:
 *
 *    WEB:     build inner claim tx → sign → innerTx.toXDR()  (base64 string = "the wire")
 *    SPONSOR: TransactionBuilder.fromXDR(b64) → re-parsed tx
 *             → assert re-parsed.hash() === original.hash()  (byte-for-byte parity)
 *             → run the CANONICAL validateInnerTransaction (packages/shared)
 *             → fee-bump the RE-PARSED tx → submit to testnet
 *
 *  What is proven:
 *    1. The inner tx survives an XDR base64 round-trip byte-identically (same hash).
 *    2. The canonical (shared) anti-drain validator accepts the real claim tx.
 *    3. A fee-bump built around the RE-PARSED tx is accepted by the network and
 *       the recipient claims with 0 XLM — i.e. the wire boundary is safe.
 *
 *  RUN:   pnpm --filter @lumenia/sponsor exec tsx src/spike1c-wire-parity.ts
 *  NEEDS: Node 20+, internet (Horizon testnet + friendbot). No mainnet/real money.
 * ============================================================================
 */

import {
  Asset,
  BASE_FEE,
  Claimant,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
// canonical anti-drain validator (relative import — no workspace symlink needed)
import { validateInnerTransaction } from "../../../packages/shared/src/index";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const NETWORK = Networks.TESTNET;
const server = new Horizon.Server(HORIZON_URL);
const RECLAIM_AFTER_SECONDS = (7 * 24 * 60 * 60).toString();

async function friendbot(pub: string, label: string) {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${label} fail: ${res.status}`);
  console.log(`   ✔ funded ${label}`);
}
async function submit(tx: Parameters<typeof server.submitTransaction>[0], label: string) {
  try {
    const res = await server.submitTransaction(tx);
    console.log(`   ✔ ${label} → ${res.hash}`);
    return res;
  } catch (e: unknown) {
    const extras = (e as { response?: { data?: { extras?: unknown } } })?.response?.data?.extras;
    console.error(`   ✗ ${label} FAILED`, JSON.stringify(extras ?? e, null, 2));
    throw e;
  }
}
async function assetBalance(pub: string, code: string, issuer: string) {
  const acc = await server.loadAccount(pub);
  const l = acc.balances.find((b) => "asset_code" in b && b.asset_code === code && "asset_issuer" in b && b.asset_issuer === issuer);
  return l ? l.balance : "NO_TRUSTLINE";
}
async function nativeBalance(pub: string) {
  const acc = await server.loadAccount(pub);
  return acc.balances.find((b) => b.asset_type === "native")?.balance ?? "0";
}

async function main() {
  console.log("============================================================");
  console.log(" SPIKE #1c — web→sponsor XDR wire-parity + fee-bump");
  console.log("============================================================");

  const issuer = Keypair.random();
  const sponsor = Keypair.random();
  const sender = Keypair.random();
  const recipient = Keypair.random(); // NEW user, never funded
  const USDC = new Asset("USDC", issuer.publicKey());

  console.log("\n[1] fund issuer/sponsor/sender (recipient stays unfunded)");
  await friendbot(issuer.publicKey(), "issuer");
  await friendbot(sponsor.publicKey(), "sponsor");
  await friendbot(sender.publicKey(), "sender");

  console.log("[2] sender trustline + issue 100 USDC + create 20 USDC Claimable Balance");
  {
    const acc = await server.loadAccount(sender.publicKey());
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.changeTrust({ asset: USDC }))
      .setTimeout(180).build();
    tx.sign(sender);
    await submit(tx, "sender changeTrust");
  }
  {
    const acc = await server.loadAccount(issuer.publicKey());
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.payment({ destination: sender.publicKey(), asset: USDC, amount: "100" }))
      .setTimeout(180).build();
    tx.sign(issuer);
    await submit(tx, "issue 100 USDC");
  }
  {
    const acc = await server.loadAccount(sender.publicKey());
    const claimants = [
      new Claimant(recipient.publicKey(), Claimant.predicateUnconditional()),
      new Claimant(sender.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(RECLAIM_AFTER_SECONDS))),
    ];
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.createClaimableBalance({ asset: USDC, amount: "20", claimants }))
      .setTimeout(180).build();
    tx.sign(sender);
    await submit(tx, "createClaimableBalance");
  }
  const cb = await server.claimableBalances().claimant(recipient.publicKey()).limit(1).order("desc").call();
  const balanceId = cb.records[0]?.id;
  if (!balanceId) throw new Error("CB id not found");
  console.log(`   ✔ balanceId: ${balanceId}`);

  console.log("[3] sponsored onboarding (sponsor-sourced) — recipient 0 XLM + USDC trustline");
  {
    const sponsorAcc = await server.loadAccount(sponsor.publicKey());
    const tx = new TransactionBuilder(sponsorAcc, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: recipient.publicKey(), source: sponsor.publicKey() }))
      .addOperation(Operation.createAccount({ destination: recipient.publicKey(), startingBalance: "0", source: sponsor.publicKey() }))
      .addOperation(Operation.changeTrust({ asset: USDC, source: recipient.publicKey() }))
      .addOperation(Operation.endSponsoringFutureReserves({ source: recipient.publicKey() }))
      .setTimeout(180).build();
    tx.sign(sponsor);
    tx.sign(recipient);
    await submit(tx, "sponsored onboarding");
  }

  // ---------------- WEB SIDE ----------------
  console.log("[4] WEB: recipient builds + signs claim inner tx → serialize to XDR (the wire)");
  const recipAcc = await server.loadAccount(recipient.publicKey());
  const innerTx = new TransactionBuilder(recipAcc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(180).build();
  innerTx.sign(recipient);
  const wireXdr = innerTx.toXDR(); // base64 string sent over HTTP to the sponsor
  const originalHashHex = innerTx.hash().toString("hex");
  console.log(`   inner tx hash (web side): ${originalHashHex}`);
  console.log(`   wire XDR length: ${wireXdr.length} chars`);

  // ---------------- SPONSOR SIDE ----------------
  console.log("[5] SPONSOR: parse XDR from the wire → assert byte-for-byte parity");
  const reparsed = TransactionBuilder.fromXDR(wireXdr, NETWORK) as Transaction;
  const reparsedHashHex = reparsed.hash().toString("hex");
  const hashParity = reparsedHashHex === originalHashHex;
  const xdrParity = reparsed.toXDR() === wireXdr;
  console.log(`   re-parsed tx hash:        ${reparsedHashHex}`);
  console.log(`   ✔ hash parity over wire:  ${hashParity}`);
  console.log(`   ✔ XDR re-serialize parity: ${xdrParity}`);

  console.log("[6] SPONSOR: run CANONICAL anti-drain validator on the re-parsed tx");
  const verdict = validateInnerTransaction(reparsed, {
    expectedSource: recipient.publicKey(),
    sponsor: sponsor.publicKey(),
    expectedAsset: USDC,
    expectedBalanceId: balanceId,
  });
  console.log(`   ✔ validator verdict: ${verdict.ok}${verdict.ok ? "" : ` (${verdict.reason})`}`);
  if (!verdict.ok) throw new Error(`validator rejected legit claim: ${verdict.reason}`);

  console.log("[7] SPONSOR: fee-bump the RE-PARSED tx → submit");
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(sponsor.publicKey(), "200", reparsed, NETWORK);
  feeBump.sign(sponsor);
  await submit(feeBump, "fee-bumped claim (re-parsed)");

  const recipUsdc = await assetBalance(recipient.publicKey(), "USDC", issuer.publicKey());
  const recipXlm = await nativeBalance(recipient.publicKey());
  console.log(`   recipient USDC: ${recipUsdc} (should be 20) · XLM: ${recipXlm} (should be 0)`);

  const pass = hashParity && xdrParity && verdict.ok && Number.parseFloat(recipUsdc) === 20 && recipXlm === "0.0000000";
  console.log("\n============================================================");
  console.log(pass ? " ✅ SPIKE #1c PASS" : " ❌ SPIKE #1c FAIL");
  console.log("============================================================");
  console.log(` • XDR wire round-trip byte-identical : ${hashParity && xdrParity}`);
  console.log(` • canonical validator accepts claim  : ${verdict.ok}`);
  console.log(` • fee-bump of re-parsed tx submitted : ${Number.parseFloat(recipUsdc) === 20}`);
  console.log(` • recipient claimed 20 USDC, 0 XLM   : ${Number.parseFloat(recipUsdc) === 20 && recipXlm === "0.0000000"}`);
  console.log("\n Wire boundary proven: the inner tx crosses web→sponsor as XDR unchanged,");
  console.log(" the shared validator gates it, and the fee-bump of the re-parsed tx settles.");
  if (!pass) process.exit(1);
}

main().catch((e) => {
  const extras = (e as { response?: { data?: { extras?: unknown } } })?.response?.data?.extras;
  console.error("\n💥 SPIKE #1c crashed:", extras ? JSON.stringify(extras, null, 2) : e);
  process.exit(1);
});
