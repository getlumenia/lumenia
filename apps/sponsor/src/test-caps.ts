/**
 * CANARY CAP TESTS — the per-drop and per-day escrow ceilings, plus the onboarding reserve
 * budget (offline; a fake KV store stands in for Upstash, so this runs with no network and
 * no secrets).
 *
 * RUN: pnpm --filter @lumenia/sponsor test:caps
 */
import {
  accountDayKey,
  accountSourceDayKey,
  capsFromEnv,
  checkCaps,
  checkOnboardingBudget,
  dayKey,
  onboardingBudgetFromEnv,
  stroopsToUsdc,
  USDC_STROOPS,
  type CapsConfig,
  type CapVerdict,
  type OnboardingBudget,
} from "./lib/caps.js";

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};
const usdc = (n: number) => BigInt(Math.round(n * Number(USDC_STROOPS)));

/**
 * An in-memory stand-in for the Upstash REST pipeline the caps module talks to.
 *
 * It answers EVERY command in the pipeline, in order, the way Upstash does — including the EXPIRE
 * that follows each INCRBY. A stand-in that replied to the first command only would read a
 * two-counter pipeline's second total off the wrong index and never notice.
 */
function installFakeKv(opts: { fail?: boolean } = {}) {
  const store = new Map<string, bigint>();
  const calls: string[] = [];
  process.env.KV_REST_API_URL = "https://fake-kv.test";
  process.env.KV_REST_API_TOKEN = "t";
  globalThis.fetch = (async (url: string | URL, init?: { body?: string }) => {
    calls.push(String(url));
    if (opts.fail) return { ok: false, status: 500, json: async () => [] } as unknown as Response;
    const cmds = JSON.parse(String(init?.body ?? "[]")) as string[][];
    const results = cmds.map(([op, key, arg]) => {
      if (op === "EXPIRE") return { result: 1 };
      if (op !== "INCRBY") throw new Error(`unexpected command ${op}`);
      const next = (store.get(key!) ?? 0n) + BigInt(arg!);
      store.set(key!, next);
      return { result: next.toString() };
    });
    return { ok: true, status: 200, json: async () => results } as unknown as Response;
  }) as typeof fetch;
  return { store, calls };
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
    stroopsToUsdc(kv.store.get(dayKey(Date.now())) ?? 0n) + " USDC counted",
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

  console.log("[11] onboarding budget — configuration");
  delete process.env.MAX_DAY_ACCOUNTS;
  delete process.env.MAX_DAY_ACCOUNTS_PER_SOURCE;
  delete process.env.CAPS_FAIL_CLOSED;
  delete process.env.STELLAR_NETWORK;
  const budgetDefaults = onboardingBudgetFromEnv();
  check("default budget is 500 accounts a day", budgetDefaults.maxDayAccounts === 500);
  check("one caller's default share is a fifth of it", budgetDefaults.maxDaySourceAccounts === 100);
  check("testnet is fail-open", !budgetDefaults.failClosed);
  process.env.STELLAR_NETWORK = "mainnet";
  check("mainnet is fail-closed WITHOUT CAPS_FAIL_CLOSED being set", onboardingBudgetFromEnv().failClosed);
  delete process.env.STELLAR_NETWORK;
  process.env.CAPS_FAIL_CLOSED = "1";
  check("CAPS_FAIL_CLOSED=1 flips it on testnet too", onboardingBudgetFromEnv().failClosed);
  delete process.env.CAPS_FAIL_CLOSED;
  process.env.MAX_DAY_ACCOUNTS = "40";
  check("MAX_DAY_ACCOUNTS overrides the default", onboardingBudgetFromEnv().maxDayAccounts === 40);
  check("the per-source share follows it down", onboardingBudgetFromEnv().maxDaySourceAccounts === 20);
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

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ CANARY CAP TESTS PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
