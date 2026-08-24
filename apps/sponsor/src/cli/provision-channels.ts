/**
 * provision-channels — create + fund the channel-account pool (C1 fix).
 *
 * Generates N fresh keypairs, funds each on testnet (friendbot), verifies they exist,
 * and prints CHANNEL_SECRETS=<comma-separated> for the sponsor's env/secret. Each channel
 * is a sponsor-controlled account that LENDS its sequence number to one concurrent
 * onboarding so the sponsor's single sequence no longer serializes claims (see
 * lib/channels.ts). Channels pay only the tiny classic fee on the create-account path
 * (they hold plenty of friendbot XLM) and pay nothing on the fee-bumped v2-claim path.
 *
 * MAINNET: there is no friendbot, and a channel cannot be a 0-XLM sponsored account — it is
 * the transaction SOURCE and pays the fee itself, so it must hold real XLM. Each one therefore
 * needs the protocol account minimum (2 x 0.5 base reserve = 1 XLM) plus a working balance for
 * fees. Pass --network mainnet --funder <S...> and the funder creates them in ONE transaction.
 *
 *   RUN:   pnpm --filter @lumenia/sponsor provision-channels [-- --count 30]
 *          ... provision-channels -- --network mainnet --count 10 --funder S... [--balance 1.1]
 *   THEN:  npx wrangler secret put CHANNEL_SECRETS [--env mainnet]   (paste the printed value)
 *   NEEDS: internet. On testnet, friendbot and no real money; on mainnet, a funded funder key.
 */
import { Keypair, Horizon, TransactionBuilder, Networks, Operation, BASE_FEE } from "@stellar/stellar-sdk";

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const MAINNET = argOf("network") === "mainnet";
const server = new Horizon.Server(
  MAINNET ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org",
);

/**
 * Create every channel from the funder in a SINGLE transaction. One tx keeps the funder's
 * sequence out of play (the very problem channels exist to solve) and makes the whole batch
 * atomic: either the pool exists or nothing was spent but one fee.
 */
async function fundFromFunder(channels: Keypair[], startingBalance: string): Promise<string> {
  const secret = argOf("funder") ?? process.env.FUNDER_SECRET ?? process.env.TREASURY_SECRET;
  if (!secret || secret.length !== 56) {
    throw new Error("mainnet needs --funder S... (or FUNDER_SECRET / TREASURY_SECRET), a full 56-character secret");
  }
  const funder = Keypair.fromSecret(secret);
  const acc = await server.loadAccount(funder.publicKey());
  const native = acc.balances.find((b) => b.asset_type === "native");
  const held = Number.parseFloat(native ? native.balance : "0");
  // The funder keeps its own minimum (1 XLM + 0.5 per subentry it already carries) — spending
  // into it would fail the whole transaction after the keys were already generated.
  const ownMinimum = 1 + 0.5 * acc.subentry_count;
  const needed = channels.length * Number.parseFloat(startingBalance);
  const spendable = held - ownMinimum;
  if (spendable < needed) {
    throw new Error(
      `funder ${funder.publicKey()} holds ${held} XLM, of which ${ownMinimum} is its own reserve — ` +
        `${spendable.toFixed(4)} spendable but ${needed.toFixed(4)} needed for ${channels.length} channels ` +
        `at ${startingBalance} XLM each. Send it ${(needed - spendable + 0.5).toFixed(2)} more XLM.`,
    );
  }
  const b = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.PUBLIC });
  for (const kp of channels) {
    b.addOperation(Operation.createAccount({ destination: kp.publicKey(), startingBalance }));
  }
  const tx = b.setTimeout(180).build();
  tx.sign(funder);
  const res = await server.submitTransaction(tx);
  return res.hash;
}

function countArg(): number {
  const i = process.argv.indexOf("--count");
  const n = i >= 0 ? Number.parseInt(process.argv[i + 1] ?? "", 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 20;
}

async function friendbot(pub: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot failed for ${pub}: ${res.status} ${await res.text()}`);
}

/** Bounded concurrency so a burst of friendbot calls doesn't get rate-limited. */
async function mapPooled<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

async function main() {
  const count = countArg();
  console.log("============================================================");
  console.log(` provision-channels — creating ${count} channel accounts (${MAINNET ? "MAINNET, real XLM" : "testnet"})`);
  console.log("============================================================\n");

  const channels = Array.from({ length: count }, () => Keypair.random());

  if (MAINNET) {
    const balance = argOf("balance") ?? "1.1";
    console.log(`[1] creating ${count} channels from the funder at ${balance} XLM each (one transaction)…`);
    const hash = await fundFromFunder(channels, balance);
    console.log(`   ✔ https://stellar.expert/explorer/public/tx/${hash}`);
  } else {
    console.log(`[1] funding ${count} channels via friendbot (concurrency 5)…`);
    await mapPooled(channels, 5, async (kp, i) => {
      await friendbot(kp.publicKey());
      process.stdout.write(`   ✔ ${i + 1}/${count} ${kp.publicKey()}\n`);
    });
  }

  console.log(`\n[2] verifying all ${count} exist on-ledger…`);
  const existed = await mapPooled(channels, 8, async (kp) => {
    try {
      await server.loadAccount(kp.publicKey());
      return true;
    } catch {
      return false;
    }
  });
  const ok = existed.filter(Boolean).length;
  console.log(`   ${ok}/${count} funded + confirmed`);
  if (ok !== count) {
    console.error("   ✗ some channels failed to fund — re-run before using this output");
    process.exit(1);
  }

  const value = channels.map((k) => k.secret()).join(",");
  console.log("\n============================================================");
  console.log(` ✅ ${count} channels provisioned`);
  console.log("============================================================");
  console.log("\nSet this as the sponsor's CHANNEL_SECRETS (enables the C1 channel pool):\n");
  console.log(`CHANNEL_SECRETS=${value}`);
  console.log("\nCloudflare Worker deploy:");
  console.log("  cd apps/sponsor");
  const envFlag = MAINNET ? " --env mainnet" : "";
  console.log(`  printf '%s' "${value}" | npx wrangler secret put CHANNEL_SECRETS${envFlag}`);
  console.log(`  npx wrangler deploy${envFlag}`);
  console.log("\n(Channels also need the KV store — KV_REST_API_URL/TOKEN — already set for");
  console.log(" the rate-limiter; the lease coordination reuses it. Without KV, leasing is");
  console.log(" in-memory-only and unsafe across Worker isolates.)");
}

main().catch((e) => {
  console.error("\n💥 provision-channels failed:", (e as Error).message);
  process.exit(1);
});
