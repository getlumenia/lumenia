/**
 * MAINNET DEMO — generate a small number of real-money claim links as evidence.
 *
 * Deliberately NOT a product launch: a handful of links, tiny amounts, tight caps. Run it in two
 * steps so no key of yours is ever pasted into a script:
 *
 *   1. `… mainnet-demo keys`   — generates a throwaway SPONSOR key and a throwaway SENDER key,
 *                                prints the addresses to fund, and prints nothing else you need
 *                                to keep secret except the two secrets it shows once.
 *   2. `… mainnet-demo links`  — with those secrets in the env, creates N drops and prints the
 *                                claim links plus their transaction hashes.
 *
 * Your Freighter wallet only ever SENDS to the printed addresses. Its secret never appears here.
 *
 * RUN:
 *   pnpm --filter @lumenia/sponsor mainnet-demo keys
 *   SPONSOR_SECRET=S… SENDER_SECRET=S… LUMENDROP_CONTRACT=C… \
 *     pnpm --filter @lumenia/sponsor mainnet-demo links [count] [usdcPerDrop]
 */
import {
  rpc,
  Horizon,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

const NET = Networks.PUBLIC;
const RPC = new rpc.Server(process.env.SOROBAN_RPC_URL ?? "https://mainnet.sorobanrpc.com");
const HZ = new Horizon.Server("https://horizon.stellar.org");
/** Circle's USDC on mainnet. */
const USDC = new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
const UNIT = 10_000_000n;
const WEB = (process.env.WEB_ORIGIN ?? "https://getlumenia.com").replace(/\/$/, "");
const SPONSOR_URL = (process.env.SPONSOR_URL ?? "https://lumenia-sponsor-mainnet.avakit.workers.dev").replace(/\/$/, "");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function keys() {
  const sponsor = Keypair.random();
  const sender = Keypair.random();
  console.log("\n=== MAINNET DEMO KEYS — save these now, they are shown once ===\n");
  console.log("SPONSOR  (pays fees + recipient reserves; needs XLM only)");
  console.log(`  address: ${sponsor.publicKey()}`);
  console.log(`  secret : ${sponsor.secret()}`);
  console.log("\nSENDER   (the money in the demo drops; needs a little XLM + the USDC)");
  console.log(`  address: ${sender.publicKey()}`);
  console.log(`  secret : ${sender.secret()}`);
  console.log("\nFund from Freighter:");
  console.log(`  → ${sponsor.publicKey()}   about 8 XLM`);
  console.log(`  → ${sender.publicKey()}    about 3 XLM, then swap→send the USDC you want to demo`);
  console.log("\nThen: wrangler secret put SPONSOR_SECRET --env mainnet   (paste the sponsor secret)");
  console.log("Neither address needs a USDC trustline before funding — the sender's is opened below.\n");
}

function need(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`set ${n}`);
  return v;
}

async function usdcBalance(pub: string): Promise<string> {
  const acc = await HZ.loadAccount(pub);
  const l = acc.balances.find(
    (b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC.getIssuer(),
  );
  return l ? l.balance : "0";
}

/** Open the sender's USDC trustline if it isn't there yet (one classic tx, a few stroops). */
async function ensureTrustline(sender: Keypair) {
  const acc = await HZ.loadAccount(sender.publicKey());
  const has = acc.balances.some(
    (b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC.getIssuer(),
  );
  if (has) return;
  const { Operation, BASE_FEE } = await import("@stellar/stellar-sdk");
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(60)
    .build();
  tx.sign(sender);
  await HZ.submitTransaction(tx);
  console.log("  opened the sender's USDC trustline");
}

async function links(count: number, perDrop: string) {
  const contract = need("LUMENDROP_CONTRACT");
  const sender = Keypair.fromSecret(need("SENDER_SECRET"));

  console.log("\n=== MAINNET DEMO LINKS ===");
  console.log(`  contract: ${contract}`);
  console.log(`  sponsor : ${SPONSOR_URL}`);
  console.log(`  sender  : ${sender.publicKey()}\n`);

  await ensureTrustline(sender);
  const before = await usdcBalance(sender.publicKey());
  console.log(`  sender USDC: ${before}`);
  const needed = Number.parseFloat(perDrop) * count;
  if (Number.parseFloat(before) < needed) {
    throw new Error(`sender holds ${before} USDC but ${needed} is needed — fund it from Freighter first`);
  }

  const out: Array<{ link: string; hash: string }> = [];
  let lastSeq: string | null = null;

  /** Horizon-sourced account, waited until its sequence moved past the previous drop's. */
  async function freshAccount(pub: string) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const acc = await HZ.loadAccount(pub);
      if (!lastSeq || acc.sequenceNumber() !== lastSeq) {
        return new (await import("@stellar/stellar-sdk")).Account(pub, acc.sequenceNumber());
      }
      await sleep(2000);
    }
    throw new Error("account sequence never advanced — the network is lagging, try again");
  }

  for (let i = 0; i < count; i++) {
   try {
    const link = Keypair.random();
    const linkHex = Buffer.from(link.rawPublicKey()).toString("hex");
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);

    // The RPC's account view lags a just-submitted transaction, so building the next deposit
    // from it yields a stale sequence and txBadSeq. Horizon is authoritative and current — take
    // the sequence from there and wait until it has actually advanced past the last drop.
    const source = await freshAccount(sender.publicKey());
    const tx = new TransactionBuilder(source, { fee: "2000000", networkPassphrase: NET })
      .addOperation(
        new Contract(contract).call(
          "deposit",
          Address.fromString(sender.publicKey()).toScVal(),
          xdr.ScVal.scvBytes(Buffer.from(link.rawPublicKey())),
          nativeToScVal(BigInt(Math.round(Number.parseFloat(perDrop) * Number(UNIT))), { type: "i128" }),
          nativeToScVal(expiry, { type: "u64" }),
        ),
      )
      .setTimeout(120)
      .build();
    const sim = await RPC.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`deposit sim: ${sim.error}`);
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(sender);

    // Gasless: the sponsor fee-bumps the sender-signed inner, exactly as the product does.
    const res = await fetch(`${SPONSOR_URL}/v2-deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xdr: prepared.toXDR(), senderPublicKey: sender.publicKey() }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`/v2-deposit → ${res.status}: ${text}`);
    const { hash } = JSON.parse(text) as { hash: string };

    // `n=public` is what tells the claim page this link lives on mainnet.
    const q = `a=${encodeURIComponent(perDrop)}&s=${encodeURIComponent("Lumenia")}&n=public`;
    const url = `${WEB}/v2/c/${linkHex}?${q}#${link.secret()}`;
    out.push({ link: url, hash });
    // Print the link IMMEDIATELY. The secret exists only in this process, so batching the
    // output means a later failure strands the escrow behind a key nobody has.
    console.log(`  [${i + 1}/${count}] ${perDrop} USDC — tx ${hash.slice(0, 12)}…`);
    console.log(`        ${url}`);
    lastSeq = source.sequenceNumber();
   } catch (e) {
    // One failed drop must not abort the run — the already-created links are real money and
    // their secrets live only here.
    console.log(`  [${i + 1}/${count}] FAILED: ${(e as Error).message}`);
   }
  }

  console.log("\n--- CLAIM LINKS (each is real money; the #fragment IS the key) ---");
  for (const o of out) console.log(o.link);
  console.log("\n--- TRANSACTIONS ---");
  for (const o of out) console.log(`https://stellar.expert/explorer/public/tx/${o.hash}`);
  console.log(`\ncontract: https://stellar.expert/explorer/public/contract/${contract}\n`);
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "keys") return keys();
  if (cmd === "links") return links(Number.parseInt(a ?? "4", 10), b ?? "0.5");
  console.log("usage: mainnet-demo keys | mainnet-demo links [count] [usdcPerDrop]");
  process.exit(1);
}

main().catch((e) => {
  console.error("\n💥", e?.message ?? e);
  process.exit(1);
});
