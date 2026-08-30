/**
 * Full end-to-end claim (Instawards SOW binary success metric).
 *
 * Proves: a bearer claim-key (what lives in a link's #fragment) lands USDC in a
 * freshly sponsored 0-XLM account, via the LIVE sponsor service, evidenced by an
 * on-chain tx hash. The CLI plays both the sender (creates the Claimable Balance)
 * and the recipient (claims it through the live /create-account + /feebump).
 *
 *   RUN:  USDC_ISSUER_SECRET=S... pnpm --filter @lumenia/sponsor claim -- --url https://lumenia-sponsor.avakit.workers.dev
 *   NEEDS: internet (Horizon testnet + friendbot) + the sponsor's USDC issuer secret
 *          (so the Claimable Balance asset matches the sponsor's trustline).
 *   Testnet only, no real money.
 */
import {
  Asset,
  BASE_FEE,
  Claimant,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { passphraseFor, defaultHorizon } from "../lib/config.js";
import { submit, friendbot, nativeBalance, trustlineBalance } from "../lib/stellar.js";
import type { CreateAccountResult } from "../lib/create-account.js";

const EXPLORER = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
const RECLAIM_AFTER_SECONDS = (7 * 24 * 60 * 60).toString();
const NETWORK = passphraseFor("testnet");
const AMOUNT = "20";

function urlArg(): string {
  const i = process.argv.indexOf("--url");
  const u = i >= 0 ? process.argv[i + 1] : undefined;
  if (!u) throw new Error("pass --url <sponsor base url>");
  return u.replace(/\/$/, "");
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function main() {
  const baseUrl = urlArg();
  const issuerSecret = process.env.USDC_ISSUER_SECRET;
  if (!issuerSecret) throw new Error("set USDC_ISSUER_SECRET (the sponsor's USDC issuer) in the env");

  const server = new Horizon.Server(defaultHorizon("testnet"));

  console.log("============================================================");
  console.log(` FULL CLAIM (e2e) via live sponsor: ${baseUrl}`);
  console.log("============================================================\n");

  console.log("[0] GET /health → confirm the sponsor's USDC issuer matches ours");
  const health = (await (await fetch(`${baseUrl}/health`)).json()) as { usdcIssuer: string; usdcCode: string; sponsorPublicKey: string };
  const issuer = Keypair.fromSecret(issuerSecret);
  if (issuer.publicKey() !== health.usdcIssuer) {
    throw new Error(`issuer mismatch: sponsor uses ${health.usdcIssuer}, our secret is ${issuer.publicKey()}`);
  }
  const USDC = new Asset(health.usdcCode, health.usdcIssuer);
  console.log(`   sponsor: ${health.sponsorPublicKey} · USDC issuer: ${health.usdcIssuer} ✔`);

  console.log("\n[1] SENDER: fund + issue USDC + create the Claimable Balance");
  const sender = Keypair.random();
  await friendbot(sender.publicKey());
  {
    const acc = await server.loadAccount(sender.publicKey());
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.changeTrust({ asset: USDC }))
      .setTimeout(180).build();
    tx.sign(sender);
    await submit(server, tx);
  }
  {
    const acc = await server.loadAccount(issuer.publicKey());
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.payment({ destination: sender.publicKey(), asset: USDC, amount: "100" }))
      .setTimeout(180).build();
    tx.sign(issuer);
    await submit(server, tx);
  }

  // The bearer claim-key: in production this lives in the link's #fragment.
  const claimKey = Keypair.random();
  console.log(`   bearer claim-key (would be in the link): ${claimKey.publicKey()}`);
  {
    const acc = await server.loadAccount(sender.publicKey());
    const claimants = [
      new Claimant(claimKey.publicKey(), Claimant.predicateUnconditional()),
      new Claimant(sender.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(RECLAIM_AFTER_SECONDS))),
    ];
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.createClaimableBalance({ asset: USDC, amount: AMOUNT, claimants }))
      .setTimeout(180).build();
    tx.sign(sender);
    await submit(server, tx);
  }
  const cb = await server.claimableBalances().claimant(claimKey.publicKey()).limit(1).order("desc").call();
  const balanceId = cb.records[0]?.id;
  if (!balanceId) throw new Error("Claimable Balance id not found");
  console.log(`   Claimable Balance: ${balanceId} (${AMOUNT} USDC)`);

  console.log("\n[2] RECIPIENT: sponsor /create-account (0-XLM + trustline) — co-sign + submit");
  const created = (await postJson(`${baseUrl}/create-account`, { recipientPublicKey: claimKey.publicKey() })) as unknown as CreateAccountResult;
  {
    const tx = TransactionBuilder.fromXDR(created.xdr, NETWORK) as Transaction;
    tx.sign(claimKey);
    await submit(server, tx);
  }

  console.log("[3] RECIPIENT: build + sign the claim inner tx → POST /feebump");
  const recipAcc = await server.loadAccount(claimKey.publicKey());
  const inner = new TransactionBuilder(recipAcc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(180).build();
  inner.sign(claimKey);
  const feebump = await postJson(`${baseUrl}/feebump`, {
    xdr: inner.toXDR(),
    recipientPublicKey: claimKey.publicKey(),
    balanceId,
  });
  const hash = String(feebump.hash);

  console.log("\n[4] verify: USDC landed in the sponsored 0-XLM account");
  const usdc = await trustlineBalance(server, claimKey.publicKey(), USDC.getCode(), USDC.getIssuer()!);
  const xlm = await nativeBalance(server, claimKey.publicKey());
  const ok = Number.parseFloat(usdc) === Number.parseFloat(AMOUNT) && xlm === "0.0000000";
  console.log(`   recipient USDC: ${usdc}  (expect ${AMOUNT})`);
  console.log(`   recipient XLM:  ${xlm}  (expect 0.0000000)`);

  console.log("\n============================================================");
  console.log(ok ? " ✅ END-TO-END CLAIM PASS — USDC landed, 0 XLM held" : " ❌ CLAIM FAIL");
  console.log("============================================================");
  console.log(` claim tx hash: ${hash}`);
  console.log(` explorer:      ${EXPLORER(hash)}`);
  console.log("\n This is the SOW binary success metric: a bearer link-key landed USDC");
  console.log(" in a freshly sponsored 0-XLM account, via the live service, on-chain.");
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("\n💥 claim failed:", (e as Error).message);
  process.exit(1);
});
