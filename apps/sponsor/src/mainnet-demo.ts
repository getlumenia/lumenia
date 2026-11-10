/**
 * MAINNET DEMO: generate a small number of real-money claim links as evidence.
 *
 * Deliberately NOT a product launch: a handful of links, tiny amounts, tight caps. Run it in two
 * steps so no key of yours is ever pasted into a script:
 *
 *   1. `... mainnet-demo keys`   generates a throwaway SENDER key, writes it to a 0600 file git
 *                                 ignores (apps/sponsor/mainnet-demo-out/keys-<stamp>.json) BEFORE
 *                                 printing anything, and prints the address to fund.
 *   2. `... mainnet-demo links`  with that secret in the env, creates N drops through the LIVE
 *                                 sponsor (the Worker pays the fees with its own key; nothing here
 *                                 replaces it) and prints the claim links plus their transaction
 *                                 hashes. Every link's secret is written to the same folder's
 *                                 links-<stamp>.json BEFORE its deposit is posted: a 524, a throw
 *                                 or a Ctrl-C after the money moved used to strand real USDC behind
 *                                 a key that existed only in this process's memory (review
 *                                 2026-10-20, N3).
 *
 * Your Freighter wallet only ever SENDS to the printed address. Its secret never appears here.
 *
 * RUN:
 *   pnpm --filter @lumenia/sponsor mainnet-demo keys
 *   SENDER_SECRET=S... LUMENDROP_CONTRACT=C... \
 *     pnpm --filter @lumenia/sponsor mainnet-demo links [count] [usdcPerDrop]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/* Where the throwaway key and every link's secret are written: a folder .gitignore covers at any
 * depth (`**` + "/mainnet-demo-out/"), beside apps/sponsor/adversarial-out/ which the adversarial
 * run uses the same way (adversarial-run.ts, saveKeys / assertGitignored). */
const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const OUT = resolve(SCRIPT_DIR, "..", "mainnet-demo-out");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

/** Refuse a file git would track: the seeds hold REAL money, and this repository is public. */
function assertGitignored(path: string): void {
  try {
    // From this file's folder, so the check consults this repository whatever folder the command
    // was typed in; a path outside it fails the check too.
    execFileSync("git", ["check-ignore", "-q", path], { cwd: SCRIPT_DIR, stdio: "ignore" });
  } catch {
    throw new Error(`refusing to write secrets to ${path}: git does not ignore it (add **/mainnet-demo-out/ to .gitignore)`);
  }
}

/** Write a record the operator must keep: owner-readable only (0600), after checking git ignores it. */
function saveSecretFile(path: string, record: unknown): void {
  mkdirSync(OUT, { recursive: true });
  assertGitignored(path);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function keys() {
  const sender = Keypair.random();
  const path = resolve(OUT, `keys-${STAMP}.json`);
  // Written BEFORE it is printed: a terminal that scrolled away or a window that closed must not
  // have been the only copy of a key that will hold real USDC.
  saveSecretFile(path, {
    network: "mainnet",
    purpose: "demo sender: holds the USDC the demo drops escrow",
    publicKey: sender.publicKey(),
    secret: sender.secret(),
    createdAt: new Date().toISOString(),
  });
  console.log("\n=== MAINNET DEMO KEY ===\n");
  console.log(`  written to ${path} (mode 0600, git-ignored)\n`);
  console.log("SENDER   (the money in the demo drops; needs a little XLM + the USDC)");
  console.log(`  address: ${sender.publicKey()}`);
  console.log(`  secret : ${sender.secret()}`);
  console.log("\nFund from Freighter:");
  console.log(`  -> ${sender.publicKey()}    about 3 XLM, then swap and send the USDC you want to demo`);
  console.log("\nThe LIVE sponsor Worker pays the fees with its own key. Do NOT replace its SPONSOR_SECRET for a demo:");
  console.log("the pilot's money, caps, kill-switch and watchdog all hang off that key.");
  console.log("The sender needs no USDC trustline before funding; `links` opens it when it is missing.\n");
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

  /* The record of every link, secret included, written BEFORE each deposit is posted (0600,
   * git-ignored). Saved once here, before any money moves, so a folder that cannot be written or
   * is not ignored stops the run while the USDC is still the sender's. */
  const recordPath = resolve(OUT, `links-${STAMP}.json`);
  const record = {
    network: "mainnet",
    contract,
    sender: sender.publicKey(),
    sponsor: SPONSOR_URL,
    startedAt: new Date().toISOString(),
    links: [] as Array<Record<string, unknown>>,
  };
  const save = () => saveSecretFile(recordPath, record);
  save();
  console.log(`  record  : ${recordPath}`);
  console.log("            (every link's secret is written there BEFORE its deposit is posted; keep the file)\n");

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
   /** This drop's line in the record; set before the deposit is posted, updated with its outcome. */
   let entry: Record<string, unknown> | null = null;
   try {
    const link = Keypair.random();
    const linkHex = Buffer.from(link.rawPublicKey()).toString("hex");
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);

    // The private link shape, built by hand because the sponsor does not import web code; the
    // contract is apps/web/lib/lumendrop.ts v2LinkUrl. No amount anywhere (the claim page reads it
    // from the escrow), the sender's name after the key, and `n=public`, which is what tells the
    // claim page this link lives on mainnet.
    const url = `${WEB}/v2/c/${linkHex}?n=public#${link.secret()}&s=Lumenia`;
    // On disk BEFORE the money moves: from here a crash strands nothing.
    entry = { index: i + 1, linkHex, secret: link.secret(), url, usdc: perDrop, status: "funding", at: new Date().toISOString() };
    record.links.push(entry);
    save();

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
    if (!res.ok) throw new Error(`/v2-deposit -> ${res.status}: ${text}`);
    const { hash } = JSON.parse(text) as { hash: string };

    /* 202 is "accepted, undecided" (the sponsor's poll window closed before the ledger showed it):
     * the deposit may still land, so the record says so rather than "funded", and the link is kept. */
    entry.status = res.status === 202 ? "accepted-undecided" : "funded";
    entry.hash = hash;
    save();
    out.push({ link: url, hash });
    // Print the link IMMEDIATELY too: the record is the durable copy, the terminal the convenient one.
    console.log(`  [${i + 1}/${count}] ${perDrop} USDC, tx ${hash.slice(0, 12)}...${res.status === 202 ? " (accepted, not yet seen landing)" : ""}`);
    console.log(`        ${url}`);
    lastSeq = source.sequenceNumber();
   } catch (e) {
    // One failed drop must not abort the run: the already-created links are real money. Their
    // secrets are on disk, and this one's outcome is recorded beside them (a refusal before the
    // post moved nothing; a thrown post may still have landed, and the link is kept for that).
    if (entry) {
      entry.status = `failed: ${(e as Error).message.split("\n", 1)[0]}`;
      save();
    }
    console.log(`  [${i + 1}/${count}] FAILED: ${(e as Error).message}`);
   }
  }

  console.log("\n--- CLAIM LINKS (each is real money; the #fragment IS the key) ---");
  for (const o of out) console.log(o.link);
  console.log("\n--- TRANSACTIONS ---");
  for (const o of out) console.log(`https://stellar.expert/explorer/public/tx/${o.hash}`);
  console.log(`\ncontract: https://stellar.expert/explorer/public/contract/${contract}`);
  console.log(`record  : ${recordPath} (keep it: it holds every link's secret and outcome)\n`);
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
