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
import { handleEvent, recordEvent, eventsSummary, DURATION_BUCKETS } from "./lib/events.js";

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

console.log("\n[9] REFERRAL on its own: became-a-sender is not the same as cashed-out");
// Account 2 only cashed out (section 6). Account 1 created a link. Both "acted"; only 1 referred.
s = (await eventsSummary())!;
check("acted still counts both", s.funnel.acted === 2 && s.funnel.both === 2, `acted ${s.funnel.acted} both ${s.funnel.both}`);
check("referral counts only the account that created a link", s.funnel.referral === 1, `got ${s.funnel.referral}`);
check("referral rate is referral/claimed", s.funnel.referralRate === 0.5, `got ${s.funnel.referralRate}`);

console.log("\n[10] the bank rail leg has its own number, and it counts as acting");
await recordEvent({ event: "claim_succeeded", cid: "dddd4444", aid: "3333333333333333" });
await recordEvent({ event: "cashout_bank_sent", cid: "3333333333333333", aid: "3333333333333333" });
s = (await eventsSummary())!;
check("cashout_bank_sent is counted apart from cashout_sent", s.totals.cashout_bank_sent === 1 && s.totals.cashout_sent === 1);
check("the bank cash-out account is in the acted set", s.funnel.acted === 3 && s.funnel.both === 3, `acted ${s.funnel.acted}`);
check("...but not in the referral set", s.funnel.referral === 1);

console.log("\n[11] claim duration is counted into buckets, never stored per person");
await recordEvent({ event: "claim_succeeded", cid: "eeee5555", aid: "4444444444444444", dur: 12 });
await recordEvent({ event: "claim_succeeded", cid: "ffff6666", aid: "5555555555555555", dur: "45" });
await recordEvent({ event: "claim_succeeded", cid: "0000aaaa", aid: "6666666666666666", dur: 130 });
await recordEvent({ event: "claim_succeeded", cid: "0000bbbb", aid: "7777777777777777", dur: -3 });
await recordEvent({ event: "claim_succeeded", cid: "0000cccc", aid: "8888888888888888", dur: "soon" });
await recordEvent({ event: "claim_opened", cid: "0000dddd", dur: 5 });
s = (await eventsSummary())!;
check("12 s lands in 0-15", s.durations["0-15"] === 1, JSON.stringify(s.durations));
check("a string 45 lands in 30-60", s.durations["30-60"] === 1);
check("130 s lands in 120+", s.durations["120+"] === 1);
check("a negative or non-numeric duration is ignored", s.durations["15-30"] === 0 && s.durations["60-120"] === 0);
check("a duration on any event but claim_succeeded is ignored", Object.values(s.durations).reduce((a, b) => a + b, 0) === 3);
check(
  "the only timing keys are the five buckets; nothing per claim",
  [...kv.nums.keys()].filter((k) => k.includes(":dur:")).every((k) => DURATION_BUCKETS.some((b) => k.endsWith(`:dur:${b}`))),
);

console.log("\n[12] REPEATS: a second value event by the same account is one person in the repeat set");
s = (await eventsSummary())!;
// Account 1 created four links (sections 4 and 5): it is already a repeater.
check("the four-link sender is one repeater", s.funnel.repeat === 1, `got ${s.funnel.repeat}`);
await recordEvent({ event: "cashout_bank_sent", cid: "2222222222222222", aid: "2222222222222222" });
s = (await eventsSummary())!;
check("cash-out then bank cash-out by the same account is a second repeater", s.funnel.repeat === 2);
await recordEvent({ event: "deposit_completed", cid: "4444444444444444", aid: "4444444444444444" });
s = (await eventsSummary())!;
check("one funding event alone is not a repeat", s.funnel.repeat === 2);
await recordEvent({ event: "wallet_funded", cid: "4444444444444444", aid: "4444444444444444" });
s = (await eventsSummary())!;
check("a funding event after another value event is", s.funnel.repeat === 3);
check("repeat is people, not events: three more sends by account 1 change nothing", (await (async () => { for (let i = 0; i < 3; i++) await recordEvent({ event: "send_link_created", cid: "1111111111111111", aid: "1111111111111111" }); return (await eventsSummary())!.funnel.repeat; })()) === 3);

console.log("\n[13] the SEEDED cohort is counted apart, and organic is the subtraction");
const beforeSeeded = (await eventsSummary())!;
await recordEvent({ event: "claim_opened", cid: "seed0001", seeded: 1 });
await recordEvent({ event: "claim_succeeded", cid: "seed0001", aid: "9999999999999999", seeded: "1", dur: 20 });
await recordEvent({ event: "send_link_created", cid: "9999999999999999", aid: "9999999999999999" });
s = (await eventsSummary())!;
check("a seeded claim is in the overall totals", s.totals.claim_succeeded === beforeSeeded.totals.claim_succeeded + 1);
check("...and in the seeded totals", s.seeded.totals.claim_succeeded === 1 && s.seeded.totals.claim_opened === 1, JSON.stringify(s.seeded.totals));
check("the seeded account is in the seeded claimed set", s.seeded.claimed === 1);
check("its onward link is a SEEDED referral, not an organic one", s.seeded.referral === 1);
check("organic referral excludes it", s.organic.referral === s.funnel.referral - 1, `funnel ${s.funnel.referral} organic ${s.organic.referral}`);
check("organic claimed = claimed - seeded", s.organic.claimed === s.funnel.claimed - 1);
check("a seeded flag that is not 1/true is not seeded", (await (async () => { await recordEvent({ event: "claim_succeeded", cid: "seed0002", aid: "aaaaaaaaaaaaaaaa", seeded: "yes" }); return (await eventsSummary())!.seeded.claimed; })()) === 1);
check("the duration of a seeded claim still counts", s.durations["15-30"] === 1);

console.log("\n[14] TEAM accounts are dropped before any counter is touched");
process.env.EVENTS_EXCLUDE_AIDS = "bbbbbbbbbbbbbbbb, GNOTAHASH ,cccccccccccccccc";
const beforeTeam = (await eventsSummary())!;
const keysBefore = kv.nums.size;
await recordEvent({ event: "claim_succeeded", cid: "team0001", aid: "bbbbbbbbbbbbbbbb", seeded: 1, dur: 9 });
await recordEvent({ event: "send_link_created", cid: "bbbbbbbbbbbbbbbb", aid: "bbbbbbbbbbbbbbbb" });
await recordEvent({ event: "cashout_bank_sent", cid: "cccccccccccccccc", aid: "cccccccccccccccc" });
s = (await eventsSummary())!;
check("no total moved", JSON.stringify(s.totals) === JSON.stringify(beforeTeam.totals));
check("no funnel figure moved", JSON.stringify(s.funnel) === JSON.stringify(beforeTeam.funnel));
check("no seeded or duration figure moved", JSON.stringify(s.seeded) === JSON.stringify(beforeTeam.seeded) && JSON.stringify(s.durations) === JSON.stringify(beforeTeam.durations));
check("no key was created", kv.nums.size === keysBefore);
check("the summary says how many are excluded, not who", s.excludedAccounts === 2);
delete process.env.EVENTS_EXCLUDE_AIDS;
await recordEvent({ event: "send_link_created", cid: "bbbbbbbbbbbbbbbb", aid: "bbbbbbbbbbbbbbbb" });
check("with the list cleared the same account counts again", (await eventsSummary())!.totals.send_link_created === beforeTeam.totals.send_link_created + 1);

console.log("\n[15] the hackathon events exist on the allowlist");
for (const e of ["link_shared", "cashout_bank_sent", "deposit_started", "deposit_completed", "cctp_funded", "wallet_funded"]) {
  check(`accepts ${e}`, accepts(e));
}
const beforeNew = (await eventsSummary())!;
await recordEvent({ event: "link_shared", cid: "1111111111111111", aid: "1111111111111111" });
await recordEvent({ event: "deposit_started", cid: "1111111111111111", aid: "1111111111111111" });
await recordEvent({ event: "cctp_funded", cid: "1111111111111111", aid: "1111111111111111" });
s = (await eventsSummary())!;
check("they are counted", s.totals.link_shared === 1 && s.totals.deposit_started === 1 && s.totals.cctp_funded === 1);
check("link_shared and deposit_started do not move the acted or referral sets", s.funnel.acted === beforeNew.funnel.acted && s.funnel.referral === beforeNew.funnel.referral, `acted ${beforeNew.funnel.acted} -> ${s.funnel.acted}`);
check("every allowlisted event appears in totals, zero or not", Object.keys(s.totals).length === Object.keys(s.seeded.totals).length && "wallet_funded" in s.totals);

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
