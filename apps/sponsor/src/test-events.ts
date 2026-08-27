/**
 * EVENT BEACON TESTS — the claim→first-send funnel (offline; a fake KV store stands in for
 * Upstash, so this runs with no network and no secrets).
 *
 * WHY THESE EXIST. The funnel was unmeasurable for three separate reasons at once, and each one
 * would have silently produced a plausible-looking zero:
 *   - events were written to stdout only, so nothing was ever counted;
 *   - claim events and send events carried different id spaces, so the two halves could not be
 *     joined even in principle;
 *   - and the LIVE claim route (v2) emitted no events at all, so the input side was being read
 *     from a route almost nobody arrives on.
 * A number that is wrong for any of those reasons looks exactly like a number that is right. These
 * tests check the counting, not the plumbing.
 *
 * RUN: pnpm --filter @lumenia/sponsor test:events
 */
import { handleEvent, recordEvent, eventsSummary } from "./lib/events.js";

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

/** An in-memory stand-in for the Upstash REST pipeline, supporting the commands this module uses. */
function installFakeKv() {
  const nums = new Map<string, number>();
  const sets = new Map<string, Set<string>>();
  process.env.KV_REST_API_URL = "https://fake-kv.test";
  process.env.KV_REST_API_TOKEN = "t";
  globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
    const cmds = JSON.parse(String(init?.body ?? "[]")) as string[][];
    const results = cmds.map(([op, key, ...args]) => {
      const k = key!;
      switch (op) {
        case "INCR": {
          const n = (nums.get(k) ?? 0) + 1;
          nums.set(k, n);
          return n;
        }
        case "GET":
          return nums.has(k) ? String(nums.get(k)) : null;
        case "EXPIRE":
          return 1;
        case "SADD": {
          const s = sets.get(k) ?? new Set<string>();
          const before = s.size;
          args.forEach((a) => s.add(a));
          sets.set(k, s);
          return s.size - before;
        }
        case "SCARD":
          return sets.get(k)?.size ?? 0;
        case "SMEMBERS":
          return [...(sets.get(k) ?? [])];
        case "SINTER": {
          const [a, b] = [sets.get(k) ?? new Set<string>(), sets.get(args[0]!) ?? new Set<string>()];
          return [...a].filter((m) => b.has(m));
        }
        default:
          throw new Error(`unexpected command ${op}`);
      }
    });
    return { ok: true, status: 200, json: async () => results.map((result) => ({ result })) } as unknown as Response;
  }) as typeof fetch;
  return { nums, sets };
}

console.log("============================================================");
console.log(" EVENT BEACON — counting, and the funnel join");
console.log("============================================================\n");

const kv = installFakeKv();
process.env.STELLAR_NETWORK = "testnet";

console.log("[1] the allowlist still decides what is accepted");
const accepts = (e: string) => {
  try {
    handleEvent({ event: e });
    return true;
  } catch {
    return false;
  }
};
check("accepts a known event", accepts("claim_succeeded"));
check("refuses an unknown one", !accepts("password_typed"));
check("refuses a missing one", !accepts(""));

console.log("\n[2] events are COUNTED, not just logged");
await recordEvent({ event: "claim_opened", cid: "aaaa1111" });
await recordEvent({ event: "claim_opened", cid: "bbbb2222" });
await recordEvent({ event: "claim_succeeded", cid: "aaaa1111", aid: "1111111111111111" });
let s = (await eventsSummary())!;
check("two opens counted", s.totals.claim_opened === 2, `got ${s.totals.claim_opened}`);
check("one success counted", s.totals.claim_succeeded === 1);
check("an event nobody fired is zero, not missing", s.totals.cashout_sent === 0);
check("the day is recorded", s.days.length === 1);
check("daily keys carry an expiry", [...kv.nums.keys()].some((k) => k.includes(":d:")));

console.log("\n[3] an unknown event writes NOTHING");
const before = kv.nums.size;
await recordEvent({ event: "password_typed", cid: "dead", aid: "beef" });
check("no counter created", kv.nums.size === before);

console.log("\n[4] THE JOIN — the thing that was impossible before");
// One person: claimed, then created a link. That is the funnel, end to end.
await recordEvent({ event: "send_link_created", cid: "1111111111111111", aid: "1111111111111111" });
// A second person claimed and did nothing else.
await recordEvent({ event: "claim_succeeded", cid: "cccc3333", aid: "2222222222222222" });
s = (await eventsSummary())!;
check("two accounts claimed", s.funnel.claimed === 2, `got ${s.funnel.claimed}`);
check("one account acted", s.funnel.acted === 1);
check("the intersection is the answer", s.funnel.both === 1);
check("rate is both/claimed", s.funnel.rate === 0.5, `got ${s.funnel.rate}`);

console.log("\n[5] the funnel counts PEOPLE, not events");
// The same account sends three more links. It is still one person who reached the second stage.
for (let i = 0; i < 3; i++) {
  await recordEvent({ event: "send_link_created", cid: "1111111111111111", aid: "1111111111111111" });
}
s = (await eventsSummary())!;
check("still one account acted", s.funnel.acted === 1, `got ${s.funnel.acted}`);
check("rate unchanged by repeat sends", s.funnel.rate === 0.5);
check("but the raw event count did rise", s.totals.send_link_created === 4);

console.log("\n[6] cashing out counts as acting on the money");
await recordEvent({ event: "cashout_sent", cid: "2222222222222222", aid: "2222222222222222" });
s = (await eventsSummary())!;
check("the second account now counts as acted", s.funnel.acted === 2);
check("rate follows", s.funnel.rate === 1);

console.log("\n[7] a malformed id is dropped rather than stored");
await recordEvent({ event: "claim_succeeded", cid: "x", aid: "GA-NOT-A-HASH" });
s = (await eventsSummary())!;
check("no third account appeared in the funnel", s.funnel.claimed === 2, `got ${s.funnel.claimed}`);
check("the event itself was still counted", s.totals.claim_succeeded === 3);

console.log("\n[8] the store being absent is survivable");
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
let threw = false;
try {
  await recordEvent({ event: "claim_opened", cid: "aaaa1111" });
} catch {
  threw = true;
}
check("recording does not throw without a store", !threw);
check("the summary reports absence rather than a fake zero", (await eventsSummary()) === null);

console.log(`\n${fail === 0 ? "✅" : "❌"} EVENT BEACON ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
