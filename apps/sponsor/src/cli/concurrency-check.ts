/**
 * concurrency-check — fire N concurrent /create-account at a LIVE sponsor and confirm the
 * channel pool eliminates tx_bad_seq end to end (the real Worker + its Redis lease store).
 *
 * Each request gets a sponsor-built sandwich; we co-sign as the recipient and submit to
 * Horizon exactly as the browser would. With the channel pool enabled every response is
 * channel-sourced (via: "channel") and no submit collides.
 *
 *   RUN: pnpm --filter @lumenia/sponsor exec tsx src/cli/concurrency-check.ts \
 *          --url https://lumenia-sponsor.avakit.workers.dev --count 20
 *   NEEDS: internet. Add `--network mainnet` to check the mainnet sponsor — that spends real
 *          sponsor reserve (1.5 XLM per account created), so keep --count small there.
 */
import { Keypair, Horizon, TransactionBuilder, Networks, type Transaction } from "@stellar/stellar-sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/* The network is a flag, not a constant. Hardcoding testnet here meant a run pointed at the
 * MAINNET sponsor still built and submitted against testnet: the sponsor handed out real mainnet
 * channels, every one reported via:channel, and every submit then failed tx_no_source_account
 * because those accounts do not exist on testnet. The pool looked broken when it was working. */
const MAINNET = process.argv.includes("--network") &&
  process.argv[process.argv.indexOf("--network") + 1] === "mainnet";
const NETWORK = MAINNET ? Networks.PUBLIC : Networks.TESTNET;
const server = new Horizon.Server(
  MAINNET ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org",
);

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

type Outcome =
  | { ok: true; via?: string }
  | { ok: false; stage: "sponsor" | "submit"; reason: string; via?: string };

async function oneOnboarding(baseUrl: string, recipient: Keypair): Promise<Outcome> {
  // 1. sponsor builds the sandwich
  let via: string | undefined;
  let xdr: string;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/create-account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipientPublicKey: recipient.publicKey() }),
    });
    const body = (await res.json()) as { xdr?: string; via?: string; error?: string };
    if (!res.ok || !body.xdr) return { ok: false, stage: "sponsor", reason: `${res.status} ${body.error ?? "no xdr"}` };
    xdr = body.xdr;
    via = body.via;
  } catch (e) {
    return { ok: false, stage: "sponsor", reason: (e as Error).message };
  }
  // 2. co-sign + submit (as the client does)
  try {
    const tx = TransactionBuilder.fromXDR(xdr, NETWORK) as Transaction;
    tx.sign(recipient);
    await server.submitTransaction(tx);
    return { ok: true, via };
  } catch (e: unknown) {
    const err = e as { response?: { status?: number; data?: { extras?: { result_codes?: { transaction?: string } } } }; message?: string };
    const txCode = err?.response?.data?.extras?.result_codes?.transaction ?? "";
    const status = err?.response?.status;
    const reason = txCode || (status === 504 ? "gateway-timeout" : err?.message ?? "unknown");
    return { ok: false, stage: "submit", reason, via };
  }
}

async function main() {
  const baseUrl = arg("--url");
  const count = Number.parseInt(arg("--count", "20")!, 10);
  if (!baseUrl) throw new Error("pass --url <sponsor base url>");

  console.log("============================================================");
  console.log(` CONCURRENCY CHECK — ${count} concurrent /create-account`);
  console.log(` target: ${baseUrl}`);
  console.log("============================================================\n");

  /* Generate every recipient key up front and, on mainnet, WRITE THEM DOWN before a single
   * request goes out.
   *
   * This CLI used to mint a keypair inside each onboarding and let it fall out of scope when
   * the process exited. On testnet that is free and correct — the accounts are worthless. On
   * mainnet, which this can now target, every account it creates locks 1.5 XLM of sponsor
   * reserve that can NEVER be recovered, because closing an account requires its key: 8 runs
   * on 2026-08-24 stranded 12 XLM exactly this way, days after the same mistake in
   * provision-channels cost 16.5 more. A throwaway key stops being a throwaway the moment the
   * network it lives on has real money in it. */
  const recipients = Array.from({ length: count }, () => Keypair.random());
  if (MAINNET) {
    const dir = join(homedir(), ".lumenia");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out = join(dir, `concurrency-mainnet-${Date.now()}.txt`);
    writeFileSync(out, recipients.map((k) => k.secret()).join("\n") + "\n", { mode: 0o600 });
    const back = readFileSync(out, "utf8").trim().split("\n");
    if (
      back.length !== recipients.length ||
      back.some((sec, i) => Keypair.fromSecret(sec).publicKey() !== recipients[i]!.publicKey())
    ) {
      console.error(`\n💥 ${out} does not reproduce the generated keys — refusing to spend.`);
      process.exit(1);
    }
    console.log(`  ${recipients.length} recipient keys written + verified: ${out}`);
    console.log(`  (each account created below locks 1.5 XLM of sponsor reserve; that file is`);
    console.log(`   the only way to ever merge them back)\n`);
  }

  const outcomes = await Promise.all(recipients.map((kp) => oneOnboarding(baseUrl, kp)));

  const okCount = outcomes.filter((o) => o.ok).length;
  const badSeq = outcomes.filter((o) => !o.ok && o.reason === "tx_bad_seq").length;
  const viaChannel = outcomes.filter((o) => o.via === "channel").length;
  const viaSponsor = outcomes.filter((o) => o.via === "sponsor").length;
  const fails = outcomes.filter((o) => !o.ok) as Extract<Outcome, { ok: false }>[];

  console.log(`  succeeded:       ${okCount}/${count}`);
  console.log(`  tx_bad_seq:      ${badSeq}  (expect 0)`);
  console.log(`  via channel:     ${viaChannel}/${count}`);
  console.log(`  via sponsor:     ${viaSponsor}/${count}  (fallback — expect 0 when the pool is healthy)`);
  if (fails.length) {
    console.log("  failures:");
    for (const f of fails.slice(0, 8)) console.log(`    - [${f.stage}] ${f.reason} (via ${f.via ?? "?"})`);
  }

  const pass = okCount === count && badSeq === 0 && viaChannel === count;
  console.log("\n============================================================");
  console.log(pass ? " ✅ CONCURRENCY CHECK PASS" : " ❌ CONCURRENCY CHECK FAIL");
  console.log("============================================================");
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error("\n💥 concurrency-check failed:", (e as Error).message);
  process.exit(1);
});
