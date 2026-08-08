/**
 * One-off: prove the ROTATED mainnet sponsor key can actually sign and land a transaction on
 * mainnet. `/health` only proves the key was loaded; it says nothing about whether the signature
 * it produces is accepted by the network. This drives the real /create-account route on the live
 * mainnet Worker, co-signs as the recipient, and submits — the same path a real user takes.
 *
 * Then it CLEANS UP: the throwaway account is merged back into the sponsor, which returns the
 * ~1.5 XLM of reserve the test locked (account + trustline). Cleanup is signed locally with the
 * sponsor key, not through the Worker — the Worker's anti-drain policy deliberately refuses to
 * sponsor anything but the claim/send shapes, and it is not going to be widened for a test.
 *
 *   RUN: SPONSOR_SECRET=$(stellar keys secret lumenia-sponsor-mainnet-v2) npx tsx src/mainnet-sponsor-rotation-check.ts
 *   COSTS: real mainnet fees (a few stroops). Reserve is reclaimed by the cleanup step.
 */
import {
  Horizon,
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
  type Transaction,
} from "@stellar/stellar-sdk";

const WORKER = "https://lumenia-sponsor-mainnet.avakit.workers.dev";
const HORIZON = "https://horizon.stellar.org";
const EXPECTED_SPONSOR = "GBLBAKFVTS2GSEOUK3AKOZAO3I6T34YHNJPG4DMF5JODVWJDJIPDYZZ2";

const server = new Horizon.Server(HORIZON);
let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const sponsorSecret = process.env.SPONSOR_SECRET;
  if (!sponsorSecret) throw new Error("SPONSOR_SECRET is required (the rotated mainnet sponsor)");
  const sponsor = Keypair.fromSecret(sponsorSecret);
  if (sponsor.publicKey() !== EXPECTED_SPONSOR) {
    throw new Error(`SPONSOR_SECRET is not the rotated key (got ${sponsor.publicKey()})`);
  }

  console.log("=".repeat(64));
  console.log(" MAINNET — rotated sponsor key, real signature check");
  console.log("=".repeat(64));

  console.log("\n[1] the live Worker reports the rotated key");
  const health = (await (await fetch(`${WORKER}/health`)).json()) as {
    sponsorPublicKey: string;
    network: string;
    usdcCode: string;
    usdcIssuer: string;
  };
  ok("health → rotated sponsor", health.sponsorPublicKey === EXPECTED_SPONSOR, health.sponsorPublicKey);
  ok("network is mainnet", health.network === "mainnet", health.network);

  const before = await server.loadAccount(sponsor.publicKey());
  const beforeXlm = before.balances.find((b) => b.asset_type === "native")!.balance;
  console.log(`   sponsor float before: ${beforeXlm} XLM`);

  console.log("\n[2] a brand-new recipient asks the Worker to onboard it");
  const recipient = Keypair.random();
  console.log(`   recipient: ${recipient.publicKey()}`);
  const res = await fetch(`${WORKER}/create-account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipientPublicKey: recipient.publicKey() }),
  });
  const bodyText = await res.text();
  ok("/create-account → 200", res.ok, res.ok ? "" : `${res.status}: ${bodyText.slice(0, 160)}`);
  if (!res.ok) throw new Error("the Worker refused to build the onboarding transaction");
  const result = JSON.parse(bodyText) as { xdr: string; usdcCode: string; usdcIssuer: string };

  console.log("\n[3] recipient co-signs and submits — THIS is the sponsor's real signature test");
  const tx = TransactionBuilder.fromXDR(result.xdr, Networks.PUBLIC) as Transaction;
  tx.sign(recipient);
  let hash = "";
  try {
    const sent = await server.submitTransaction(tx);
    hash = sent.hash;
    ok("submitted to mainnet", true, `tx ${hash.slice(0, 16)}…`);
  } catch (e) {
    const code = (e as { response?: { data?: { extras?: { result_codes?: unknown } } } })?.response?.data?.extras
      ?.result_codes;
    ok("submitted to mainnet", false, JSON.stringify(code ?? (e as Error).message));
    throw e;
  }

  console.log("\n[4] the recipient really exists on mainnet, funded by nobody");
  const acct = await server.loadAccount(recipient.publicKey());
  const xlm = acct.balances.find((b) => b.asset_type === "native")!.balance;
  const usdc = acct.balances.find(
    (b) => "asset_code" in b && b.asset_code === result.usdcCode && b.asset_issuer === result.usdcIssuer,
  );
  ok("recipient holds 0 XLM", xlm === "0.0000000", xlm);
  ok("USDC trustline is open", Boolean(usdc), usdc ? "yes" : "missing");
  console.log(`   https://stellar.expert/explorer/public/tx/${hash}`);

  console.log("\n[5] cleanup — merge the throwaway back so the reserve is not stranded");
  try {
    const recAcct = await server.loadAccount(recipient.publicKey());
    const cleanup = new TransactionBuilder(recAcct, {
      fee: BASE_FEE,
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(
        Operation.changeTrust({ asset: new Asset(result.usdcCode, result.usdcIssuer), limit: "0" }),
      )
      .addOperation(Operation.accountMerge({ destination: sponsor.publicKey() }))
      .setTimeout(120)
      .build();
    cleanup.sign(recipient);
    // The throwaway holds 0 XLM, so it cannot pay its own fee — the sponsor wraps it.
    const bump = TransactionBuilder.buildFeeBumpTransaction(sponsor, "200000", cleanup, Networks.PUBLIC);
    bump.sign(sponsor);
    const sent = await server.submitTransaction(bump);
    ok("throwaway merged back", true, `tx ${sent.hash.slice(0, 16)}…`);
  } catch (e) {
    const code = (e as { response?: { data?: { extras?: { result_codes?: unknown } } } })?.response?.data?.extras
      ?.result_codes;
    ok("throwaway merged back", false, `${JSON.stringify(code ?? (e as Error).message)} (reserve stays locked — harmless)`);
  }

  const after = await server.loadAccount(sponsor.publicKey());
  const afterXlm = after.balances.find((b) => b.asset_type === "native")!.balance;
  console.log(`\n   sponsor float after: ${afterXlm} XLM (was ${beforeXlm})`);
  console.log(`   sponsoring ${(after as unknown as { num_sponsoring?: number }).num_sponsoring ?? 0} entries`);

  console.log("\n" + "=".repeat(64));
  console.log(fail === 0 ? ` ✅ ROTATED SPONSOR WORKS ON MAINNET (${pass}/${pass})` : ` ❌ ${fail} CHECK(S) FAILED`);
  console.log("=".repeat(64));
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("\n  fatal:", (e as Error).message);
  process.exitCode = 1;
});
