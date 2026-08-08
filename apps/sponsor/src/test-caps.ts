/**
 * CANARY CAP TESTS — the per-drop and per-day escrow ceilings (offline; a fake KV store
 * stands in for Upstash, so this runs with no network and no secrets).
 *
 * RUN: pnpm --filter @lumenia/sponsor test:caps
 */
import {
  capsFromEnv,
  checkCaps,
  dayKey,
  stroopsToUsdc,
  USDC_STROOPS,
  type CapsConfig,
} from "./lib/caps.js";

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};
const usdc = (n: number) => BigInt(Math.round(n * Number(USDC_STROOPS)));

/** An in-memory stand-in for the Upstash REST pipeline the caps module talks to. */
function installFakeKv(opts: { fail?: boolean } = {}) {
  const store = new Map<string, bigint>();
  const calls: string[] = [];
  process.env.KV_REST_API_URL = "https://fake-kv.test";
  process.env.KV_REST_API_TOKEN = "t";
  globalThis.fetch = (async (url: string | URL, init?: { body?: string }) => {
    calls.push(String(url));
    if (opts.fail) return { ok: false, status: 500, json: async () => [] } as unknown as Response;
    const cmds = JSON.parse(String(init?.body ?? "[]")) as string[][];
    const [op, key, arg] = cmds[0]!;
    if (op !== "INCRBY") throw new Error(`unexpected command ${op}`);
    const next = (store.get(key!) ?? 0n) + BigInt(arg!);
    store.set(key!, next);
    return { ok: true, status: 200, json: async () => [{ result: next.toString() }] } as unknown as Response;
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

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ CANARY CAP TESTS PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
