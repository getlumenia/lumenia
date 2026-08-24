/**
 * WATCHDOG SMOKE TEST — runs every check against the LIVE testnet sponsor + escrow and prints
 * what it found. It asserts the watchdog is WIRED and reads real data; it does not assert an
 * empty alert list, because a real alert (e.g. a low float) is a true finding, not a failure.
 *
 * RUN: SPONSOR_SECRET=S… pnpm --filter @lumenia/sponsor test:watchdog
 */
import { makeConfig } from "./lib/config.js";
import { signerFromSecret } from "./lib/signer.js";
import { runWatchdog, withoutRepeats, type Alert } from "./lib/watchdog.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

async function main() {
  console.log("============================================================");
  console.log(" WATCHDOG SMOKE TEST (live testnet reads)");
  console.log("============================================================\n");

  const config = makeConfig({
    network: "testnet",
    sponsorSecret: need("SPONSOR_SECRET"),
    usdcIssuer: "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC",
    lumendropContract:
      process.env.LUMENDROP_CONTRACT ?? "CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S",
  });
  const signer = signerFromSecret(config.sponsorSecret);

  const report = await runWatchdog(config, signer.publicKey());
  check("the sponsor-account check ran", report.checked.includes("sponsor-account"));
  check("the escrow-governance check ran", report.checked.includes("escrow-governance"));
  check(
    "no check crashed (a crashed check reports itself as an info alert)",
    !report.alerts.some((a) => a.title.startsWith("Watchdog check failed")),
    report.alerts.filter((a) => a.title.startsWith("Watchdog check failed")).map((a) => a.detail).join("; "),
  );
  /* Alert de-duplication — the thing standing between a persistent condition and four
   * identical emails an hour. Uses a throwaway title so it never collides with a real alert's
   * cooldown key in the shared store. */
  const title = `Test alert ${Date.now()}`;
  const one: Alert[] = [{ severity: "page", title, detail: "first" }];
  check("a new alert is sent", (await withoutRepeats(one)).length === 1, "the first occurrence was suppressed");
  check(
    "the same alert is suppressed inside the cooldown",
    (await withoutRepeats([{ severity: "page", title, detail: "different numbers, same problem" }])).length === 0,
    "a repeat got through — the inbox would be flooded every 15 minutes",
  );
  // Clearing: a run where the condition is gone must reset the clock, so its return pages at once.
  await withoutRepeats([]);
  check(
    "an alert that cleared and came back is sent again",
    (await withoutRepeats([{ severity: "page", title, detail: "it is back" }])).length === 1,
    "a recurrence was swallowed by a stale cooldown",
  );

  console.log(`\n  findings: ${report.alerts.length === 0 ? "none" : ""}`);
  for (const a of report.alerts) console.log(`    [${a.severity}] ${a.title} — ${a.detail}`);

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ WATCHDOG SMOKE TEST PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("💥", e?.message ?? e);
  process.exit(1);
});
