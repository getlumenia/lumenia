/**
 * WATCHDOG SMOKE TEST: runs every check against the LIVE testnet sponsor + escrow and prints what
 * it found. It asserts the watchdog is WIRED and reads real data; it does not assert an empty alert
 * list, because a real alert (e.g. a low float) is a true finding, not a failure.
 *
 * READ-ONLY. It calls runWatchdog without `autoHalt` and `heartbeat`, so it writes no halt key, no
 * heartbeat stamp, no scan cursor, no wasm baseline and no alert cooldown, and sends no email, even
 * from a shell that holds the production store's KV_REST_API_* variables: it records every request
 * to that store and fails if one of them was a write. Before D3 round 2 the same command could halt
 * a live sponsor, and advance the Worker's scan past an operation the Worker had not seen. The
 * de-duplication assertions run against a private in-memory store, never the configured one; only
 * the live reads need a network. The halt itself is proven offline (test:watchdog-offline).
 *
 * RUN: SPONSOR_SECRET=S... pnpm --filter @lumenia/sponsor test:watchdog
 *      SPONSOR_ACCOUNT_ID=G... when the account is not the secret's own address (after the KMS
 *      cutover); LUMENDROP_CONTRACT=C... to read another escrow than the live testnet one.
 */
import { makeConfig, USDC_ISSUERS } from "./lib/config.js";
import { alertingStatus, markAlerted, runWatchdog, withoutRepeats, type Alert } from "./lib/watchdog.js";

/** The live testnet escrow, as in wrangler.toml [vars]; the old default here was the archived exit-only one. */
const TESTNET_ESCROW = "CAMCI5VPRLQUL6H4QKLZ6X7ASLVCEYBYWS7N3QG7JVOA25HCY2TN3HP3";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

/* Every request to the configured store is recorded, so the run can prove it wrote nothing there. */
const realFetch = globalThis.fetch;
const configuredStore = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const storeHost = configuredStore ? new URL(configuredStore).host : null;
const storeWrites: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (storeHost && new URL(url).host === storeHost) {
    const body = typeof init?.body === "string" ? init.body : "";
    if (/\/(set|del|incr|incrby|decr|expire)\//i.test(url) || /"(SET|DEL|INCR|INCRBY|DECR|EXPIRE)"/i.test(body)) {
      storeWrites.push(url.replace(/^https?:\/\/[^/]+/, ""));
    }
  }
  return realFetch(input, init);
}) as typeof fetch;

/** Run `fn` against a throwaway in-memory store (plain GET and SET), so its writes reach nothing real. */
async function withPrivateStore<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN };
  const outer = globalThis.fetch;
  const memory = new Map<string, string>();
  const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  process.env.KV_REST_API_URL = "https://private-store.invalid";
  process.env.KV_REST_API_TOKEN = "local";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://private-store.invalid/")) return outer(input, init);
    const path = url.slice("https://private-store.invalid".length);
    const get = path.match(/^\/get\/(.+)$/);
    if (get) return reply({ result: memory.get(decodeURIComponent(get[1]!)) ?? null });
    const set = path.match(/^\/set\/([^/]+)\/(.*)$/);
    if (set) {
      memory.set(decodeURIComponent(set[1]!), decodeURIComponent(set[2]!));
      return reply({ result: "OK" });
    }
    return new Response("unsupported in the private store", { status: 400 });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = outer;
    for (const [name, value] of [
      ["KV_REST_API_URL", saved.url],
      ["KV_REST_API_TOKEN", saved.token],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function main() {
  console.log("============================================================");
  console.log(" WATCHDOG SMOKE TEST (live testnet reads, writes nothing)");
  console.log("============================================================\n");

  const config = makeConfig({
    network: "testnet",
    sponsorSecret: need("SPONSOR_SECRET"),
    sponsorAccountId: process.env.SPONSOR_ACCOUNT_ID,
    usdcIssuer: USDC_ISSUERS.testnet,
    lumendropContract: process.env.LUMENDROP_CONTRACT ?? TESTNET_ESCROW,
  });

  // No options: read-only. The scan reads the sponsor ACCOUNT, which after the KMS cutover is not the signer.
  const report = await runWatchdog(config, config.sponsorAccountId);
  check("the sponsor-account check ran", report.checked.includes("sponsor-account"));
  check("the escrow-governance check ran", report.checked.includes("escrow-governance"));
  check(
    "no check crashed (a crashed check reports itself as a page)",
    !report.alerts.some((a) => a.title.startsWith("Watchdog check failed")),
    report.alerts.filter((a) => a.title.startsWith("Watchdog check failed")).map((a) => a.detail).join("; "),
  );
  check("read-only: nothing was halted", !report.autoHalted);
  check("read-only: no heartbeat stamp was written", report.lastRun === null && report.lastFullRun === null);

  /* Alert de-duplication: the thing standing between a persistent condition and four identical
   * emails an hour. Against a private store, so it can never reset or stamp a real cooldown. */
  await withPrivateStore(async () => {
    const title = `Test alert ${Date.now()}`;
    const one: Alert[] = [{ severity: "page", title, detail: "first" }];
    check("a new alert is due", (await withoutRepeats(one, "testnet")).length === 1, "the first occurrence was suppressed");
    await markAlerted(one, "testnet"); // what a run does once Resend has accepted the email
    check(
      "the same alert is suppressed inside the cooldown",
      (await withoutRepeats([{ severity: "page", title, detail: "different numbers, same problem" }], "testnet")).length === 0,
      "a repeat got through: the inbox would be flooded every 15 minutes",
    );
    // Clearing: a run where the condition is gone must reset the clock, so its return pages at once.
    await withoutRepeats([], "testnet");
    check(
      "an alert that cleared and came back is sent again",
      (await withoutRepeats([{ severity: "page", title, detail: "it is back" }], "testnet")).length === 1,
      "a recurrence was swallowed by a stale cooldown",
    );
  });
  /* The title IS the cooldown key, so a number inside one mints a fresh key every time that
   * number moves, and the condition re-emails on every run instead of once. */
  check(
    "no alert title carries a changing number",
    report.alerts.every((a) => !/\d/.test(a.title)),
    report.alerts.filter((a) => /\d/.test(a.title)).map((a) => a.title).join("; "),
  );

  /* Delivery. A watchdog with no keys is silent for the same reason a healthy one is, so it has
   * to say which it is: on the report, and loudly enough for an operator to trip over. */
  check("the run reports whether a page can reach a human", typeof report.alerting?.configured === "boolean");
  check(
    "an undeliverable watchdog says so in its own alerts",
    report.alerting?.configured === true ||
      report.alerts.some((a) => a.title === "Watchdog cannot deliver alerts"),
    "alerting is unconfigured and nothing on the report admits it",
  );
  const saved = {
    key: process.env.RESEND_API_KEY,
    to: process.env.ALERT_NOTIFY_TO,
    fallback: process.env.FEEDBACK_NOTIFY_TO,
  };
  try {
    delete process.env.RESEND_API_KEY;
    delete process.env.ALERT_NOTIFY_TO;
    delete process.env.FEEDBACK_NOTIFY_TO;
    const missing = alertingStatus();
    check(
      "missing delivery keys are named, not just counted",
      !missing.configured && missing.missing.length === 2,
      missing.missing.join(", "),
    );
    process.env.FEEDBACK_NOTIFY_TO = "ops@example.com";
    check("the feedback address stands in for a missing alert address", alertingStatus().missing.length === 1);
    process.env.RESEND_API_KEY = "re_not_a_real_key";
    check("both keys present means configured", alertingStatus().configured);
  } finally {
    for (const [name, value] of [
      ["RESEND_API_KEY", saved.key],
      ["ALERT_NOTIFY_TO", saved.to],
      ["FEEDBACK_NOTIFY_TO", saved.fallback],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  check(
    `nothing was written to the configured store${storeHost ? ` (${storeHost})` : " (none configured)"}`,
    storeWrites.length === 0,
    storeWrites.join(" | "),
  );

  console.log(`\n  findings: ${report.alerts.length === 0 ? "none" : ""}`);
  for (const a of report.alerts) console.log(`    [${a.severity}] ${a.title}: ${a.detail}`);

  console.log("\n============================================================");
  console.log(fail === 0 ? ` WATCHDOG SMOKE TEST PASS (${pass}/${pass})` : ` FAIL: ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("CRASH:", e?.message ?? e);
  process.exit(1);
});
