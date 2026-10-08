/**
 * CANARY CAP TESTS: the per-drop and per-day escrow ceilings, the per-sender day cap, the
 * onboarding reserve budget (with its one-slot-per-recipient-key rule), the sponsor fee budget,
 * and the proof that every Horizon route charges that budget BEFORE it signs (offline; a fake KV
 * store stands in for Upstash and a stub signer stands in for the key, so this runs with no
 * network and no secrets).
 *
 * RUN: pnpm --filter @lumenia/sponsor test:caps
 */
import {
  Account,
  Asset,
  BASE_FEE,
  Claimant,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  type FeeBumpTransaction,
  type Horizon,
  type Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import * as capsModule from "./lib/caps.js";
import {
  accountDayKey,
  accountPubkeyDayKey,
  accountSourceDayKey,
  capsFromEnv,
  chargeSponsorFee,
  checkCaps,
  checkOnboardingBudget,
  dayKey,
  FEE_BUDGET_REFUSAL,
  feeBudgetFromEnv,
  feeDayKey,
  feeGrossDayKey,
  isPublicRefusal,
  MAX_REPEATS_PER_KEY,
  onboardingBudgetFromEnv,
  readDayCounters,
  readSponsorFeeDay,
  senderDayKey,
  signCharged,
  stroopsToUsdc,
  USDC_STROOPS,
  type CapsConfig,
  type CapVerdict,
  type FeeBudget,
  type OnboardingBudget,
} from "./lib/caps.js";
import type { ChannelManager } from "./lib/channels.js";
import { makeConfig } from "./lib/config.js";
import { createAccountHandler } from "./lib/create-account.js";
import { feebumpHandler } from "./lib/feebump.js";
import { payoutHandler } from "./lib/payout.js";
import { sendLinkHandler } from "./lib/send.js";
import type { SponsorSigner } from "./lib/signer.js";
import { setLedgerRecheckMsForTests } from "./lib/stellar.js";
import { sweepHandler } from "./lib/sweep.js";

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};
const usdc = (n: number) => BigInt(Math.round(n * Number(USDC_STROOPS)));

const FAKE_KV_URL = "https://fake-kv.test";

/**
 * An in-memory stand-in for the Upstash REST API the caps module talks to.
 *
 * It answers EVERY command in a pipeline, in order, the way Upstash does, including the EXPIRE
 * that follows each INCRBY. A stand-in that replied to the first command only would read a
 * two-counter pipeline's second total off the wrong index and never notice. It also answers SET
 * with NX ("OK" when it set the key, null when the key existed), DEL (how many keys went), GET
 * (null for a missing key), and the single-command `/get/<key>` path, all with the reply shapes
 * the real store uses. Every pipeline is recorded, so a test can assert which commands went
 * together in ONE round trip.
 */
function installFakeKv(opts: { fail?: boolean } = {}) {
  const store = new Map<string, bigint | string>();
  const calls: string[] = [];
  const pipelines: string[][][] = [];
  process.env.KV_REST_API_URL = FAKE_KV_URL;
  process.env.KV_REST_API_TOKEN = "t";
  const run = (cmd: string[]): { result: unknown } => {
    const [op, key, ...args] = cmd;
    switch (op) {
      case "EXPIRE":
        return { result: store.has(key!) ? 1 : 0 };
      case "INCRBY": {
        const next = BigInt(store.get(key!) ?? 0n) + BigInt(args[0]!);
        store.set(key!, next);
        return { result: Number(next) }; // Upstash answers an integer, not a string
      }
      case "SET": {
        if (args.includes("NX") && store.has(key!)) return { result: null };
        if (args.includes("XX") && !store.has(key!)) return { result: null };
        store.set(key!, args[0]!);
        return { result: "OK" };
      }
      case "EVAL": {
        // The one script caps.ts sends: the fenced release of an onboarding slot (KEYS[1] marker,
        // KEYS[2] and KEYS[3] the counters, ARGV[1] the releasing request's token).
        const [, numKeys, ...rest] = cmd.slice(1);
        const keys = rest.slice(0, Number(numKeys));
        const argv = rest.slice(Number(numKeys));
        if (!/redis\.call\('get', KEYS\[1\]\) == ARGV\[1\]/.test(key!) || keys.length !== 3) throw new Error("unexpected EVAL script");
        if (store.get(keys[0]!) !== argv[0]) return { result: 0 };
        store.delete(keys[0]!);
        for (const k of keys.slice(1)) store.set(k, BigInt(store.get(k) ?? 0n) - 1n);
        return { result: 1 };
      }
      case "GET": {
        const v = store.get(key!);
        return { result: v == null ? null : String(v) };
      }
      case "DEL":
        return { result: store.delete(key!) ? 1 : 0 };
      default:
        throw new Error(`unexpected command ${op}`);
    }
  };
  /** A test may run something just before a pipeline is applied (an interleaving request). */
  const hooks: {
    beforePipeline?: (cmds: string[][]) => void | Promise<void>;
    /** Runs after a pipeline was applied; throwing here is an answer lost on the way back. */
    afterPipeline?: (cmds: string[][]) => void;
  } = {};
  const fakeFetch = (async (url: string | URL, init?: { body?: string }) => {
    const u = String(url);
    calls.push(u);
    if (opts.fail) return { ok: false, status: 500, json: async () => [] } as unknown as Response;
    const path = u.slice(FAKE_KV_URL.length);
    if (path.startsWith("/get/")) {
      return { ok: true, status: 200, json: async () => run(["GET", decodeURIComponent(path.slice(5))]) } as unknown as Response;
    }
    if (path !== "/pipeline") throw new Error(`unexpected path ${path}`);
    const cmds = JSON.parse(String(init?.body ?? "[]")) as string[][];
    if (hooks.beforePipeline) await hooks.beforePipeline(cmds);
    pipelines.push(cmds);
    const results = cmds.map(run);
    hooks.afterPipeline?.(cmds);
    return { ok: true, status: 200, json: async () => results } as unknown as Response;
  }) as typeof fetch;
  globalThis.fetch = fakeFetch;
  /** Point the module back at THIS store (after a test installed another one in between). */
  const reinstall = () => {
    process.env.KV_REST_API_URL = FAKE_KV_URL;
    process.env.KV_REST_API_TOKEN = "t";
    globalThis.fetch = fakeFetch;
  };
  return { store, calls, pipelines, reinstall, hooks };
}

function clearKv() {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
}

const CAPS: CapsConfig = {
  minDropStroops: usdc(0.01),
  maxDropStroops: usdc(20),
  maxDayStroops: usdc(50),
  failClosed: false,
};

/** A fixed instant, so the day in every key below is a known string. */
const NOW = Date.parse("2026-10-07T12:00:00Z");
const NOW_DAY = "2026-10-07";
/** A different UTC day, for the cases that must not read the per-isolate leftovers of another. */
const OTHER_DAY = Date.parse("2026-10-09T12:00:00Z");

async function main() {
  console.log("============================================================");
  console.log(" CANARY CAP TESTS (offline)");
  console.log("============================================================\n");

  console.log("[1] per-drop cap — enforced locally, with or without a store");
  clearKv();
  check("an amount under the cap passes", (await checkCaps(usdc(19.99), CAPS)).ok);
  check("an amount exactly AT the cap passes", (await checkCaps(usdc(20), CAPS)).ok);
  const over = await checkCaps(usdc(20.01), CAPS);
  check("one stroop over the cap is rejected", !over.ok);
  check("the rejection names both the amount and the cap", /20\.01.*20 USDC/.test(over.reason ?? ""), over.reason);
  check("a zero amount is rejected", !(await checkCaps(0n, CAPS)).ok);
  check("a negative amount is rejected", !(await checkCaps(-1n, CAPS)).ok);

  // A FLOOR as well as a ceiling. The sponsor's cost per escrow is a fixed ~1 XLM reserve lock
  // that does not scale with the amount, so a dust send passed every cap while costing full price.
  const dust = await checkCaps(1n, CAPS); // one stroop = 0.0000001 USDC
  check("a one-stroop dust send is rejected (it locks a full reserve for nothing)", !dust.ok);
  check("the rejection names the minimum", /minimum of 0\.01 USDC/.test(dust.reason ?? ""), dust.reason);
  check("an amount exactly AT the minimum passes", (await checkCaps(usdc(0.01), CAPS)).ok);

  console.log("[2] per-day cap — a shared rolling total across senders");
  const kv = installFakeKv();
  check("first 20 USDC passes", (await checkCaps(usdc(20), CAPS)).ok);
  check("second 20 USDC passes (40 of 50)", (await checkCaps(usdc(20), CAPS)).ok);
  const third = await checkCaps(usdc(20), CAPS);
  check("third 20 USDC is rejected (would be 60 of 50)", !third.ok);
  check("the rejection explains the daily cap", /daily escrow cap/.test(third.reason ?? ""), third.reason);
  check(
    "a REJECTED request does not consume the day's budget",
    kv.store.get(dayKey(Date.now())) === usdc(40),
    stroopsToUsdc((kv.store.get(dayKey(Date.now())) as bigint | undefined) ?? 0n) + " USDC counted",
  );
  check("a smaller amount still fits in the remaining budget", (await checkCaps(usdc(10), CAPS)).ok);

  console.log("[3] release — a failed transaction gives its budget back");
  installFakeKv();
  const reserved = await checkCaps(usdc(20), CAPS);
  check("the reservation succeeded and exposes release()", reserved.ok && typeof reserved.release === "function");
  check("a second reservation also fits (40 of 50)", (await checkCaps(usdc(20), CAPS)).ok);
  await reserved.release!(); // pretend the first send's transaction failed
  check(
    "a third 20 USDC now fits — without the release it would have been 60 of 50",
    (await checkCaps(usdc(20), CAPS)).ok,
  );

  console.log("[4] day rollover — the bucket key is the UTC date");
  const d1 = dayKey(Date.parse("2026-07-25T23:59:59Z"));
  const d2 = dayKey(Date.parse("2026-07-26T00:00:01Z"));
  check("consecutive days use different keys", d1 !== d2, `${d1} vs ${d2}`);
  check("the same day uses one key", dayKey(Date.parse("2026-07-25T00:00:00Z")) === d1);

  console.log("[5] store outage — the documented fail-open / fail-closed split");
  installFakeKv({ fail: true });
  check(
    "fail-open (default): the per-drop cap still applies, the day cap yields",
    (await checkCaps(usdc(20), CAPS)).ok && !(await checkCaps(usdc(21), CAPS)).ok,
  );
  check(
    "fail-closed: nothing is escrowed while the counter is untrusted",
    !(await checkCaps(usdc(1), { ...CAPS, failClosed: true })).ok,
  );
  clearKv();
  check(
    "fail-closed with NO store configured also rejects",
    !(await checkCaps(usdc(1), { ...CAPS, failClosed: true })).ok,
  );

  console.log("[6] configuration — env overrides and testnet defaults");
  delete process.env.MAX_DROP_USDC;
  delete process.env.MAX_DAY_USDC;
  delete process.env.CAPS_FAIL_CLOSED;
  const defaults = capsFromEnv();
  check("default per-drop is 100 USDC", defaults.maxDropStroops === usdc(100));
  check("default per-day is 1000 USDC", defaults.maxDayStroops === usdc(1000));
  check("fail-open is the default", !defaults.failClosed);
  process.env.MAX_DROP_USDC = "20";
  process.env.MAX_DAY_USDC = "500";
  process.env.CAPS_FAIL_CLOSED = "1";
  const mainnetish = capsFromEnv();
  check("env overrides apply (the mainnet canary shape)", mainnetish.maxDropStroops === usdc(20) && mainnetish.maxDayStroops === usdc(500));
  check("CAPS_FAIL_CLOSED=1 flips the outage behavior", mainnetish.failClosed);
  process.env.MAX_DROP_USDC = "nonsense";
  check("a malformed override falls back to the default, never to unlimited", capsFromEnv().maxDropStroops === usdc(100));
  delete process.env.MAX_DROP_USDC;
  delete process.env.MAX_DAY_USDC;
  delete process.env.CAPS_FAIL_CLOSED;
  // [env.mainnet.vars] redeclares the block instead of inheriting it, so a dropped line must leave
  // the pilot's numbers and a closed failure, never the testnet ones.
  const mainnetDefaults = capsFromEnv("mainnet");
  check("MAINNET with every variable missing: 5 USDC per transfer, not the testnet 100", mainnetDefaults.maxDropStroops === usdc(5));
  check("MAINNET with every variable missing: 50 USDC a day, not the testnet 1000", mainnetDefaults.maxDayStroops === usdc(50));
  check("MAINNET with every variable missing: 25 per sender", mainnetDefaults.maxDaySenderStroops === usdc(25));
  check("MAINNET fails CLOSED even without CAPS_FAIL_CLOSED", mainnetDefaults.failClosed);
  process.env.MAX_DROP_USDC = "2";
  check("configuration can still choose a mainnet number", capsFromEnv("mainnet").maxDropStroops === usdc(2));
  delete process.env.MAX_DROP_USDC;

  console.log("[7] formatting — amounts read as USDC in operator-facing messages");
  check("whole amounts have no decimal point", stroopsToUsdc(usdc(20)) === "20");
  check("fractional amounts keep their significant digits", stroopsToUsdc(usdc(1.25)) === "1.25");

  // /create-account moves no dollars, so no amount cap can see it; what it spends is a reserve
  // lock that never comes back. These two budgets are the only ceilings that route has.
  console.log("[8] onboarding budget — a ceiling on sponsored ACCOUNTS, not on dollars");
  // Four different callers, so this section measures the GLOBAL bound alone (the per-source share
  // is exercised in [9]).
  const IP_A = "203.0.113.9";
  const IP_B = "198.51.100.4";
  const IP_C = "192.0.2.77";
  const IP_D = "203.0.113.200";
  const BUDGET: OnboardingBudget = { maxDayAccounts: 3, maxDaySourceAccounts: 3, failClosed: false };
  const acctKv = installFakeKv();
  check("the first sponsored account is allowed", (await checkOnboardingBudget(BUDGET, IP_A)).ok);
  check("the second is allowed", (await checkOnboardingBudget(BUDGET, IP_B)).ok);
  const thirdAccount = await checkOnboardingBudget(BUDGET, IP_C);
  check("the third fills the budget and is still allowed", thirdAccount.ok);
  const fourth = await checkOnboardingBudget(BUDGET, IP_D);
  check("the fourth is refused", !fourth.ok);
  check("the refusal names the limit", /limit of 3 a day is reached/.test(fourth.reason ?? ""), fourth.reason);
  check(
    "a refused request does not consume the day's budget",
    acctKv.store.get(accountDayKey(Date.now())) === 3n,
    `${acctKv.store.get(accountDayKey(Date.now()))} counted`,
  );
  check(
    "nor the refused caller's own share",
    (acctKv.store.get(accountSourceDayKey(Date.now(), IP_D)) ?? 0n) === 0n,
    `${acctKv.store.get(accountSourceDayKey(Date.now(), IP_D))} counted`,
  );
  await thirdAccount.release!(); // pretend the handler threw before any sandwich was built
  check("release hands the slot back", (await checkOnboardingBudget(BUDGET, IP_D)).ok);
  check(
    "accounts and escrow are separate buckets — a day of claims cannot eat the escrow budget",
    accountDayKey(1) !== dayKey(1) && !acctKv.store.has(dayKey(Date.now())),
  );
  check("the bucket is namespaced per network", accountDayKey(1, "mainnet") !== accountDayKey(1, "testnet"));

  /* The global budget alone is also a way to switch the product off: one caller spending it all
     inside the rate limiter's ~30/min would refuse every real recipient for the rest of the day.
     The per-source share is what stops that, so what matters here is not only that a source runs
     out — it is that running out costs nobody else their claim. */
  console.log("[9] onboarding budget — one caller's share, so no single source can spend the day");
  const SHARED: OnboardingBudget = { maxDayAccounts: 10, maxDaySourceAccounts: 2, failClosed: false };
  const srcKv = installFakeKv();
  check("a caller's first account is allowed", (await checkOnboardingBudget(SHARED, IP_A)).ok);
  check("their second fills their share and is still allowed", (await checkOnboardingBudget(SHARED, IP_A)).ok);
  const overSource = await checkOnboardingBudget(SHARED, IP_A);
  check("their third is refused while the day still has 8 free", !overSource.ok);
  check(
    "the refusal says it is this connection's limit, not the day's",
    /from this connection/.test(overSource.reason ?? "") && /limit of 2 is reached/.test(overSource.reason ?? ""),
    overSource.reason,
  );
  /* The claim screen offers a retry for any refusal it cannot place, and this one cannot succeed
     until UTC midnight. Both cap refusals therefore carry the word that screen classifies as a
     deliberate stop (apps/web/lib/claim-error.ts), and say when to come back. */
  check(
    "both refusals read as a deliberate stop, with a time to come back",
    [overSource.reason, fourth.reason].every((r) => /paused/.test(r ?? "") && /try again tomorrow/.test(r ?? "")),
  );
  check(
    "A DIFFERENT SOURCE IS STILL SERVED — exhausting one caller refuses nobody else",
    (await checkOnboardingBudget(SHARED, IP_B)).ok,
  );
  check(
    "the refused attempt cost the day nothing (3 accounts, not 4)",
    srcKv.store.get(accountDayKey(Date.now())) === 3n,
    `${srcKv.store.get(accountDayKey(Date.now()))} counted`,
  );
  check(
    "and gave the caller's own share back too",
    srcKv.store.get(accountSourceDayKey(Date.now(), IP_A)) === 2n,
    `${srcKv.store.get(accountSourceDayKey(Date.now(), IP_A))} counted`,
  );
  check(
    "the per-source bucket is per network, and never the global one",
    accountSourceDayKey(1, IP_A, "mainnet") !== accountSourceDayKey(1, IP_A, "testnet") &&
      accountSourceDayKey(1, IP_A) !== accountDayKey(1),
  );

  // Keyed exactly as the rate limiter keys a caller, or the bound is free to walk around: a single
  // residential IPv6 allocation is a /64, and a fresh address out of it must not be a fresh budget.
  const V6_ONE = "2a02:db8:1:2::1";
  const V6_SAME_64 = "2a02:db8:1:2:ffff:ffff:ffff:ffff";
  const V6_OTHER_64 = "2a02:db8:1:3::1";
  installFakeKv();
  check("an IPv6 caller's first two are allowed", (await checkOnboardingBudget(SHARED, V6_ONE)).ok && (await checkOnboardingBudget(SHARED, V6_ONE)).ok);
  check(
    "a fresh address in the SAME /64 is the same share, and is refused",
    !(await checkOnboardingBudget(SHARED, V6_SAME_64)).ok,
  );
  check("a genuinely different /64 is a different share", (await checkOnboardingBudget(SHARED, V6_OTHER_64)).ok);

  // A request that arrives with no usable address (no cf-connecting-ip, no x-forwarded-for) shares
  // one bucket — bounded together rather than let past the bound.
  installFakeKv();
  check("an addressless caller is allowed twice", (await checkOnboardingBudget(SHARED, "")).ok && (await checkOnboardingBudget(SHARED, "unknown")).ok);
  check("and then refused like any other source", !(await checkOnboardingBudget(SHARED, "")).ok);
  check("its bucket is the named one, not an empty key", accountSourceDayKey(1, "").endsWith(":src:unknown"));

  /* THE OPPOSITE DIRECTION TO [5], on purpose. There, fail-closed means create no new escrow while
     the counter is untrusted. Here the gated route is the walletless recipient's first step toward
     money ALREADY escrowed for them, so a refusal is one nobody can act on — not by retrying, not by
     waiting out the day, not from another network. Fail-closed therefore degrades to the per-isolate
     counter and keeps SERVING; what it buys is a bound, not a guarantee (lib/caps.ts).

     That counter is module state every case below shares, so each releases what it reserves. Without
     that, a case reads the leftovers of the one before it instead of its own setup — and a check
     that "a refusal fired" would be measuring the leak, not the bound. */
  console.log("[10] onboarding budget — a store outage bounds onboarding, it never refuses it");
  const FAIL_CLOSED: OnboardingBudget = { ...BUDGET, failClosed: true };
  installFakeKv({ fail: true });
  check("fail-open (testnet default): an outage does not stop onboarding", (await checkOnboardingBudget(BUDGET, IP_A)).ok);
  const unreadable = await checkOnboardingBudget(FAIL_CLOSED, IP_A);
  check("fail-closed: an UNREADABLE counter still serves the claim in front of it", unreadable.ok);
  check("and still exposes release(), so a handout that never happened is not charged", typeof unreadable.release === "function");
  await unreadable.release?.();
  clearKv();
  const unconfigured = await checkOnboardingBudget(FAIL_CLOSED, IP_A);
  check("fail-closed with NO store configured also serves", unconfigured.ok);
  await unconfigured.release?.();
  check("fail-open with no store still allows", (await checkOnboardingBudget(BUDGET, IP_A)).ok);

  // Serving is not an amnesty: the degraded counter carries the SAME two budgets, so a caller that
  // keeps asking still runs out — per isolate, which is the honest limit of what this can promise.
  const localHeld: CapVerdict[] = [];
  for (let i = 0; i < FAIL_CLOSED.maxDayAccounts; i++) localHeld.push(await checkOnboardingBudget(FAIL_CLOSED, IP_A));
  check("a degraded counter admits exactly the day's budget", localHeld.every((v) => v.ok));
  const pastLocal = await checkOnboardingBudget(FAIL_CLOSED, IP_D);
  check("and refuses the one past it", !pastLocal.ok);
  check(
    "the refusal names the day's limit",
    !pastLocal.ok && /limit of 3 a day is reached/.test(pastLocal.reason ?? ""),
    pastLocal.reason,
  );
  check(
    "and says nothing about the store's own error",
    !pastLocal.ok && !/store|KV|fetch|500/i.test(pastLocal.reason ?? ""),
    pastLocal.reason,
  );
  for (const v of localHeld) await v.release?.();
  const afterRelease = await checkOnboardingBudget(FAIL_CLOSED, IP_D);
  check("releasing them all frees the degraded budget again", afterRelease.ok);
  await afterRelease.release?.();

  // The tighter bound survives the degrade too — one caller running out still costs nobody else.
  const LOCAL_SHARED: OnboardingBudget = { maxDayAccounts: 10, maxDaySourceAccounts: 2, failClosed: true };
  const localShare = [await checkOnboardingBudget(LOCAL_SHARED, IP_B), await checkOnboardingBudget(LOCAL_SHARED, IP_B)];
  check("a degraded counter still gives each caller their own share", localShare.every((v) => v.ok));
  const pastLocalShare = await checkOnboardingBudget(LOCAL_SHARED, IP_B);
  check(
    "past that share the refusal is theirs, not the day's",
    !pastLocalShare.ok && /from this connection/.test(pastLocalShare.reason ?? ""),
    pastLocalShare.reason,
  );
  const otherCaller = await checkOnboardingBudget(LOCAL_SHARED, IP_C);
  check("while a different caller is served as normal", otherCaller.ok);
  await otherCaller.release?.();
  for (const v of localShare) await v.release?.();

  /* The share is a RATIO of the day, and the ratio is per network. Testnet keeps a fifth with a
     floor of 20 (a demo room behind one NAT). Mainnet is an eighth with NO floor: the pilot's day
     is 60 real-money slots, and a floor of 20 would have let three connections close it. */
  console.log("[11] onboarding budget: configuration (the mainnet share is an eighth, with no floor)");
  delete process.env.MAX_DAY_ACCOUNTS;
  delete process.env.MAX_DAY_ACCOUNTS_PER_SOURCE;
  delete process.env.CAPS_FAIL_CLOSED;
  delete process.env.STELLAR_NETWORK;
  const budgetDefaults = onboardingBudgetFromEnv();
  check("default budget is 500 accounts a day", budgetDefaults.maxDayAccounts === 500);
  check("one testnet caller's default share is a fifth of it", budgetDefaults.maxDaySourceAccounts === 100);
  check("testnet is fail-open", !budgetDefaults.failClosed);
  process.env.STELLAR_NETWORK = "mainnet";
  check("mainnet is fail-closed WITHOUT CAPS_FAIL_CLOSED being set", onboardingBudgetFromEnv().failClosed);
  check("one mainnet caller's default share is an eighth (500 -> 63)", onboardingBudgetFromEnv().maxDaySourceAccounts === 63);
  process.env.MAX_DAY_ACCOUNTS = "60";
  check("the deployed mainnet day of 60 gives a share of 8", onboardingBudgetFromEnv().maxDaySourceAccounts === 8);
  process.env.MAX_DAY_ACCOUNTS = "40";
  check("a mainnet day of 40 gives a share of 5, not the old floor of 20", onboardingBudgetFromEnv().maxDaySourceAccounts === 5);
  process.env.MAX_DAY_ACCOUNTS = "7";
  check("a tiny mainnet day gives a share of 1: no floor ever lifts it above an eighth", onboardingBudgetFromEnv().maxDaySourceAccounts === 1);
  check(
    "the network is also an explicit argument, so a caller need not rely on the env (testnet's floor of 20 clamps to the day of 7)",
    onboardingBudgetFromEnv("testnet").maxDaySourceAccounts === 7 && onboardingBudgetFromEnv("mainnet").maxDaySourceAccounts === 1,
  );
  delete process.env.STELLAR_NETWORK;
  process.env.CAPS_FAIL_CLOSED = "1";
  check("CAPS_FAIL_CLOSED=1 flips it on testnet too", onboardingBudgetFromEnv().failClosed);
  delete process.env.CAPS_FAIL_CLOSED;
  process.env.MAX_DAY_ACCOUNTS = "40";
  check("MAX_DAY_ACCOUNTS overrides the default", onboardingBudgetFromEnv().maxDayAccounts === 40);
  check("on testnet the share keeps its floor of 20 (40 -> 20)", onboardingBudgetFromEnv().maxDaySourceAccounts === 20);
  process.env.MAX_DAY_ACCOUNTS_PER_SOURCE = "5";
  check("MAX_DAY_ACCOUNTS_PER_SOURCE overrides the share", onboardingBudgetFromEnv().maxDaySourceAccounts === 5);
  process.env.MAX_DAY_ACCOUNTS_PER_SOURCE = "999";
  check(
    "a share larger than the day is clamped to it, never left unable to fire",
    onboardingBudgetFromEnv().maxDaySourceAccounts === 40,
  );
  process.env.MAX_DAY_ACCOUNTS_PER_SOURCE = "0";
  check("a zero share falls back to the derived default", onboardingBudgetFromEnv().maxDaySourceAccounts === 20);
  process.env.MAX_DAY_ACCOUNTS_PER_SOURCE = "nonsense";
  check("a malformed share falls back too", onboardingBudgetFromEnv().maxDaySourceAccounts === 20);
  delete process.env.MAX_DAY_ACCOUNTS_PER_SOURCE;
  process.env.MAX_DAY_ACCOUNTS = "0";
  check("a zero override falls back to the default, never to unlimited", onboardingBudgetFromEnv().maxDayAccounts === 500);
  process.env.MAX_DAY_ACCOUNTS = "nonsense";
  check("a malformed override falls back to the default too", onboardingBudgetFromEnv().maxDayAccounts === 500);
  delete process.env.MAX_DAY_ACCOUNTS;

  console.log("[11b] onboarding budget: the deployed mainnet pair, two sources cannot exhaust a day of 60");
  const MAINNET_DAY: OnboardingBudget = { maxDayAccounts: 60, maxDaySourceAccounts: 8, failClosed: true };
  const pairKv = installFakeKv();
  const fromA: CapVerdict[] = [];
  for (let i = 0; i < 8; i++) fromA.push(await checkOnboardingBudget(MAINNET_DAY, IP_A));
  check("source A gets its share of 8", fromA.every((v) => v.ok));
  const ninthA = await checkOnboardingBudget(MAINNET_DAY, IP_A);
  check("and is stopped at the 9th, by its own share", !ninthA.ok && /from this connection/.test(ninthA.reason ?? ""), ninthA.reason);
  const fromB: CapVerdict[] = [];
  for (let i = 0; i < 8; i++) fromB.push(await checkOnboardingBudget(MAINNET_DAY, IP_B));
  check("source B gets its 8 as well", fromB.every((v) => v.ok));
  check("and is stopped at its 9th", !(await checkOnboardingBudget(MAINNET_DAY, IP_B)).ok);
  check("A THIRD SOURCE IS SERVED: two callers took 16 of 60, not the day", (await checkOnboardingBudget(MAINNET_DAY, IP_C)).ok);
  check(
    "the day counter reads 17, the two refused attempts cost nothing",
    pairKv.store.get(accountDayKey(Date.now())) === 17n,
    `${pairKv.store.get(accountDayKey(Date.now()))} counted`,
  );

  /* ONE SLOT PER RECIPIENT KEY. A claim that retries calls /create-account again with the same
     recipient key; each call used to spend a fresh slot, and a few flaky recipients could close a
     60-slot mainnet day for everyone. A public key becomes at most one account, so the reserve this
     budget bounds is locked at most once per key: the marker makes the counter say the same. */
  console.log("[11c] onboarding budget: the same recipient key costs one slot a day, however often it asks");
  const PK1 = Keypair.random().publicKey();
  const PK2 = Keypair.random().publicKey();
  const PK3 = Keypair.random().publicKey();
  const PK4 = Keypair.random().publicKey();
  const TINY: OnboardingBudget = { maxDayAccounts: 3, maxDaySourceAccounts: 3, failClosed: true };
  const pkKv = installFakeKv();
  const firstPk = await checkOnboardingBudget(TINY, IP_A, NOW, PK1);
  check("a recipient key's first request reserves a slot", firstPk.ok && pkKv.store.get(accountDayKey(NOW)) === 1n);
  const marker1 = pkKv.store.get(`caps:testnet:accounts:${NOW_DAY}:pk:${PK1}`);
  check(
    "and writes its marker, namespaced by network and day, holding THIS request's token (the fence)",
    typeof marker1 === "string" && marker1.length >= 16,
    String(marker1),
  );
  check("a first admission is not a repeat", firstPk.repeat !== true);
  const readPipeline = pkKv.pipelines.at(-2)!;
  const stampPipeline = pkKv.pipelines.at(-1)!;
  check(
    "the marker is READ (GET) first in the SAME pipeline as the two increments (one round trip)",
    readPipeline.length === 5 && readPipeline[0]![0] === "GET" && readPipeline[1]![0] === "INCRBY",
    readPipeline.map((c) => c[0]).join(","),
  );
  check(
    "and WRITTEN (SET NX) only after both limits passed, in its own round trip",
    stampPipeline.length === 1 && stampPipeline[0]![0] === "SET" && stampPipeline[0]![3] === "NX",
    stampPipeline.map((c) => c.slice(0, 1).concat(c.slice(3, 4)).join(" ")).join(","),
  );
  const repeatPk = await checkOnboardingBudget(TINY, IP_A, NOW, PK1);
  check("the SAME key asking again is served", repeatPk.ok);
  check("and says it is a repeat (served without a reservation, at most MAX_REPEATS_PER_KEY a day)", repeatPk.repeat === true);
  check("and costs no second slot", pkKv.store.get(accountDayKey(NOW)) === 1n && pkKv.store.get(accountSourceDayKey(NOW, IP_A)) === 1n);
  check(
    "the repeat RE-STAMPS the marker with its own token, fencing the first request off the slot",
    typeof pkKv.store.get(accountPubkeyDayKey(NOW, PK1)) === "string" && pkKv.store.get(accountPubkeyDayKey(NOW, PK1)) !== marker1,
  );
  check("its release is a no-op function, so the caller needs no special case", typeof repeatPk.release === "function");
  await repeatPk.release!();
  check(
    "releasing the repeat changes nothing: the slot and the marker belong to the first request",
    pkKv.store.get(accountDayKey(NOW)) === 1n && pkKv.store.has(accountPubkeyDayKey(NOW, PK1)),
  );
  check("the same key from ANOTHER source is still the same slot: the key holds it, not the caller", (await checkOnboardingBudget(TINY, IP_B, NOW, PK1)).ok && pkKv.store.get(accountDayKey(NOW)) === 1n);
  check("a DIFFERENT key from the same source costs another slot", (await checkOnboardingBudget(TINY, IP_A, NOW, PK2)).ok && pkKv.store.get(accountDayKey(NOW)) === 2n);
  /* THE RACE THE FENCE CLOSES: PK1's first attempt fails AFTER its repeats were served (its Horizon
     read threw while the retry went through). Before the fence its release decremented and deleted
     unconditionally: the day read one low and the key could be admitted again for free. */
  await firstPk.release!();
  check(
    "FENCED: a first attempt released after a repeat was served gives NOTHING back (the repeat's handout uses the slot)",
    pkKv.store.get(accountDayKey(NOW)) === 2n && pkKv.store.has(accountPubkeyDayKey(NOW, PK1)),
    `day ${pkKv.store.get(accountDayKey(NOW))}`,
  );
  check(
    "the release went as ONE fenced EVAL (compare-and-delete), not as plain decrements",
    pkKv.pipelines.at(-1)!.length === 1 && pkKv.pipelines.at(-1)![0]![0] === "EVAL",
    pkKv.pipelines.at(-1)!.map((c) => c[0]).join(","),
  );
  check("so the key is still a free repeat afterwards", (await checkOnboardingBudget(TINY, IP_A, NOW, PK1)).repeat === true && pkKv.store.get(accountDayKey(NOW)) === 2n);
  const solo = await checkOnboardingBudget(TINY, IP_C, NOW, PK3);
  check("a third key fills the day", solo.ok && pkKv.store.get(accountDayKey(NOW)) === 3n);
  await solo.release!(); // its handler threw, and no repeat came in between
  check(
    "a released attempt with NO repeat in between hands back its slot AND its marker",
    pkKv.store.get(accountDayKey(NOW)) === 2n && !pkKv.store.has(accountPubkeyDayKey(NOW, PK3)),
  );
  await solo.release!();
  check("and a second release of the same attempt is a no-op (the fence again)", pkKv.store.get(accountDayKey(NOW)) === 2n);
  check("so a retry after that release costs one slot, net one for the key", (await checkOnboardingBudget(TINY, IP_C, NOW, PK3)).ok && pkKv.store.get(accountDayKey(NOW)) === 3n);
  const refusedPk = await checkOnboardingBudget(TINY, IP_D, NOW, PK4);
  check("a fourth key is refused by the day's limit", !refusedPk.ok && /limit of 3 a day/.test(refusedPk.reason ?? ""), refusedPk.reason);
  check(
    "a refused key leaves NO marker behind, or its retry tomorrow-morning would be free",
    !pkKv.store.has(accountPubkeyDayKey(NOW, PK4)) && pkKv.store.get(accountDayKey(NOW)) === 3n,
  );
  check(
    "the marker key is namespaced by network and by day",
    accountPubkeyDayKey(1, PK1, "mainnet") !== accountPubkeyDayKey(1, PK1, "testnet") &&
      accountPubkeyDayKey(NOW, PK1) !== accountPubkeyDayKey(OTHER_DAY, PK1) &&
      accountPubkeyDayKey(NOW, PK1) === `caps:testnet:accounts:${NOW_DAY}:pk:${PK1}`,
  );
  const junkKv = installFakeKv();
  const junk = await checkOnboardingBudget(SHARED, IP_A, NOW, "not-a-public-key");
  check(
    "a malformed key gets no marker (the handler refuses it next) but is counted like any other request",
    junk.ok && junkKv.store.get(accountDayKey(NOW)) === 1n && ![...junkKv.store.keys()].some((k) => k.includes(":pk:")),
  );
  await junk.release!();
  check("without a key at all, no marker and no SET: the old four-command pipeline", junkKv.pipelines.at(-1)!.every((c) => c[0] !== "SET"));

  {
    // The race the review found inside the fence: B (a retry) loses its SET NX to A, and A's handler
    // fails and releases the slot BEFORE B's second round trip re-stamps the marker. B must then be
    // admitted afresh, not served as a repeat on a slot nobody holds.
    const raceKv = installFakeKv();
    const ONE: OnboardingBudget = { maxDayAccounts: 1, maxDaySourceAccounts: 1, failClosed: true };
    const K = Keypair.random().publicKey();
    const a = await checkOnboardingBudget(ONE, IP_A, NOW, K);
    raceKv.hooks.beforePipeline = async (cmds) => {
      if (cmds.some((c) => c[0] === "SET" && c.includes("XX"))) {
        raceKv.hooks.beforePipeline = undefined;
        await a.release!();
      }
    };
    const b = await checkOnboardingBudget(ONE, IP_A, NOW, K);
    check(
      "a retry whose first attempt is released mid-flight is admitted afresh (the day reads 1, not 0)",
      a.ok && b.ok && b.repeat !== true && raceKv.store.get(accountDayKey(NOW)) === 1n,
      `day ${raceKv.store.get(accountDayKey(NOW))}, repeat ${b.repeat}`,
    );
    check("so a day of 1 is still full for another key", !(await checkOnboardingBudget(ONE, IP_B, NOW, Keypair.random().publicKey())).ok);
  }
  {
    /* The race the regression review found: the marker used to be written BEFORE the limits were
       checked. A request the day's limit then refused held it until its release ran, and a second
       request for the same key arriving in that window was served as a repeat with no limit checked
       at all (and its re-stamp then fenced off the refused request's own hand-back, so the day stayed
       one high and the key "held" a slot nobody was admitted to). */
    const raceKv = installFakeKv();
    const ONE: OnboardingBudget = { maxDayAccounts: 1, maxDaySourceAccounts: 1, failClosed: true };
    await checkOnboardingBudget(ONE, IP_C, NOW, Keypair.random().publicKey()); // fills the day
    const K = Keypair.random().publicKey();
    let b: Awaited<ReturnType<typeof checkOnboardingBudget>> | null = null;
    let seen = 0;
    raceKv.hooks.beforePipeline = async () => {
      if (++seen === 2) {
        // A has read and counted; B (same key, another connection) runs to completion before A's next round trip.
        raceKv.hooks.beforePipeline = undefined;
        b = await checkOnboardingBudget(ONE, IP_B, NOW, K);
      }
    };
    const a = await checkOnboardingBudget(ONE, IP_A, NOW, K);
    const bv = b as Awaited<ReturnType<typeof checkOnboardingBudget>> | null;
    check("A, past the day's limit, is refused", !a.ok && /limit of 1 a day/.test(a.reason ?? ""), a.reason);
    check(
      "B for the SAME key, inside A's window, is checked against the limits and refused too, never served as a repeat",
      !!bv && !bv.ok && bv.repeat !== true,
      bv ? `${bv.ok} ${bv.repeat} ${bv.reason}` : "B never ran",
    );
    check(
      "and nothing is left behind: the day reads 1 again and the key holds no marker",
      raceKv.store.get(accountDayKey(NOW)) === 1n && !raceKv.store.has(accountPubkeyDayKey(NOW, K)),
      `day ${raceKv.store.get(accountDayKey(NOW))}`,
    );
  }
  {
    // Two first requests for one key, both inside the limits: one SET NX wins, the other is served
    // as that key's repeat and hands its increments back. One slot for the key, whoever wins.
    const raceKv = installFakeKv();
    const K = Keypair.random().publicKey();
    let b: Awaited<ReturnType<typeof checkOnboardingBudget>> | null = null;
    let seen = 0;
    raceKv.hooks.beforePipeline = async () => {
      if (++seen === 2) {
        raceKv.hooks.beforePipeline = undefined;
        b = await checkOnboardingBudget(TINY, IP_B, NOW, K);
      }
    };
    const a = await checkOnboardingBudget(TINY, IP_A, NOW, K);
    const bv = b as Awaited<ReturnType<typeof checkOnboardingBudget>> | null;
    check(
      "two concurrent first requests for one key: both served, exactly one of them as a repeat",
      a.ok && !!bv?.ok && [a.repeat === true, bv?.repeat === true].filter(Boolean).length === 1,
      `a.repeat ${a.repeat}, b.repeat ${bv?.repeat}`,
    );
    check("and the key costs ONE slot on the day and on each source", raceKv.store.get(accountDayKey(NOW)) === 1n &&
      BigInt(raceKv.store.get(accountSourceDayKey(NOW, IP_A)) ?? 0n) + BigInt(raceKv.store.get(accountSourceDayKey(NOW, IP_B)) ?? 0n) === 1n);
    await bv!.release!(); // B was admitted; its handler fails AFTER A's repeat re-stamped the marker
    check("the admitted one's later release is fenced off (the repeat's handout uses the slot)", raceKv.store.get(accountDayKey(NOW)) === 1n);
  }
  {
    /* The marker's SET NX applied, its answer lost. The release must still go through the fence:
       a plain decrement left the marker behind with the day one low, so every later request for
       the key was a free repeat on a slot nobody held (a review showed it). */
    const lostKv = installFakeKv();
    const K = Keypair.random().publicKey();
    lostKv.hooks.afterPipeline = (cmds) => {
      if (cmds.some((c) => c[0] === "SET" && c.includes("NX"))) {
        lostKv.hooks.afterPipeline = undefined;
        throw new TypeError("fetch failed: socket hang up");
      }
    };
    const v = await checkOnboardingBudget(TINY, IP_A, NOW, K);
    check("a lost answer to the marker's SET NX still admits (the slot is counted)", v.ok && lostKv.store.get(accountDayKey(NOW)) === 1n);
    await v.release!();
    check(
      "and its release is the fenced EVAL: the marker it did write goes with the slot (day 0, no marker)",
      lostKv.store.get(accountDayKey(NOW)) === 0n && !lostKv.store.has(accountPubkeyDayKey(NOW, K)) && lostKv.pipelines.at(-1)![0]![0] === "EVAL",
      `day ${lostKv.store.get(accountDayKey(NOW))}, marker ${lostKv.store.has(accountPubkeyDayKey(NOW, K))}`,
    );
    const next = await checkOnboardingBudget(TINY, IP_A, NOW, K);
    check("so the key's next request is a fresh admission that counts, not a free repeat", next.ok && next.repeat !== true && lostKv.store.get(accountDayKey(NOW)) === 1n);
  }
  {
    // The repeat cap is per key AND source: a stranger who knows an address cannot spend its owner's retries.
    const capKv = installFakeKv();
    const K = Keypair.random().publicKey();
    await checkOnboardingBudget(TINY, IP_A, NOW, K);
    for (let i = 0; i <= MAX_REPEATS_PER_KEY; i++) await checkOnboardingBudget(TINY, IP_A, NOW, K);
    const strangerPast = await checkOnboardingBudget(TINY, IP_A, NOW, K);
    const owner = await checkOnboardingBudget(TINY, IP_B, NOW, K);
    check("one source past its repeats is refused", !strangerPast.ok && /paused for today/.test(strangerPast.reason ?? ""));
    check("while the same key from another source is still served as a repeat", owner.ok && owner.repeat === true && capKv.store.get(accountDayKey(NOW)) === 1n);
  }
  {
    // Free is not unbounded: each repeat is a freshly signed sandwich the fee budget counts.
    const repKv = installFakeKv();
    const PK9 = Keypair.random().publicKey();
    const first = await checkOnboardingBudget(TINY, IP_A, NOW, PK9);
    const served: boolean[] = [];
    for (let i = 0; i < MAX_REPEATS_PER_KEY; i++) served.push((await checkOnboardingBudget(TINY, IP_A, NOW, PK9)).ok);
    const past = await checkOnboardingBudget(TINY, IP_A, NOW, PK9);
    check(`a key's first ${MAX_REPEATS_PER_KEY} repeats in a day are served`, first.ok && served.every(Boolean));
    check("the next repeat is refused, in a sentence that reads as a deliberate stop", !past.ok && /paused for today/.test(past.reason ?? ""), past.reason);
    check("and a refused repeat reserves nothing", repKv.store.get(accountDayKey(NOW)) === 1n);
    check("another key is untouched by it", (await checkOnboardingBudget(TINY, IP_A, NOW, Keypair.random().publicKey())).ok);
  }

  // The degraded counter keeps the rule too: per isolate, a key admitted during an outage is free
  // to retry during the same outage.
  installFakeKv({ fail: true });
  const PK5 = Keypair.random().publicKey();
  const PK6 = Keypair.random().publicKey();
  const PK7 = Keypair.random().publicKey();
  const PK8 = Keypair.random().publicKey();
  const localPk = [
    await checkOnboardingBudget(TINY, IP_A, NOW, PK5),
    await checkOnboardingBudget(TINY, IP_A, NOW, PK5),
    await checkOnboardingBudget(TINY, IP_B, NOW, PK6),
    await checkOnboardingBudget(TINY, IP_C, NOW, PK7),
  ];
  check("store unreadable: the same key twice plus two others fill a day of 3 exactly", localPk.every((v) => v.ok));
  check("and the per-isolate counter flags the repeat too", localPk[1]!.repeat === true);
  const pastLocalPk = await checkOnboardingBudget(TINY, IP_D, NOW, PK8);
  check("and a fourth key is refused by the per-isolate counter", !pastLocalPk.ok && /limit of 3 a day/.test(pastLocalPk.reason ?? ""));
  await localPk[0]!.release!(); // PK5's first reservation, released after its repeat was served
  check("per isolate the slot is fenced the same way: PK5's first release frees nothing", !(await checkOnboardingBudget(TINY, IP_D, NOW, PK8)).ok);
  await localPk[2]!.release!(); // PK6, with no repeat in between
  const retryLocal = await checkOnboardingBudget(TINY, IP_D, NOW, PK8);
  check("releasing an admitted key with no repeat frees its slot for another", retryLocal.ok);
  await retryLocal.release!();
  for (const v of localPk.slice(1)) await v.release?.();

  /* THE SPONSOR FEE BUDGET. Every value route ends with the sponsor paying a fee it chose to bid;
     this counter is the one bound on that spend, and the test pins the rules that make it a
     ceiling: the bid is counted before any signature, a refusal undoes only its own increment, and
     an accepted charge moves only on an answer that DECIDES the fee (never on a guess). */
  console.log("[12] sponsor fee budget: bids accumulate, the budget is a ceiling, a charge moves only on a decided answer");
  const feeKv = installFakeKv();
  delete process.env.STELLAR_NETWORK;
  delete process.env.MAX_DAY_FEE_XLM;
  const TEN_K: FeeBudget = { maxDayFeeStroops: 10_000n };
  const feeKey = feeDayKey(NOW);
  const feeSpent = () => (feeKv.store.get(feeKey) as bigint | undefined) ?? 0n;
  const charged1 = await chargeSponsorFee(4000, TEN_K, NOW);
  check("a number bid is added to the day", charged1.totalStroops === 4000n && charged1.shared && feeSpent() === 4000n);
  check("a string bid (a fee-bump's .fee) accumulates on top", (await chargeSponsorFee("3000", TEN_K, NOW)).totalStroops === 7000n);
  check("a bigint bid accumulates too", (await chargeSponsorFee(2000n, TEN_K, NOW)).totalStroops === 9000n);
  check("a bid of EXACTLY the remaining budget is accepted", (await chargeSponsorFee(1000, TEN_K, NOW)).totalStroops === 10_000n);
  let refusedFee: unknown = null;
  try {
    await chargeSponsorFee(1, TEN_K, NOW);
  } catch (e) {
    refusedFee = e;
  }
  check("one stroop past the budget is refused", refusedFee !== null);
  check(
    "the refusal is a PublicRefusal carrying the one public sentence",
    isPublicRefusal(refusedFee) && (refusedFee as Error).message === FEE_BUDGET_REFUSAL,
    (refusedFee as Error | null)?.message,
  );
  check("and the counter is back at its previous value: the refused increment was undone", feeSpent() === 10_000n);
  let refusedBig: unknown = null;
  try {
    await chargeSponsorFee(5000, TEN_K, NOW);
  } catch (e) {
    refusedBig = e;
  }
  check("a larger bid past the budget is refused and undone the same way", isPublicRefusal(refusedBig) && feeSpent() === 10_000n);
  check(
    "the module still exports no free-standing way to give a fee back: only the handle a charge returns can",
    Object.keys(capsModule).every((k) => !(/fee/i.test(k) && /release|refund|undo|give|credit/i.test(k))),
    Object.keys(capsModule).filter((k) => /fee/i.test(k)).join(","),
  );
  {
    // The handle: notIncluded gives the whole bid back, settled trues it down to the ledger's fee,
    // and each handle settles at most ONCE. On its own day key, so the totals above stay put.
    const D = Date.parse("2026-10-11T12:00:00Z");
    const k = feeDayKey(D);
    const at = () => (feeKv.store.get(k) as bigint | undefined) ?? 0n;
    const a = await chargeSponsorFee(5000, TEN_K, D);
    await a.notIncluded();
    check("notIncluded gives the whole bid back (a transaction that never reached a ledger cost nothing)", at() === 0n && a.bidStroops === 5000n);
    await a.notIncluded();
    await a.settled(0);
    check("and a second call on the same handle, of either kind, changes nothing", at() === 0n);
    const b = await chargeSponsorFee(5000, TEN_K, D);
    await b.settled("1234");
    check("settled(feeCharged) trues the count down to what the ledger charged", at() === 1234n);
    await b.notIncluded();
    check("and a settled charge can no longer be given back whole", at() === 1234n);
    const c = await chargeSponsorFee(3000, TEN_K, D);
    await c.settled(9_999_999);
    check("a reported fee ABOVE the bid changes nothing (the bid stays counted, never more, never less)", at() === 4234n);
    const d2 = await chargeSponsorFee(1000, TEN_K, D);
    await d2.settled(null);
    await d2.settled("not a number");
    check("an unreadable fee keeps the whole bid (never guess low)", at() === 5234n);
    const e = await chargeSponsorFee(1000, TEN_K, D);
    await e.settled(1000n);
    check("a fee equal to the bid leaves the bid", at() === 6234n);
    // Pinned to its own day: a give-back after midnight goes to the day the charge landed in.
    const late = await chargeSponsorFee(700, TEN_K, D);
    const nextDayCharge = await chargeSponsorFee(50, TEN_K, D + 86_400_000);
    await late.notIncluded();
    check(
      "a give-back after midnight lands on the charge's own day, never on the new one",
      at() === 6234n && feeKv.store.get(feeDayKey(D + 86_400_000)) === 50n,
      `${at()} / ${feeKv.store.get(feeDayKey(D + 86_400_000))}`,
    );
    await nextDayCharge.notIncluded();
    // signCharged: a signer that throws gives the charge back and the error goes on unchanged.
    const s = await chargeSponsorFee(400, TEN_K, D);
    let thrown = "";
    try {
      await signCharged(s, () => {
        throw new Error("kms: 400 AccessDeniedException");
      });
    } catch (err) {
      thrown = (err as Error).message;
    }
    check("signCharged: a signer that throws gives the bid back and rethrows the same error", at() === 6234n && thrown === "kms: 400 AccessDeniedException", thrown);
    const s2 = await chargeSponsorFee(400, TEN_K, D);
    await signCharged(s2, () => {});
    check("signCharged: a signature that succeeds keeps the charge open", at() === 6634n);
    check(
      "the GROSS key kept every accepted bid (16,500 stroops) while the net reads 6,634: a give-back never lowers it",
      feeKv.store.get(feeGrossDayKey(D)) === 16_500n,
      String(feeKv.store.get(feeGrossDayKey(D))),
    );
    // The per-isolate counter takes give-backs too, while the store is down.
    installFakeKv({ fail: true });
    const local = await chargeSponsorFee(2500, TEN_K, D);
    await local.notIncluded();
    const localAfter = await chargeSponsorFee(1, TEN_K, D);
    check("store outage: a give-back reaches the per-isolate counter", !local.shared && localAfter.totalStroops === 1n, String(localAfter.totalStroops));
    await localAfter.notIncluded();
  }
  // Back to the store the rest of this section reads.
  feeKv.reinstall();
  const callsBefore = feeKv.calls.length;
  const pipelinesBefore = feeKv.pipelines.length;
  const reading = await readSponsorFeeDay(TEN_K, NOW);
  check(
    "readSponsorFeeDay reads the day's total with a GET and reports the fraction used",
    reading.spentStroops === 10_000n && reading.used === 1 && reading.day === NOW_DAY && reading.maxStroops === 10_000n,
    JSON.stringify({ ...reading, spentStroops: String(reading.spentStroops), grossStroops: String(reading.grossStroops), maxStroops: String(reading.maxStroops) }),
  );
  check("and the gross, every bid accepted that day (the two refused bids were undone in it too)", reading.grossStroops === 10_000n, String(reading.grossStroops));
  const readCalls = feeKv.calls.slice(callsBefore);
  check(
    "the reads went to /get/<the fee day key> and /get/<its gross key>, never through a write",
    readCalls.length === 2 &&
      readCalls.includes(`${FAKE_KV_URL}/get/${feeKey}`) &&
      readCalls.includes(`${FAKE_KV_URL}/get/${feeGrossDayKey(NOW)}`) &&
      feeKv.pipelines.length === pipelinesBefore,
    readCalls.join(" "),
  );
  installFakeKv();
  const empty = await readSponsorFeeDay(TEN_K, NOW);
  check("an untouched day reads as zero spent, nothing used", empty.spentStroops === 0n && empty.used === 0);
  check(
    "the fee key is caps:<net>:fees:<utc-day>, per network, and never one of the other counters",
    feeDayKey(NOW, "mainnet") === `caps:mainnet:fees:${NOW_DAY}` &&
      feeDayKey(NOW, "mainnet") !== feeDayKey(NOW, "testnet") &&
      feeDayKey(NOW) !== dayKey(NOW) &&
      feeDayKey(NOW) !== accountDayKey(NOW) &&
      feeDayKey(NOW) !== feeDayKey(OTHER_DAY),
  );

  // Configuration: the mainnet default is the pilot's 15 XLM, the testnet default is play money.
  check("feeBudgetFromEnv defaults to 15 XLM on mainnet", feeBudgetFromEnv("mainnet").maxDayFeeStroops === 150_000_000n);
  check("and to 2000 XLM on testnet", feeBudgetFromEnv("testnet").maxDayFeeStroops === 20_000_000_000n);
  process.env.STELLAR_NETWORK = "mainnet";
  check("the network defaults from STELLAR_NETWORK", feeBudgetFromEnv().maxDayFeeStroops === 150_000_000n);
  delete process.env.STELLAR_NETWORK;
  process.env.MAX_DAY_FEE_XLM = "0.5";
  check("MAX_DAY_FEE_XLM overrides it, fractional XLM accepted", feeBudgetFromEnv("mainnet").maxDayFeeStroops === 5_000_000n);
  process.env.MAX_DAY_FEE_XLM = "nonsense";
  check("a malformed value falls back to the network default, never to unlimited", feeBudgetFromEnv("mainnet").maxDayFeeStroops === 150_000_000n);
  process.env.MAX_DAY_FEE_XLM = "0";
  check("zero falls back too", feeBudgetFromEnv("mainnet").maxDayFeeStroops === 150_000_000n);
  process.env.MAX_DAY_FEE_XLM = "-3";
  check("and so does a negative", feeBudgetFromEnv("testnet").maxDayFeeStroops === 20_000_000_000n);
  delete process.env.MAX_DAY_FEE_XLM;

  // Bids that are not bids: a programming error, not a refusal, and nothing is counted for them.
  const badKv = installFakeKv();
  const throwsWith = async (bid: bigint | number | string, re: RegExp) => {
    try {
      await chargeSponsorFee(bid, TEN_K, NOW);
      return false;
    } catch (e) {
      return re.test((e as Error).message) && !isPublicRefusal(e);
    }
  };
  check("a negative bigint bid throws", await throwsWith(-1n, /cannot be negative/));
  check("a negative number bid throws", await throwsWith(-5, /cannot be negative/));
  check("a negative string bid throws", await throwsWith("-7", /cannot be negative/));
  check("a fractional string is not a bid", await throwsWith("12.5", /whole number/));
  check("NaN is not a bid", await throwsWith(Number.NaN, /finite/));
  check("none of those touched the counter", badKv.store.size === 0);
  check("a fractional NUMBER rounds UP to whole stroops (the bound errs toward spent)", (await chargeSponsorFee(0.5, TEN_K, NOW)).totalStroops === 1n);

  // A store outage degrades to the per-isolate counter: the same bound, a warning, and never a
  // refusal on availability. On another day, so nothing above is read as leftovers.
  installFakeKv({ fail: true });
  const outage1 = await chargeSponsorFee(6000, TEN_K, OTHER_DAY);
  check("store outage: the charge is served against the per-isolate counter", outage1.totalStroops === 6000n && !outage1.shared);
  let outageRefusal: unknown = null;
  try {
    await chargeSponsorFee(5000, TEN_K, OTHER_DAY);
  } catch (e) {
    outageRefusal = e;
  }
  check("and the same budget still bounds it: 11000 of 10000 is refused", isPublicRefusal(outageRefusal));
  const duringOutage = await readSponsorFeeDay(TEN_K, OTHER_DAY);
  check("while the store is unreadable the reading is honest: spent and used are null", duringOutage.spentStroops === null && duringOutage.used === null);
  clearKv();
  const localRead = await readSponsorFeeDay(TEN_K, OTHER_DAY);
  check("with no store configured the reading is the per-isolate counter, with the refused 5000 undone", localRead.spentStroops === 6000n);
  check("no store: a bid of exactly the rest is accepted", (await chargeSponsorFee(4000, TEN_K, OTHER_DAY)).totalStroops === 10_000n);
  check("no store: one more is refused", await (async () => { try { await chargeSponsorFee(1, TEN_K, OTHER_DAY); return false; } catch (e) { return isPublicRefusal(e); } })());

  /* THE PER-SENDER DAY CAP. The day cap is the sponsor's blast radius; this one is fairness inside
     it: one wallet, or one client looping on a bug, cannot take the whole day from everybody else.
     Reserved in the same pipeline as the day counter, released with it. */
  console.log("[13] per-sender day cap: one sender at the limit is refused while another is served");
  const SENDER_A = Keypair.random().publicKey();
  const SENDER_B = Keypair.random().publicKey();
  const SENDER_C = Keypair.random().publicKey();
  const CAPS_S: CapsConfig = { ...CAPS, maxDaySenderStroops: usdc(25) };
  const senderKv = installFakeKv();
  const dayTotal = () => (senderKv.store.get(dayKey(NOW)) as bigint | undefined) ?? 0n;
  const senderTotal = (pk: string) => (senderKv.store.get(senderDayKey(NOW, pk)) as bigint | undefined) ?? 0n;
  const a1 = await checkCaps(usdc(20), CAPS_S, NOW, SENDER_A);
  check("sender A's first 20 is reserved on both counters", a1.ok && dayTotal() === usdc(20) && senderTotal(SENDER_A) === usdc(20));
  check(
    "both counters moved in ONE pipeline (two INCRBY pairs, one round trip)",
    senderKv.pipelines.at(-1)!.filter((c) => c[0] === "INCRBY").length === 2,
  );
  check("A's 5 fills their 25 and is still allowed", (await checkCaps(usdc(5), CAPS_S, NOW, SENDER_A)).ok);
  const aOver = await checkCaps(usdc(1), CAPS_S, NOW, SENDER_A);
  check("A's next 1 USDC is refused by THEIR limit, with the day still open", !aOver.ok);
  check(
    "the refusal is one sentence that names the per-sender limit and says to try again",
    /per-sender limit of 25 USDC/.test(aOver.reason ?? "") && /try again tomorrow/.test(aOver.reason ?? "") && !/\n/.test(aOver.reason ?? ""),
    aOver.reason,
  );
  check("the refused attempt left both counters where they were", dayTotal() === usdc(25) && senderTotal(SENDER_A) === usdc(25));
  check("SENDER B IS SERVED while A is at the limit", (await checkCaps(usdc(20), CAPS_S, NOW, SENDER_B)).ok && dayTotal() === usdc(45));
  await a1.release!(); // A's first send failed on-chain
  check("release gives BOTH counters back", dayTotal() === usdc(25) && senderTotal(SENDER_A) === usdc(5));
  check("so A can send again inside their share", (await checkCaps(usdc(20), CAPS_S, NOW, SENDER_A)).ok && senderTotal(SENDER_A) === usdc(25));
  const cOver = await checkCaps(usdc(10), CAPS_S, NOW, SENDER_C);
  check("the day cap still binds a sender under their own limit (55 of 50)", !cOver.ok && /daily escrow cap/.test(cOver.reason ?? ""), cOver.reason);
  check("and that refusal gave both counters back too", dayTotal() === usdc(45) && senderTotal(SENDER_C) === 0n);
  const senderKeysBefore = [...senderKv.store.keys()].filter((k) => k.includes(":sender:")).length;
  check("without a sender only the day counter moves (the exit routes are not senders)", (await checkCaps(usdc(1), CAPS_S, NOW)).ok && [...senderKv.store.keys()].filter((k) => k.includes(":sender:")).length === senderKeysBefore);
  check(
    "the sender key is namespaced by network and day, inside the day namespace, never the day key itself",
    senderDayKey(NOW, SENDER_A, "mainnet") !== senderDayKey(NOW, SENDER_A, "testnet") &&
      senderDayKey(NOW, SENDER_A) !== senderDayKey(OTHER_DAY, SENDER_A) &&
      senderDayKey(NOW, SENDER_A) !== dayKey(NOW) &&
      senderDayKey(NOW, SENDER_A) === `caps:testnet:day:${NOW_DAY}:sender:${SENDER_A}`,
  );
  installFakeKv();
  const noSenderCap: CapsConfig = { ...CAPS };
  check(
    "a config without a per-sender number lets one sender use the whole day (the testnet shape)",
    (await checkCaps(usdc(20), noSenderCap, NOW, SENDER_A)).ok &&
      (await checkCaps(usdc(20), noSenderCap, NOW, SENDER_A)).ok &&
      (await checkCaps(usdc(10), noSenderCap, NOW, SENDER_A)).ok &&
      !(await checkCaps(usdc(1), noSenderCap, NOW, SENDER_A)).ok,
  );
  delete process.env.MAX_DAY_USDC;
  delete process.env.MAX_DAY_USDC_PER_SENDER;
  check("capsFromEnv: on testnet the per-sender default EQUALS the day cap", capsFromEnv("testnet").maxDaySenderStroops === capsFromEnv("testnet").maxDayStroops);
  check("on mainnet it defaults to 25 USDC", capsFromEnv("mainnet").maxDaySenderStroops === usdc(25));
  process.env.MAX_DAY_USDC = "50";
  process.env.MAX_DAY_USDC_PER_SENDER = "10";
  check("MAX_DAY_USDC_PER_SENDER overrides it", capsFromEnv("mainnet").maxDaySenderStroops === usdc(10));
  process.env.MAX_DAY_USDC_PER_SENDER = "999";
  check("a per-sender cap above the day is clamped to the day", capsFromEnv("mainnet").maxDaySenderStroops === usdc(50));
  process.env.MAX_DAY_USDC_PER_SENDER = "nonsense";
  check("a malformed value falls back to the default", capsFromEnv("mainnet").maxDaySenderStroops === usdc(25));
  process.env.MAX_DAY_USDC = "20";
  delete process.env.MAX_DAY_USDC_PER_SENDER;
  check("and the mainnet default is clamped when the day is smaller than 25", capsFromEnv("mainnet").maxDaySenderStroops === usdc(20));
  delete process.env.MAX_DAY_USDC;

  console.log("[14] readDayCounters: the two day counters as /health reads them, a GET pipeline and never a write");
  delete process.env.MAX_DAY_ACCOUNTS;
  const readKv = installFakeKv();
  await checkCaps(usdc(20), CAPS, NOW);
  await checkCaps(usdc(5), CAPS, NOW);
  await checkOnboardingBudget(SHARED, IP_A, NOW);
  await checkOnboardingBudget(SHARED, IP_B, NOW);
  const writesBefore = readKv.pipelines.length;
  const counters = await readDayCounters(NOW);
  check(
    "reports the day, the escrow total in USDC, the accounts handed out, and the limits in force",
    counters.day === NOW_DAY && counters.escrowUsdc === "25" && counters.accounts === 2 && counters.maxDayUsdc === "1000" && counters.maxDayAccounts === 500,
    JSON.stringify(counters),
  );
  check("the reading was one pipeline of two GETs and nothing else", readKv.pipelines.length === writesBefore + 1 && readKv.pipelines.at(-1)!.every((c) => c[0] === "GET"));
  check("an untouched day reads as zero, not null", (await readDayCounters(OTHER_DAY)).escrowUsdc === "0" && (await readDayCounters(OTHER_DAY)).accounts === 0);
  installFakeKv({ fail: true });
  const unreadableCounters = await readDayCounters(NOW);
  check("an unreadable store reads as null counters with the limits still present", unreadableCounters.escrowUsdc === null && unreadableCounters.accounts === null && unreadableCounters.maxDayAccounts === 500);
  clearKv();
  check("no store configured: the same honest nulls", (await readDayCounters(NOW)).escrowUsdc === null);

  /* THE WIRING. The budget is only a ceiling if every route that pays a fee charges it BEFORE the
     signer is asked for anything. Measured the way the relay guard suite measures acceptance: a
     stub signer that throws a sentinel the moment it is asked to sign. A fee refusal must arrive
     BEFORE that sentinel, with the counter unchanged; an accepted charge must be in the counter when
     the sentinel fires, and stay there after the handler throws (a charge is never given back once
     the signature has been asked for). No handler here ever reaches Horizon. */
  console.log("[15] every Horizon route and both /create-account paths charge the fee budget before they sign");
  const sponsor = Keypair.random();
  const sender = Keypair.random();
  const issuer = Keypair.random();
  const bearer = Keypair.random();
  const exchange = Keypair.random();
  const home = Keypair.random();
  const throwaway = Keypair.random();
  const recipient = Keypair.random();
  const channel = Keypair.random();
  const USDC = new Asset("USDC", issuer.publicKey());
  const BALANCE_ID = "00000000" + "ab".repeat(32);
  const config = makeConfig({ network: "testnet", sponsorSecret: sponsor.secret(), usdcIssuer: issuer.publicKey() });
  const SENTINEL = "stub-signer: the route reached the signature";
  const todayFeeKey = feeDayKey(Date.now());
  /** The store the stub reads when it is asked to sign, and what the fee counter held at that moment. */
  let storeAtSign: Map<string, bigint | string> | null = null;
  const atSign: Array<bigint | string | undefined> = [];
  const stubSigner: SponsorSigner = {
    publicKey: () => sponsor.publicKey(),
    sign: (_tx: Transaction | FeeBumpTransaction) => {
      atSign.push(storeAtSign?.get(todayFeeKey));
      throw new Error(SENTINEL);
    },
  };
  const noHorizon = {} as unknown as Horizon.Server;
  const buildTx = (sourcePub: string, ops: xdr.Operation[]): Transaction => {
    const b = new TransactionBuilder(new Account(sourcePub, "123456789"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET });
    for (const op of ops) b.addOperation(op);
    return b.setTimeout(180).build();
  };
  const claimXdr = buildTx(recipient.publicKey(), [Operation.claimClaimableBalance({ balanceId: BALANCE_ID })]).toXDR();
  const sendXdr = buildTx(sender.publicKey(), [
    Operation.beginSponsoringFutureReserves({ sponsoredId: sender.publicKey(), source: sponsor.publicKey() }),
    Operation.createClaimableBalance({
      asset: USDC,
      amount: "20",
      claimants: [
        new Claimant(bearer.publicKey(), Claimant.predicateUnconditional()),
        new Claimant(sender.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeRelativeTime("604800"))),
      ],
      source: sender.publicKey(),
    }),
    Operation.endSponsoringFutureReserves({ source: sender.publicKey() }),
  ]).toXDR();
  const payoutXdr = buildTx(sender.publicKey(), [
    Operation.payment({ destination: exchange.publicKey(), asset: USDC, amount: "5", source: sender.publicKey() }),
  ]).toXDR();
  const sweepXdr = buildTx(throwaway.publicKey(), [
    Operation.payment({ destination: home.publicKey(), asset: USDC, amount: "3", source: throwaway.publicKey() }),
    Operation.changeTrust({ asset: USDC, limit: "0", source: throwaway.publicKey() }),
    Operation.accountMerge({ destination: home.publicKey(), source: throwaway.publicKey() }),
  ]).toXDR();
  /** Horizon as /create-account sees it: the recipient does not exist (404), everyone else does. */
  const horizonFor = (seen: string[]) =>
    ({
      loadAccount: async (pub: string) => {
        seen.push(pub);
        if (pub === recipient.publicKey()) throw { response: { status: 404 } };
        return new Account(pub, "7");
      },
    }) as unknown as Horizon.Server;
  const routes: Array<{ name: string; bid: bigint; run: () => Promise<unknown> }> = [
    { name: "/feebump", bid: 2000n, run: () => feebumpHandler(noHorizon, config, stubSigner, { xdr: claimXdr, recipientPublicKey: recipient.publicKey(), balanceId: BALANCE_ID }) },
    { name: "/send-link", bid: 4000n, run: () => sendLinkHandler(noHorizon, config, stubSigner, { xdr: sendXdr, senderPublicKey: sender.publicKey() }) },
    { name: "/payout", bid: 2000n, run: () => payoutHandler(noHorizon, config, stubSigner, { xdr: payoutXdr, senderPublicKey: sender.publicKey(), destination: exchange.publicKey(), amount: "5" }) },
    { name: "/sweep", bid: 4000n, run: () => sweepHandler(noHorizon, config, stubSigner, { xdr: sweepXdr, throwawayPublicKey: throwaway.publicKey(), homePublicKey: home.publicKey(), amount: "3" }) },
    { name: "/create-account (sponsor path)", bid: 400n, run: () => createAccountHandler(horizonFor([]), config, stubSigner, { recipientPublicKey: recipient.publicKey() }) },
  ];
  const outcome = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
      return "returned";
    } catch (e) {
      const m = (e as Error).message;
      if (m === SENTINEL) return "signed";
      if (isPublicRefusal(e) && m === FEE_BUDGET_REFUSAL) return "fee-refused";
      return `other: ${m}`;
    }
  };
  delete process.env.STELLAR_NETWORK;
  delete process.env.MAX_DAY_FEE_XLM;
  delete process.env.CAPS_FAIL_CLOSED;
  delete process.env.MIN_DROP_USDC;
  delete process.env.MAX_DROP_USDC;
  delete process.env.MAX_DAY_USDC;
  delete process.env.MAX_DAY_USDC_PER_SENDER;
  const testnetBudget = feeBudgetFromEnv("testnet").maxDayFeeStroops;
  for (const route of routes) {
    // Budget spent: the refusal arrives before the sentinel and the counter does not move.
    const spentKv = installFakeKv();
    spentKv.store.set(todayFeeKey, testnetBudget);
    const refused = await outcome(route.run);
    check(`${route.name}: with the day's budget spent, refused BEFORE the signer is touched`, refused === "fee-refused", refused);
    check(`${route.name}: the counter is unchanged by the refusal`, spentKv.store.get(todayFeeKey) === testnetBudget);
    // Budget open: the charge is in the counter when the signer is asked. The stub signer then
    // throws, so nothing was signed, and the charge comes back (a KMS outage spends nothing).
    const openKv = installFakeKv();
    storeAtSign = openKv.store;
    atSign.length = 0;
    const signed = await outcome(route.run);
    check(`${route.name}: with budget, the bid is charged and THEN the signer is asked`, signed === "signed", signed);
    check(`${route.name}: the bid (${route.bid} stroops) is in the day's counter when the signer is asked`, atSign[0] === route.bid, `${atSign.join("/")}`);
    check(`${route.name}: the signer threw, nothing was signed, so the bid came back`, (openKv.store.get(todayFeeKey) ?? 0n) === 0n, `${openKv.store.get(todayFeeKey)}`);
  }
  storeAtSign = null;
  // /send-link also reserves escrow: a fee refusal is a pre-submit fault, so that reservation goes back.
  const sendKv = installFakeKv();
  sendKv.store.set(todayFeeKey, testnetBudget);
  await outcome(routes[1]!.run);
  check("/send-link: a fee refusal gives the escrow reservation back (day counter at 0)", (sendKv.store.get(dayKey(Date.now())) ?? 0n) === 0n && (sendKv.store.get(senderDayKey(Date.now(), sender.publicKey())) ?? 0n) === 0n);
  const sendOpenKv = installFakeKv();
  await outcome(routes[1]!.run);
  check(
    "/send-link: a signer failure after the charge gives back the escrow AND the fee (nothing was signed or posted)",
    (sendOpenKv.store.get(dayKey(Date.now())) ?? 0n) === 0n && (sendOpenKv.store.get(todayFeeKey) ?? 0n) === 0n,
  );
  // A transaction the guard refuses never reaches the charge: the counter stays empty.
  const guardKv = installFakeKv();
  const badClaim = await outcome(() => feebumpHandler(noHorizon, config, stubSigner, { xdr: claimXdr, recipientPublicKey: recipient.publicKey(), balanceId: "00000000" + "cd".repeat(32) }));
  check("a transaction the anti-drain guard refuses is never charged", /other: anti-drain/.test(badClaim) && !guardKv.store.has(todayFeeKey), badClaim);
  // The channel path: charged before ANY signature; a refusal is a refusal, not a channel fault.
  const seen: string[] = [];
  let leaseReleases = 0;
  const channels = {
    enabled: true,
    lease: async () => ({ publicKey: channel.publicKey(), keypair: channel, release: async () => void leaseReleases++ }),
  } as unknown as ChannelManager;
  const chanKv = installFakeKv();
  chanKv.store.set(todayFeeKey, testnetBudget);
  const chanRefused = await outcome(() => createAccountHandler(horizonFor(seen), config, stubSigner, { recipientPublicKey: recipient.publicKey() }, channels));
  check("/create-account (channel path): refused before the channel or the sponsor signs", chanRefused === "fee-refused", chanRefused);
  check("the refusal released the lease exactly once and did NOT fall through to the sponsor path", leaseReleases === 1 && !seen.includes(sponsor.publicKey()), seen.map((k) => k.slice(0, 4)).join(","));
  /* With budget, the charge must already be in the counter when the CHANNEL path asks for the
     sponsor's signature. A signer failure there is a channel-path failure to the existing catch,
     which gives that sandwich's charge back (it never left the process) and falls back to the
     sponsor path, which charges ITS sandwich before ITS signature. Until 2026-10-08 the first
     charge stayed, and one onboarding was counted twice. */
  const chanOpenKv = installFakeKv();
  const feeAtSign: Array<bigint | string | undefined> = [];
  const recordingSigner: SponsorSigner = {
    publicKey: () => sponsor.publicKey(),
    sign: (_tx: Transaction | FeeBumpTransaction) => {
      feeAtSign.push(chanOpenKv.store.get(todayFeeKey));
      throw new Error(SENTINEL);
    },
  };
  const chanSigned = await outcome(() => createAccountHandler(horizonFor([]), config, recordingSigner, { recipientPublicKey: recipient.publicKey() }, channels));
  check(
    "/create-account (channel path): the sandwich fee is in the counter BEFORE the sponsor is asked to sign",
    chanSigned === "signed" && feeAtSign[0] === 400n,
    `${chanSigned}, ${feeAtSign.join("/")}`,
  );
  check(
    "a signer failure on the channel path gives that charge back before the sponsor path charges its own: one onboarding, counted once",
    feeAtSign.length === 2 && feeAtSign[1] === 400n && (chanOpenKv.store.get(todayFeeKey) ?? 0n) === 0n,
    `${feeAtSign.join("/")}, counter ${chanOpenKv.store.get(todayFeeKey)}`,
  );

  console.log("[16] the Horizon answer settles the charge: what reached a ledger counts what it was charged, nothing else");
  {
    const realSigner: SponsorSigner = {
      publicKey: () => sponsor.publicKey(),
      sign: (tx: Transaction | FeeBumpTransaction) => tx.sign(sponsor),
    };
    const result = (code: "txSuccess" | "txFailed" | "txBadSeq" | "innerBadSeq" | "innerFailed", fee: number) => {
      const top =
        code === "txSuccess"
          ? xdr.TransactionResultResult.txSuccess([])
          : code === "txFailed"
            ? xdr.TransactionResultResult.txFailed([])
            : code === "txBadSeq"
              ? xdr.TransactionResultResult.txBadSeq()
              : xdr.TransactionResultResult.txFeeBumpInnerFailed(
                  new xdr.InnerTransactionResultPair({
                    transactionHash: Buffer.alloc(32),
                    result: new xdr.InnerTransactionResult({
                      feeCharged: xdr.Int64.fromString(String(fee)),
                      result: code === "innerBadSeq" ? xdr.InnerTransactionResultResult.txBadSeq() : xdr.InnerTransactionResultResult.txFailed([]),
                      ext: new xdr.InnerTransactionResultExt(0),
                    }),
                  }),
                );
      return new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString(String(fee)), result: top, ext: new xdr.TransactionResultExt(0) }).toXDR("base64");
    };
    /**
     * A Horizon whose POST /transactions answers as given, and whose GET /transactions/<hash> answers
     * `lookup` (absent: the read throws, an undecided answer).
     */
    let lookups = 0;
    const horizonAnswering = (answer: () => unknown, lookup?: () => unknown) =>
      ({
        submitTransaction: async () => answer(),
        transactions: () => ({
          transaction: () => ({
            call: async () => {
              lookups++;
              if (!lookup) throw new Error("horizon unreachable");
              return lookup();
            },
          }),
        }),
      }) as unknown as Horizon.Server;
    const notFound = () => {
      throw Object.assign(new Error("Not Found"), { name: "NotFoundError", response: { status: 404 } });
    };
    /** A lookup that first reaches a Horizon instance still a ledger behind, then one that has it. */
    const lagging = () => {
      let n = 0;
      return () => (n++ === 0 ? notFound() : { fee_charged: "200" });
    };
    setLedgerRecheckMsForTests(1);
    const rejected = (status: number, resultXdr?: string) => () => {
      throw Object.assign(new Error(`Request failed with status code ${status}`), {
        response: { status, data: resultXdr ? { extras: { result_xdr: resultXdr, result_codes: { transaction: "x" } } } : {} },
      });
    };
    const claim = (h: Horizon.Server) =>
      feebumpHandler(h, config, realSigner, { xdr: claimXdr, recipientPublicKey: recipient.publicKey(), balanceId: BALANCE_ID });
    const cases: Array<{ name: string; answer: () => unknown; lookup?: () => unknown; counted: bigint; unconfirmed?: boolean }> = [
      { name: "SUCCESS: counted at the ledger's fee_charged (200 of the 2000 bid)", answer: () => ({ hash: "ab".repeat(32), ledger: 7, result_xdr: result("txSuccess", 200) }), counted: 200n },
      { name: "refused while validating (txBadSeq): the whole bid comes back", answer: rejected(400, result("txBadSeq", 100)), counted: 0n },
      { name: "a fee-bump whose INNER was refused while validating (inner txBadSeq): the whole bid comes back", answer: rejected(400, result("innerBadSeq", 200)), counted: 0n },
      { name: "txFailed and the ledger unreadable: counted at the result's fee, never below it", answer: rejected(400, result("txFailed", 300)), counted: 300n },
      { name: "a fee-bump whose inner FAILED, ledger unreadable: counted at the result's fee", answer: rejected(400, result("innerFailed", 250)), counted: 250n },
      { name: "txFailed that the ledger does NOT know (core refused a malformed op while validating): the whole bid comes back", answer: rejected(400, result("txFailed", 300)), lookup: notFound, counted: 0n },
      { name: "txFailed that the ledger DID include: counted at the ledger's fee_charged", answer: rejected(400, result("txFailed", 300)), lookup: () => ({ fee_charged: "200" }), counted: 200n },
      { name: "txFailed whose FIRST lookup 404s (an instance a ledger behind), the second finds it: counted at the ledger's fee", answer: rejected(400, result("txFailed", 300)), lookup: lagging(), counted: 200n },
      { name: "a Horizon 400 with no result at all (it never reached core): the whole bid comes back", answer: rejected(400), counted: 0n },
      { name: "a 504 (undecided): the whole bid stays, and the answer is an unconfirmed submit", answer: rejected(504), counted: 2000n, unconfirmed: true },
    ];
    for (const c of cases) {
      const kvH = installFakeKv();
      let unconfirmed = false;
      lookups = 0;
      try {
        await claim(horizonAnswering(c.answer, c.lookup));
      } catch (e) {
        unconfirmed = (e as { submitUnconfirmed?: boolean }).submitUnconfirmed === true;
      }
      check(`/feebump ${c.name}`, (kvH.store.get(todayFeeKey) ?? 0n) === c.counted && unconfirmed === (c.unconfirmed ?? false), `${kvH.store.get(todayFeeKey)}`);
      if (c.lookup === notFound) check("  and 'never included' took TWO 404s, one ledger apart, never one", lookups === 2, `${lookups} lookups`);
    }
    // The sweep junk of the review: a never-funded throwaway is refused while validating
    // (tx_no_source_account), so 25 junk posts leave nothing in the counter.
    const junkKv = installFakeKv();
    const noAccount = new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString("100"),
      result: xdr.TransactionResultResult.txFeeBumpInnerFailed(
        new xdr.InnerTransactionResultPair({
          transactionHash: Buffer.alloc(32),
          result: new xdr.InnerTransactionResult({ feeCharged: xdr.Int64.fromString("0"), result: xdr.InnerTransactionResultResult.txNoAccount(), ext: new xdr.InnerTransactionResultExt(0) }),
        }),
      ),
      ext: new xdr.TransactionResultExt(0),
    }).toXDR("base64");
    for (let i = 0; i < 25; i++) {
      await sweepHandler(horizonAnswering(rejected(400, noAccount)), config, realSigner, { xdr: sweepXdr, throwawayPublicKey: throwaway.publicKey(), homePublicKey: home.publicKey(), amount: "3" }).catch(() => {});
    }
    check("25 junk /sweep posts from a never-funded account leave the fee counter at 0 (was 100,000)", (junkKv.store.get(todayFeeKey) ?? 0n) === 0n, `${junkKv.store.get(todayFeeKey)}`);
    // The review's sweep junk: a sweep INTO ITSELF (and a zero payment) is malformed, refused by core
    // while validating with txFAILED; it never reaches the charge now, and nothing is counted.
    const selfKv = installFakeKv();
    const selfSweep = buildTx(throwaway.publicKey(), [
      Operation.payment({ destination: throwaway.publicKey(), asset: USDC, amount: "3", source: throwaway.publicKey() }),
      Operation.changeTrust({ asset: USDC, limit: "0", source: throwaway.publicKey() }),
      Operation.accountMerge({ destination: throwaway.publicKey(), source: throwaway.publicKey() }),
    ]).toXDR();
    const intoSelf = await outcome(() => sweepHandler(horizonAnswering(rejected(400, result("txFailed", 400))), config, realSigner, { xdr: selfSweep, throwawayPublicKey: throwaway.publicKey(), homePublicKey: throwaway.publicKey(), amount: "3" }));
    check("a sweep into itself is refused by the validator before any charge", /home must differ from the throwaway/.test(intoSelf) && !selfKv.store.has(todayFeeKey), intoSelf);
    const zeroSweep = buildTx(throwaway.publicKey(), [
      Operation.payment({ destination: home.publicKey(), asset: USDC, amount: "0.0000001", source: throwaway.publicKey() }),
      Operation.changeTrust({ asset: USDC, limit: "0", source: throwaway.publicKey() }),
      Operation.accountMerge({ destination: home.publicKey(), source: throwaway.publicKey() }),
    ]).toXDR();
    const zero = await outcome(() => sweepHandler(horizonAnswering(rejected(400, result("txFailed", 400))), config, realSigner, { xdr: zeroSweep, throwawayPublicKey: throwaway.publicKey(), homePublicKey: home.publicKey(), amount: "0" }));
    check("a sweep declaring a zero amount is refused before any charge", /amount 0.0000001 != expected 0|must be positive/.test(zero) && !selfKv.store.has(todayFeeKey), zero);
  }
  {
    /* A CLASSIC inner that declares Soroban resources: the SDK adds any declared fee to the fee-bump
       (base x (ops + 1) + R) and the anti-drain policy never reads that field, so a claim declaring
       14 XLM had the sponsor bid 140,002,000 stroops (a review did). Every classic route now refuses
       a bid other than its own nominal one, before the charge and the signature; a negative R too. */
    const declaringR = (xdrStr: string, r: number): string => {
      const env = xdr.TransactionEnvelope.fromXDR(xdrStr, "base64");
      env.v1().tx().ext(new xdr.TransactionExt(1, new SorobanDataBuilder().setResourceFee(r).build()));
      return env.toXDR("base64");
    };
    for (const r of [140_000_000, -1_000]) {
      const routes: Array<{ name: string; run: (signer: SponsorSigner) => Promise<unknown> }> = [
        { name: "/feebump", run: (s) => feebumpHandler(noHorizon, config, s, { xdr: declaringR(claimXdr, r), recipientPublicKey: recipient.publicKey(), balanceId: BALANCE_ID }) },
        { name: "/payout", run: (s) => payoutHandler(noHorizon, config, s, { xdr: declaringR(payoutXdr, r), senderPublicKey: sender.publicKey(), destination: exchange.publicKey(), amount: "5" }) },
        { name: "/sweep", run: (s) => sweepHandler(noHorizon, config, s, { xdr: declaringR(sweepXdr, r), throwawayPublicKey: throwaway.publicKey(), homePublicKey: home.publicKey(), amount: "3" }) },
      ];
      for (const route of routes) {
        const rKv = installFakeKv();
        let signed = 0;
        const counting: SponsorSigner = { publicKey: () => sponsor.publicKey(), sign: () => void signed++ };
        const msg = await outcome(() => route.run(counting) as Promise<never>);
        check(
          `${route.name}: an inner declaring R = ${r} is refused before the charge (no bid counted, nothing signed)`,
          // A negative R can also be refused by the SDK's own minimum while the fee-bump is built.
          /differs from the \d+ this route bids|Invalid baseFee/.test(msg) && !rKv.store.has(todayFeeKey) && signed === 0,
          msg.slice(0, 120),
        );
      }
    }
  }

  console.log("[17] the sponsor's SIGNING address is sponsor-controlled too, once it differs from the account");
  {
    // After the KMS cutover the signer is a separate key added to the account: its address is public
    // (on /health and in the signer list), and a sponsor signature over an op it sources authorizes it.
    const kmsKey = Keypair.random();
    const split = makeConfig({ network: "testnet", sponsorSecret: sponsor.secret(), sponsorAccountId: sponsor.publicKey(), usdcIssuer: issuer.publicKey() });
    const kmsSigner: SponsorSigner = { publicKey: () => kmsKey.publicKey(), sign: (_tx: Transaction | FeeBumpTransaction) => { throw new Error(SENTINEL); } };
    installFakeKv();
    const asRecipient = await outcome(() => createAccountHandler(horizonFor([]), split, kmsSigner, { recipientPublicKey: kmsKey.publicKey() }));
    check("/create-account refuses the signing key's address as the recipient", /recipient must differ from the sponsor/.test(asRecipient), asRecipient);
    const kmsSend = buildTx(kmsKey.publicKey(), [
      Operation.beginSponsoringFutureReserves({ sponsoredId: kmsKey.publicKey(), source: sponsor.publicKey() }),
      Operation.createClaimableBalance({
        asset: USDC,
        amount: "1",
        claimants: [
          new Claimant(bearer.publicKey(), Claimant.predicateUnconditional()),
          new Claimant(kmsKey.publicKey(), Claimant.predicateNot(Claimant.predicateBeforeRelativeTime("604800"))),
        ],
        source: kmsKey.publicKey(),
      }),
      Operation.endSponsoringFutureReserves({ source: kmsKey.publicKey() }),
    ]).toXDR();
    const asSender = await outcome(() => sendLinkHandler(noHorizon, split, kmsSigner, { xdr: kmsSend, senderPublicKey: kmsKey.publicKey() }));
    check("/send-link refuses the signing key's address as the sender (it would move USDC held there)", /sponsor's signing key/.test(asSender), asSender);
    const kmsPayout = buildTx(kmsKey.publicKey(), [Operation.payment({ destination: exchange.publicKey(), asset: USDC, amount: "5", source: kmsKey.publicKey() })]).toXDR();
    const asPayer = await outcome(() => payoutHandler(noHorizon, split, kmsSigner, { xdr: kmsPayout, senderPublicKey: kmsKey.publicKey(), destination: exchange.publicKey(), amount: "5" }));
    check("/payout refuses it as the sender", /sponsor's signing key/.test(asPayer), asPayer);
    const kmsSweep = buildTx(kmsKey.publicKey(), [
      Operation.payment({ destination: home.publicKey(), asset: USDC, amount: "3", source: kmsKey.publicKey() }),
      Operation.changeTrust({ asset: USDC, limit: "0", source: kmsKey.publicKey() }),
      Operation.accountMerge({ destination: home.publicKey(), source: kmsKey.publicKey() }),
    ]).toXDR();
    const asThrowaway = await outcome(() => sweepHandler(noHorizon, split, kmsSigner, { xdr: kmsSweep, throwawayPublicKey: kmsKey.publicKey(), homePublicKey: home.publicKey(), amount: "3" }));
    check("/sweep refuses it as the throwaway", /sponsor's signing key/.test(asThrowaway), asThrowaway);
    const kmsClaim = buildTx(kmsKey.publicKey(), [Operation.claimClaimableBalance({ balanceId: BALANCE_ID })]).toXDR();
    const asClaimer = await outcome(() => feebumpHandler(noHorizon, split, kmsSigner, { xdr: kmsClaim, recipientPublicKey: kmsKey.publicKey(), balanceId: BALANCE_ID }));
    check("/feebump refuses it as the recipient", /sponsor's signing key/.test(asClaimer), asClaimer);
    // Before the cutover the signer IS the account, and nothing changes for an ordinary sender.
    const ordinary = await outcome(() => sendLinkHandler(noHorizon, split, kmsSigner, { xdr: sendXdr, senderPublicKey: sender.publicKey() }));
    check("an ordinary sender is unaffected by the split (reaches the signature)", ordinary === "signed", ordinary);
  }
  clearKv();

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ CANARY CAP TESTS PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
