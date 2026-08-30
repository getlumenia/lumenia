/**
 * Create a real claim LINK (sender side) for the browser demo.
 *
 * Bootstraps a sender, mints USDC (from the sponsor's configured issuer), creates
 * a dual-predicate Claimable Balance for a fresh bearer key, and prints a claim
 * URL pointing at the web app: public metadata in the query (amount/sender/balance
 * so the page can render value-first), the bearer key in the #fragment (client-only).
 *
 *   RUN:  USDC_ISSUER_SECRET=S... pnpm --filter @lumenia/sponsor link -- \
 *           --sponsor https://lumenia-sponsor.avakit.workers.dev \
 *           --web https://getlumenia.com --amount 20 --from "Alvin"
 */
import { Asset, BASE_FEE, Claimant, Horizon, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { passphraseFor, defaultHorizon } from "../lib/config.js";
import { submit, friendbot } from "../lib/stellar.js";

const NETWORK = passphraseFor("testnet");
const RECLAIM_AFTER_SECONDS = (7 * 24 * 60 * 60).toString();

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined && fallback === undefined) throw new Error(`missing --${name}`);
  return v ?? fallback!;
}

async function main() {
  const sponsorUrl = arg("sponsor", "https://lumenia-sponsor.avakit.workers.dev").replace(/\/$/, "");
  const webUrl = arg("web", "https://getlumenia.com").replace(/\/$/, "");
  const amount = arg("amount", "20");
  const from = arg("from", "Alvin");
  const issuerSecret = process.env.USDC_ISSUER_SECRET;
  if (!issuerSecret) throw new Error("set USDC_ISSUER_SECRET (the sponsor's USDC issuer) in the env");

  const server = new Horizon.Server(defaultHorizon("testnet"));

  const health = (await (await fetch(`${sponsorUrl}/health`)).json()) as { usdcIssuer: string; usdcCode: string };
  const issuer = Keypair.fromSecret(issuerSecret);
  if (issuer.publicKey() !== health.usdcIssuer) {
    throw new Error(`issuer mismatch: sponsor uses ${health.usdcIssuer}, our secret is ${issuer.publicKey()}`);
  }
  const USDC = new Asset(health.usdcCode, health.usdcIssuer);

  console.log("[1] fund sender + issue USDC");
  const sender = Keypair.random();
  await friendbot(sender.publicKey());
  {
    const acc = await server.loadAccount(sender.publicKey());
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.changeTrust({ asset: USDC })).setTimeout(180).build();
    tx.sign(sender);
    await submit(server, tx);
  }
  {
    const acc = await server.loadAccount(issuer.publicKey());
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.payment({ destination: sender.publicKey(), asset: USDC, amount: "100" })).setTimeout(180).build();
    tx.sign(issuer);
    await submit(server, tx);
  }

  console.log("[2] create the Claimable Balance for a fresh bearer key");
  const claimKey = Keypair.random();
  {
    const acc = await server.loadAccount(sender.publicKey());
    const claimants = [
      new Claimant(claimKey.publicKey(), Claimant.predicateUnconditional()),
      new Claimant(sender.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(RECLAIM_AFTER_SECONDS))),
    ];
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.createClaimableBalance({ asset: USDC, amount, claimants })).setTimeout(180).build();
    tx.sign(sender);
    await submit(server, tx);
  }
  const cb = await server.claimableBalances().claimant(claimKey.publicKey()).limit(1).order("desc").call();
  const balanceId = cb.records[0]?.id;
  if (!balanceId) throw new Error("Claimable Balance id not found");

  const id = balanceId.slice(-8);
  const query = `a=${encodeURIComponent(amount)}&s=${encodeURIComponent(from)}&b=${balanceId}&i=${health.usdcIssuer}`;
  const url = `${webUrl}/c/${id}?${query}#${claimKey.secret()}`;

  console.log("\n============================================================");
  console.log(" ✅ CLAIM LINK READY — open it in a browser / phone to claim");
  console.log("============================================================");
  console.log(url);
  console.log(`\n (${amount} USDC from "${from}" · balanceId ${balanceId})`);
}

main().catch((e) => {
  console.error("\n💥 link failed:", (e as Error).message);
  process.exit(1);
});
