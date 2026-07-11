/**
 * Integration tests (Instawards SOW, W3) — happy claim, drain rejection, rate-limit.
 *
 * Boots the real node:http sponsor service as a child process (with a low per-account
 * cap) and drives it over HTTP, exactly as the browser/CLI would. Exercises the
 * deployed code path end to end.
 *
 *   RUN:   pnpm --filter @lumenia/sponsor test:integration
 *   NEEDS: internet (Horizon testnet + friendbot). Testnet only, no real money.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  Account,
  Asset,
  BASE_FEE,
  Claimant,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { passphraseFor, defaultHorizon } from "./lib/config.js";
import { friendbot, submit } from "./lib/stellar.js";

const NETWORK = passphraseFor("testnet");
// Random ephemeral port: a previously orphaned child (crashed parent skips the
// finally-kill) must not EADDRINUSE the next run.
const PORT = 42000 + Math.floor(Math.random() * 10000);
const BASE = `http://localhost:${PORT}`;
const RECLAIM = (7 * 24 * 60 * 60).toString();

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ✔ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name} ${detail}`);
    failed++;
  }
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function waitReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start within 25s")), 25000);
    child.stdout?.on("data", (d) => {
      if (String(d).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on("data", (d) => process.stderr.write(d));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})`));
    });
  });
}

async function main() {
  console.log("=== bootstrap sponsor + issuer (friendbot) ===");
  const sponsor = Keypair.random();
  const issuer = Keypair.random();
  await Promise.all([friendbot(sponsor.publicKey()), friendbot(issuer.publicKey())]);
  const server = new Horizon.Server(defaultHorizon("testnet"));
  const USDC = new Asset("USDC", issuer.publicKey());

  console.log("=== start sponsor service (child) — per-account cap = 3 ===");
  const child = spawn("tsx", ["src/index.ts"], {
    env: {
      ...process.env,
      STELLAR_NETWORK: "testnet",
      SPONSOR_SECRET: sponsor.secret(),
      USDC_ISSUER: issuer.publicKey(),
      PORT: String(PORT),
      RATE_CAP: "100",
      ACCOUNT_RATE_CAP: "3",
      ALLOWED_ORIGIN: "*",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitReady(child);

  try {
    /* ---------- TEST 1: happy claim ---------- */
    console.log("\n[1] happy claim: create CB → /create-account → claim → /feebump");
    const claimKey = Keypair.random();
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
    {
      const acc = await server.loadAccount(sender.publicKey());
      const claimants = [
        new Claimant(claimKey.publicKey(), Claimant.predicateUnconditional()),
        new Claimant(sender.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(RECLAIM))),
      ];
      const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
        .addOperation(Operation.createClaimableBalance({ asset: USDC, amount: "20", claimants })).setTimeout(180).build();
      tx.sign(sender);
      await submit(server, tx);
    }
    const cb = await server.claimableBalances().claimant(claimKey.publicKey()).limit(1).order("desc").call();
    const balanceId = cb.records[0]!.id;

    const ca = await post("/create-account", { recipientPublicKey: claimKey.publicKey() });
    ok("create-account → 200", ca.status === 200, `(got ${ca.status})`);
    {
      const tx = TransactionBuilder.fromXDR(String(ca.body.xdr), NETWORK) as Transaction;
      tx.sign(claimKey);
      await submit(server, tx);
    }
    const recipAcc = await server.loadAccount(claimKey.publicKey());
    const inner = new TransactionBuilder(recipAcc, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.claimClaimableBalance({ balanceId })).setTimeout(180).build();
    inner.sign(claimKey);
    const fb = await post("/feebump", { xdr: inner.toXDR(), recipientPublicKey: claimKey.publicKey(), balanceId });
    ok("feebump → 200 + tx hash", fb.status === 200 && typeof fb.body.hash === "string", `(got ${fb.status} ${JSON.stringify(fb.body)})`);

    const landed = await server.loadAccount(claimKey.publicKey());
    const usdcBal = landed.balances.find((b) => "asset_code" in b && b.asset_code === "USDC")?.balance;
    const xlmBal = landed.balances.find((b) => b.asset_type === "native")?.balance;
    ok("USDC landed (20) + 0 XLM held", usdcBal === "20.0000000" && xlmBal === "0.0000000", `(usdc ${usdcBal}, xlm ${xlmBal})`);

    /* ---------- TEST 2: drain rejection ---------- */
    console.log("\n[2] drain rejection: a malicious payment inner tx → anti-drain 400");
    const evil = Keypair.random();
    const attacker = Keypair.random();
    const evilTx = new TransactionBuilder(new Account(evil.publicKey(), "1"), { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.payment({ destination: attacker.publicKey(), asset: USDC, amount: "5" })).setTimeout(180).build();
    evilTx.sign(evil);
    const drain = await post("/feebump", {
      xdr: evilTx.toXDR(),
      recipientPublicKey: evil.publicKey(),
      balanceId: "00000000" + "ab".repeat(32),
    });
    ok(
      "feebump rejects the drain (400 + anti-drain reason)",
      drain.status === 400 && /anti-drain/i.test(String(drain.body.error ?? "")),
      `(got ${drain.status} ${JSON.stringify(drain.body)})`,
    );

    /* ---------- TEST 3: rate limit ---------- */
    console.log("\n[3] rate limit: 6 rapid /create-account for one account (cap 3) → 429");
    const rlAccount = Keypair.random().publicKey();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await post("/create-account", { recipientPublicKey: rlAccount });
      statuses.push(r.status);
    }
    ok("burst is rate-limited (a 429 appears)", statuses.includes(429), `(statuses ${statuses.join(",")})`);
  } finally {
    child.kill("SIGKILL");
  }

  console.log("\n============================================================");
  console.log(failed === 0 ? ` ✅ INTEGRATION TESTS PASS (${passed}/${passed + failed})` : ` ❌ INTEGRATION TESTS FAIL (${failed} failed)`);
  console.log("============================================================");
  // Exit explicitly: lingering keep-alive sockets/stdio pipes otherwise hold the
  // event loop open after PASS and the command never returns.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\n💥 integration test crashed:", (e as Error).message);
  process.exit(1);
});
