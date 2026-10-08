/**
 * Link-record self-test: the state machine behind every pill the popup shows, and the loops that
 * drive it (the settle pass and the take-back).
 *
 * Every transition in src/lib/links.ts is a sentence a person will read as a fact about their money,
 * so what is pinned here is mostly what each one is NOT allowed to say:
 *
 *   [a] fromPrepared: a signed, not-yet-posted deposit becomes a `submitted` record, with the link id
 *       lowercased, an Infinity deadline stored as a finite number that survives JSON, and no link,
 *       URL or secret in it.
 *   [b] onLanded: "it went through" only when the escrow holds the drop; "nothing moved" only when
 *       the escrow is empty AND the deadline has passed; a read that did not finish is never "failed",
 *       however late. Checked case by case and against an oracle over 4000 random inputs.
 *   [c] onDropRead: pending / claimed / reclaimed from the escrow's answer, an unknown answer changes
 *       nothing but lastError, and a final record never moves again.
 *   [d] pillOf, [e] isFinal / isDue / backoff / isReclaimable, [f] the take-back bookkeeping,
 *       [g] the storage helpers (keys, asRecord, sortRecords).
 *   [h] settleOnce with fake readers: the read cap, who is skipped, which reader a phase gets, the
 *       record's OWN network, `only` and `force`, put-only-on-change, and that it cannot send anything.
 *   [i] runReclaim: persist the attempt before asking, definite vs uncertain refusals, and what the
 *       record reads as afterwards (Reclaimed or Claimed).
 *
 * RUN: pnpm --filter @lumenia/extension test:links   (offline, no keys, no network)
 */
import { readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import type { NetworkConfig, PreparedDeposit, Signer } from "../src/core";
import * as L from "../src/lib/links";
import { MAX_READS_PER_PASS, anyOpen, settleOnce, type SettleDeps } from "../src/background/settle";
import type { LinkRecord, NetId, Pill } from "../src/lib/types";
import { hexId, installBuildEnv, ok, outcome, run, same, section, show } from "./_harness";

/* ------------------------------------------ fixtures ------------------------------------------ */

const N = 1_800_000_000_000; // a fixed "now", unix ms
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SENDER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const INNER = "cd".repeat(32);
const HASH = "ab".repeat(32);
const DEADLINE = N + 120_000; // the 120 s a signed deposit stays includable
const EXPIRY_S = Math.floor(N / 1000) + 7 * 86400;
const SECRET = Keypair.random().secret();
const LINK_HEX = "ab12".repeat(16);

function prepared(over: Partial<PreparedDeposit> = {}): PreparedDeposit {
  return {
    // The private shape the extension makes (apps/web/lib/lumendrop.ts v2LinkUrl): the name after the key.
    link: `https://getlumenia.com/v2/c/${LINK_HEX}?src=ext#${SECRET}&s=Ayse`,
    linkHex: LINK_HEX.toUpperCase(),
    retrySafeAfter: DEADLINE,
    innerHash: INNER,
    expiry: EXPIRY_S,
    group: false,
    amount: "2.50",
    ...over,
  };
}
const CTX = { net: "testnet" as NetId, sender: SENDER, from: "Ayse", locked: false, now: N };

let seq = 1;
function mk(over: Partial<LinkRecord> = {}): LinkRecord {
  return {
    v: 1,
    net: "testnet",
    linkHex: hexId(seq++),
    sender: SENDER,
    amount: "2.50",
    from: "Ayse",
    locked: false,
    createdAt: N,
    expiry: EXPIRY_S,
    retrySafeAfter: DEADLINE,
    innerHash: INNER,
    phase: "submitted",
    nextCheckAt: N + MIN,
    ...over,
  };
}
function without<T extends object>(o: T, ...keys: string[]): T {
  const c = { ...o } as Record<string, unknown>;
  for (const k of keys) delete c[k];
  return c as T;
}
const submitted = (o: Partial<LinkRecord> = {}) => mk({ phase: "submitted", ...o });
const uncertain = (o: Partial<LinkRecord> = {}) => mk({ phase: "uncertain", lastError: "accepted, not yet seen in the escrow", ...o });
const confirmed = (o: Partial<LinkRecord> = {}) => mk({ phase: "confirmed", status: "pending", hash: HASH, lastCheckedAt: N, nextCheckAt: N + MIN, ...o });
const claimed = (o: Partial<LinkRecord> = {}) => without(confirmed({ status: "claimed", ...o }), "nextCheckAt");
const reclaimed = (o: Partial<LinkRecord> = {}) => without(confirmed({ status: "reclaimed", reclaimAttemptAt: N, reclaimHash: HASH, ...o }), "nextCheckAt");
const failed = (o: Partial<LinkRecord> = {}) => without(mk({ phase: "failed", failReason: "It did not go through. Nothing moved, so you can send it again.", ...o }), "nextCheckAt");

/** A tiny deterministic generator, so the random loops reproduce. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const NETS: Record<NetId, NetworkConfig> = {
  testnet: { id: "testnet", passphrase: "test", horizonUrl: "https://horizon.test", rpcUrl: "https://rpc.test", contract: "CTEST", legacyContracts: [], sponsorUrl: "https://sponsor.test", isMainnet: false },
  public: { id: "public", passphrase: "public", horizonUrl: "https://horizon.main", rpcUrl: "https://rpc.main", contract: "CMAIN", legacyContracts: [], sponsorUrl: "https://sponsor.main", isMainnet: true },
};

async function main() {
  installBuildEnv();
  // The whole suite is offline by contract: any request at all is a failure, counted at the end.
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("the links self-test must not touch the network");
  }) as typeof fetch;

  /* ---------------------------------------- [a] ---------------------------------------- */
  section("a", "fromPrepared: a signed, not yet posted deposit");
  const p0 = prepared();
  const r0 = L.fromPrepared(p0, CTX);
  ok("phase submitted, schema v1", r0.phase === "submitted" && r0.v === 1);
  ok("the link id is lowercased (the escrow's key is lowercase hex)", r0.linkHex === LINK_HEX && p0.linkHex !== LINK_HEX, r0.linkHex.slice(0, 8));
  ok(
    "net, sender, amount, from, locked, createdAt, expiry and innerHash are carried over",
    r0.net === "testnet" && r0.sender === SENDER && r0.amount === "2.50" && r0.from === "Ayse" && r0.locked === false && r0.createdAt === N && r0.expiry === EXPIRY_S && r0.innerHash === INNER,
  );
  ok("the first read is owed a minute from now", r0.nextCheckAt === N + MIN);
  ok("no status, hash, failReason, lastError or lastCheckedAt yet", r0.status === undefined && !("hash" in r0) && !("failReason" in r0) && !("lastError" in r0) && !("lastCheckedAt" in r0));
  ok("a finite deadline is stored as it is", r0.retrySafeAfter === DEADLINE);
  const stored = JSON.stringify(r0);
  ok(
    "nothing secret is in the record: no link, no URL, no fragment, no S... key",
    !stored.includes("#") && !stored.includes("https://") && !stored.includes(SECRET) && !/S[A-Z2-7]{55}/.test(stored) && !("link" in r0),
  );
  ok("locked and net follow the context", L.fromPrepared(p0, { ...CTX, net: "public", locked: true }).net === "public" && L.fromPrepared(p0, { ...CTX, locked: true }).locked === true);

  const inf = L.fromPrepared(prepared({ retrySafeAfter: Number.POSITIVE_INFINITY }), CTX);
  ok("an Infinity deadline (a transaction with no upper time bound) is stored as Number.MAX_SAFE_INTEGER", inf.retrySafeAfter === Number.MAX_SAFE_INTEGER, String(inf.retrySafeAfter));
  const infBack = JSON.parse(JSON.stringify(inf)) as LinkRecord;
  ok("  ...and survives JSON, where Infinity itself would come back as null", infBack.retrySafeAfter === Number.MAX_SAFE_INTEGER && L.asRecord(infBack) !== null);
  ok("  ...so 'never provably failed' stays that, however late the read", L.onLanded(infBack, false, N + 100_000 * DAY).phase === "uncertain");
  ok("a NaN deadline is the same: never failed", L.fromPrepared(prepared({ retrySafeAfter: Number.NaN }), CTX).retrySafeAfter === Number.MAX_SAFE_INTEGER);
  ok("the record round-trips through JSON unchanged", same(JSON.parse(JSON.stringify(r0)), r0));

  /* ---------------------------------------- [b] ---------------------------------------- */
  section("b", "onLanded: did the deposit land?");
  const sub = L.fromPrepared(prepared(), CTX);
  const c1 = L.onLanded(sub, true, N + 5_000);
  ok("landed true: submitted becomes confirmed / pending", c1.phase === "confirmed" && c1.status === "pending");
  ok("  ...stamped with the read time, the next read a minute later", c1.lastCheckedAt === N + 5_000 && c1.nextCheckAt === N + 5_000 + MIN);
  ok("  ...the identity of the record is untouched", c1.linkHex === sub.linkHex && c1.amount === sub.amount && c1.innerHash === sub.innerHash && c1.retrySafeAfter === sub.retrySafeAfter && c1.createdAt === sub.createdAt);
  const stale = uncertain({ failReason: "x" });
  const c2 = L.onLanded(stale, true, N + 5_000);
  ok("landed true on an uncertain record confirms it and clears lastError and failReason", c2.phase === "confirmed" && !("lastError" in c2) && !("failReason" in c2));

  const u1 = L.onLanded(sub, false, DEADLINE - 1);
  ok("landed false BEFORE the deadline: uncertain, and no failReason (an empty escrow is only 'not yet')", u1.phase === "uncertain" && !("failReason" in u1), u1.phase);
  ok("  ...asked again a minute later", u1.nextCheckAt === DEADLINE - 1 + MIN && u1.lastCheckedAt === DEADLINE - 1);
  // The deadline is judged by the ledger's clock and read by this device's: an empty escrow only
  // proves "nothing moved" once the deadline AND a clock margin have passed.
  const FAIL_AT = DEADLINE + L.CLOCK_MARGIN_MS;
  ok("the clock margin is five minutes", L.CLOCK_MARGIN_MS === 5 * MIN);
  for (const [label, at] of [["exactly at the deadline", DEADLINE], ["one ms after it", DEADLINE + 1], ["one ms inside the margin", FAIL_AT - 1]] as const) {
    const w = L.onLanded(sub, false, at);
    ok(`landed false ${label}: still uncertain (a fast device clock must not call it failed)`, w.phase === "uncertain" && !("failReason" in w), w.phase);
  }
  ok("it takes two empty reads past the deadline and the margin to fail", L.EMPTY_READS_TO_FAIL === 2);
  for (const [label, at] of [["at the deadline plus the margin", FAIL_AT], ["one ms after that", FAIL_AT + 1], ["a week after it", DEADLINE + 7 * DAY]] as const) {
    const once = L.onLanded(sub, false, at);
    ok(`landed false ${label}, the first time: uncertain, one empty read counted, asked again in a minute`, once.phase === "uncertain" && once.emptyReads === 1 && once.nextCheckAt === at + MIN && !("failReason" in once), once.phase);
    const f = L.onLanded(once, false, at + MIN);
    ok(
      `  ...the second time: failed, with a reason that says nothing moved, and one last check owed an hour later`,
      f.phase === "failed" && typeof f.failReason === "string" && /Nothing moved/.test(f.failReason) && !("nextCheckAt" in f) && !("emptyReads" in f) && f.lastCheckedAt === at + MIN && f.recheckAt === at + MIN + HOUR,
      f.phase,
    );
  }
  ok("  ...the same for an uncertain record that already had one empty read", L.onLanded(uncertain({ emptyReads: 1 }), false, FAIL_AT).phase === "failed");
  const notCounted = L.onLanded(L.onLanded(sub, false, FAIL_AT - 1), false, FAIL_AT);
  ok("an empty read inside the margin is not counted: one more is needed after it", notCounted.phase === "uncertain" && notCounted.emptyReads === 1);
  const gap = L.onLanded(L.onLanded(L.onLanded(sub, false, FAIL_AT), "unknown", FAIL_AT + MIN), false, FAIL_AT + 2 * MIN);
  ok("an unreadable escrow between two empty reads neither counts nor resets: the second empty read fails it", gap.phase === "failed");
  ok("  ...and a read that finds the drop after one empty read confirms it and drops the count", (() => {
    const c = L.onLanded(L.onLanded(sub, false, FAIL_AT), true, FAIL_AT + MIN);
    return c.phase === "confirmed" && !("emptyReads" in c);
  })());
  const cleared = L.onLanded(uncertain({ lastError: "could not read the escrow" }), false, DEADLINE - 1);
  ok("a clean 'not yet' read clears a stale lastError; an unknown read sets one", !("lastError" in cleared) && L.onLanded(cleared, "unknown", DEADLINE - 1).lastError === "could not read the escrow");

  for (const [label, at] of [["before the deadline", DEADLINE - 1], ["at it", DEADLINE], ["a week after it", DEADLINE + 7 * DAY], ["400 days after it", DEADLINE + 400 * DAY]] as const) {
    const q = L.onLanded(sub, "unknown", at);
    ok(
      `unknown ${label}: uncertain with lastError, never failed, never confirmed`,
      q.phase === "uncertain" && typeof q.lastError === "string" && q.lastError.length > 0 && !("failReason" in q),
      q.phase,
    );
  }
  ok("  ...and it keeps asking: the next read is a minute out", L.onLanded(sub, "unknown", DEADLINE + 400 * DAY).nextCheckAt === DEADLINE + 400 * DAY + MIN);

  const conf = L.confirm(sub, HASH, N);
  const fin = failed();
  let untouched = true;
  for (const a of [true, false, "unknown"] as const) {
    for (const at of [N, DEADLINE + 1, DEADLINE + DAY]) {
      if (L.onLanded(conf, a, at) !== conf) untouched = false;
      if (L.onLanded(fin, a, at) !== fin) untouched = false;
      if (L.onLanded(claimed(), a, at).status !== "claimed") untouched = false;
    }
  }
  ok("a confirmed (or failed, or claimed) record is returned as it is, whatever the answer and the time", untouched);

  ok("confirm keeps the hash it already had when given none, and sets one when given", L.confirm(confirmed({ hash: "11".repeat(32) }), undefined, N).hash === "11".repeat(32) && L.confirm(sub, HASH, N).hash === HASH);
  ok("  ...and a deposit seen only in the escrow has no hash field at all", !("hash" in L.confirm(sub, undefined, N)) && !("hash" in L.confirm(sub, "", N)));
  ok("markUncertain keeps the reason; markFailed drops the next read", L.markUncertain(sub, N, "why").lastError === "why" && !("nextCheckAt" in L.markFailed(sub, "r", N)) && L.markFailed(sub, "r", N).failReason === "r");
  ok("  ...and markFailed owes one last read an hour past the later of now and the deadline", L.markFailed(sub, "r", N).recheckAt === DEADLINE + HOUR && L.markFailed(sub, "r", DEADLINE + DAY).recheckAt === DEADLINE + DAY + HOUR);
  const mu = L.markUncertain(sub, N + 5 * MIN, "why");
  ok("  ...markUncertain re-reads a minute after the moment it was marked, and a missing reason adds none", mu.phase === "uncertain" && mu.nextCheckAt === N + 6 * MIN && !("lastError" in L.markUncertain(sub, N)));

  // The oracle: the spec of onLanded written out again, run over random records, answers and clocks.
  {
    const rand = rng(20261003);
    let bad = "";
    for (let i = 0; i < 4000 && !bad; i++) {
      const phase = pick(rand, ["submitted", "uncertain", "confirmed", "failed"] as const);
      const deadline = rand() < 0.15 ? Number.MAX_SAFE_INTEGER : N + Math.floor((rand() - 0.5) * 2 * HOUR);
      const prior = phase === "uncertain" && rand() < 0.5 ? { emptyReads: 1 } : {};
      const base = mk({ phase, retrySafeAfter: deadline, ...prior, ...(phase === "confirmed" ? { status: "pending" as const } : {}) });
      const answer = pick(rand, [true, false, "unknown"] as const);
      const now = N + Math.floor((rand() - 0.3) * 3 * DAY);
      const out = L.onLanded(base, answer, now);
      const open = phase === "submitted" || phase === "uncertain";
      const proof = answer === false && now >= deadline + L.CLOCK_MARGIN_MS && (base.emptyReads ?? 0) + 1 >= L.EMPTY_READS_TO_FAIL;
      const want = !open ? phase : answer === true ? "confirmed" : proof ? "failed" : "uncertain";
      const round = L.asRecord(JSON.parse(JSON.stringify(out)));
      if (out.phase !== want) bad = `phase ${out.phase} != ${want} for ${phase}/${String(answer)}/${now - deadline}`;
      else if (out.phase === "failed" && phase !== "failed" && !(open && proof)) bad = "failed without proof";
      else if (out.phase === "confirmed" && open && answer !== true) bad = "confirmed without the escrow";
      else if (out.linkHex !== base.linkHex || out.amount !== base.amount || out.innerHash !== base.innerHash || out.createdAt !== base.createdAt || out.retrySafeAfter !== base.retrySafeAfter) bad = "identity changed";
      else if (!round) bad = "result is not a storable record";
    }
    ok("4000 random (phase, answer, clock) inputs agree with the oracle: failed only on a second empty read past the deadline and the margin", bad === "", bad);
  }

  /* ---------------------------------------- [c] ---------------------------------------- */
  section("c", "onDropRead: what the escrow says about a confirmed link");
  const cf = confirmed();
  const pend = L.onDropRead(cf, "pending", N + 3 * MIN);
  ok("pending: status pending, read time stamped, next read per the backoff (a minute while young)", pend.status === "pending" && pend.lastCheckedAt === N + 3 * MIN && pend.nextCheckAt === N + 4 * MIN);
  ok("  ...and a stale lastError is cleared by a clean read", !("lastError" in L.onDropRead(confirmed({ lastError: "could not read the escrow" }), "pending", N)));
  const cl = L.onDropRead(cf, "settled", N + 3 * MIN);
  ok("settled, no take-back asked for: claimed, and nothing more to read", cl.status === "claimed" && !("nextCheckAt" in cl) && L.isFinal(cl));
  const rc = L.onDropRead(confirmed({ reclaimAttemptAt: N + MIN }), "settled", N + 3 * MIN);
  ok("settled while a take-back of ours is unanswered: closed (claimed or taken back), never a guess", rc.status === "closed" && L.isFinal(rc));
  const ro = L.onDropRead(confirmed({ reclaimOpenAt: N + MIN }), "settled", N + 3 * MIN);
  ok("  ...the same after a take-back whose outcome never became known", ro.status === "closed" && L.isFinal(ro));
  const rh = L.onDropRead(confirmed({ reclaimOpenAt: N + MIN, reclaimHash: HASH }), "settled", N + 3 * MIN);
  ok("  ...and Reclaimed only with our own confirmed take-back (its hash)", rh.status === "reclaimed");
  const un = L.onDropRead(cf, "unknown", N + 3 * MIN);
  ok("unknown: the status stays pending (claimed stays absent) and lastError says the read failed", un.status === "pending" && un.phase === "confirmed" && typeof un.lastError === "string");
  ok("  ...and it is asked again, per the backoff", un.nextCheckAt === N + 3 * MIN + MIN && un.lastCheckedAt === N + 3 * MIN);
  const unA = L.onDropRead(confirmed({ reclaimAttemptAt: N + MIN }), "unknown", N + 3 * MIN);
  ok("unknown with a take-back attempt on file does not turn into reclaimed either", unA.status === "pending");
  ok("an old link is read hourly, a day-old one every ten minutes", L.onDropRead(confirmed({ createdAt: N - 2 * DAY }), "pending", N).nextCheckAt === N + HOUR && L.onDropRead(confirmed({ createdAt: N - HOUR }), "pending", N).nextCheckAt === N + 10 * MIN);

  let finalSame = true;
  const closedRec = without(confirmed({ status: "closed", reclaimOpenAt: N }), "nextCheckAt");
  for (const f of [claimed(), reclaimed(), closedRec, failed()]) for (const a of ["pending", "settled", "unknown"] as const) if (L.onDropRead(f, a, N + DAY) !== f) finalSame = false;
  ok("a final record (claimed, reclaimed, closed, failed) is never changed, whatever the escrow says", finalSame);
  let phaseSame = true;
  for (const f of [submitted(), uncertain()]) for (const a of ["pending", "settled", "unknown"] as const) if (L.onDropRead(f, a, N + DAY) !== f) phaseSame = false;
  ok("a record that is not confirmed yet is not read as a drop either", phaseSame);

  {
    const rand = rng(20261004);
    let bad = "";
    for (let i = 0; i < 4000 && !bad; i++) {
      const phase = pick(rand, ["submitted", "uncertain", "confirmed", "failed"] as const);
      const status = phase === "confirmed" ? pick(rand, ["pending", "claimed", "reclaimed", "closed"] as const) : undefined;
      const attempt = rand() < 0.3 ? { reclaimAttemptAt: N + 1 } : {};
      const open = rand() < 0.3 ? { reclaimOpenAt: N + 2 } : {};
      const hash = rand() < 0.2 ? { reclaimHash: HASH } : {};
      const base = mk({ phase, ...(status ? { status } : {}), ...attempt, ...open, ...hash, createdAt: N - Math.floor(rand() * 3 * DAY) });
      const read = pick(rand, ["pending", "settled", "unknown"] as const);
      const out = L.onDropRead(base, read, N);
      const movable = phase === "confirmed" && !L.isFinal(base);
      const ours = base.reclaimAttemptAt !== undefined || base.reclaimOpenAt !== undefined;
      const want = !movable ? base.status : read === "unknown" ? base.status : read === "pending" ? "pending" : base.reclaimHash ? "reclaimed" : ours ? "closed" : "claimed";
      if (!movable && out !== base) bad = "a non-movable record changed";
      else if (out.status !== want) bad = `status ${String(out.status)} != ${String(want)} for ${phase}/${String(status)}/${read}`;
      else if ((out.status === "claimed" || out.status === "reclaimed" || out.status === "closed") && !(read === "settled" || !movable)) bad = "final status without a settled read";
      else if (out.status === "reclaimed" && movable && !base.reclaimHash) bad = "reclaimed without our own confirmed take-back";
      else if (out.status === "claimed" && movable && ours) bad = "claimed while a take-back of ours may have landed";
      else if (!L.asRecord(JSON.parse(JSON.stringify(out)))) bad = "result is not a storable record";
    }
    ok("4000 random (record, read) inputs agree with the oracle: final only on a settled read, Reclaimed only with our hash, Claimed only with no take-back of ours", bad === "", bad);
  }

  /* ---------------------------------------- [d] ---------------------------------------- */
  section("d", "pillOf: what the popup shows");
  const E = EXPIRY_S * 1000;
  const pillRows: [string, LinkRecord, number, Pill][] = [
    ["submitted", submitted(), N, "checking"],
    ["uncertain", uncertain(), N, "uncertain"],
    ["failed", failed(), N, "failed"],
    ["confirmed, a ms before the expiry", confirmed(), E - 1, "waiting"],
    ["confirmed, exactly at the expiry", confirmed(), E, "reclaimable"],
    ["confirmed, a ms after the expiry", confirmed(), E + 1, "reclaimable"],
    ["confirmed, long after the expiry", confirmed(), E + 100 * DAY, "reclaimable"],
    ["confirmed, just sent", confirmed(), N, "waiting"],
    ["claimed, before the expiry", claimed(), N, "claimed"],
    ["claimed, long after the expiry", claimed(), E + DAY, "claimed"],
    ["reclaimed", reclaimed(), N, "reclaimed"],
    ["reclaimed, long after the expiry", reclaimed(), E + DAY, "reclaimed"],
    ["closed (claimed or taken back)", without(confirmed({ status: "closed" }), "nextCheckAt"), E + DAY, "closed"],
    ["failed with its last check still owed", failed({ recheckAt: N + HOUR }), N, "failed"],
    ["submitted, long after the expiry", submitted(), E + DAY, "checking"],
    ["uncertain, long after the expiry", uncertain(), E + DAY, "uncertain"],
  ];
  for (const [label, rec, at, want] of pillRows) ok(`${label} -> ${want}`, L.pillOf(rec, at) === want, L.pillOf(rec, at));
  const labels = Object.keys(L.PILL_LABEL).sort();
  ok("PILL_LABEL names exactly the eight pills, each with words", same(labels, ["checking", "claimed", "closed", "failed", "reclaimable", "reclaimed", "uncertain", "waiting"]) && Object.values(L.PILL_LABEL).every((s) => s.length > 0));
  ok("a failed link reads 'Didn't go through', never a vaguer word", L.PILL_LABEL.failed === "Didn't go through");

  /* ---------------------------------------- [e] ---------------------------------------- */
  section("e", "isFinal, isDue, backoff, isReclaimable");
  ok("isFinal: failed, claimed, reclaimed and closed are final", L.isFinal(failed()) && L.isFinal(claimed()) && L.isFinal(reclaimed()) && L.isFinal(confirmed({ status: "closed" })));
  ok("  ...a failed link with its last check still owed is not final, and is due at that time only", !L.isFinal(failed({ recheckAt: N + HOUR })) && !L.isDue(failed({ recheckAt: N + HOUR }), N + HOUR - 1) && L.isDue(failed({ recheckAt: N + HOUR }), N + HOUR));
  ok("  ...submitted, uncertain and a pending confirmed link are not", !L.isFinal(submitted()) && !L.isFinal(uncertain()) && !L.isFinal(confirmed()));
  const due = uncertain({ nextCheckAt: 5_000 });
  ok("isDue: a ms before nextCheckAt is not due; at it and after it is", !L.isDue(due, 4_999) && L.isDue(due, 5_000) && L.isDue(due, 5_001));
  ok("  ...no nextCheckAt means due now; a final record is never due", L.isDue(without(uncertain(), "nextCheckAt"), 0) && !L.isDue(claimed({ nextCheckAt: 0 }), N) && !L.isDue(failed({ nextCheckAt: 0 }), N));
  const old = (age: number, phase: LinkRecord["phase"] = "confirmed") => mk({ phase, ...(phase === "confirmed" ? { status: "pending" as const } : {}), createdAt: N - age });
  ok("backoff: a minute while younger than ten minutes", L.backoff(old(0), N) === MIN && L.backoff(old(10 * MIN - 1), N) === MIN);
  ok("  ...ten minutes from ten minutes of age, until a day", L.backoff(old(10 * MIN), N) === 10 * MIN && L.backoff(old(DAY - 1), N) === 10 * MIN);
  ok("  ...an hour from a day of age", L.backoff(old(DAY), N) === HOUR && L.backoff(old(400 * DAY), N) === HOUR);
  ok("  ...uncertain and submitted records are a minute whatever their age", L.backoff(old(400 * DAY, "uncertain"), N) === MIN && L.backoff(old(400 * DAY, "submitted"), N) === MIN);
  ok("isReclaimable: confirmed + pending from the expiry on, not a ms before", !L.isReclaimable(confirmed(), E - 1) && L.isReclaimable(confirmed(), E) && L.isReclaimable(confirmed(), E + DAY));
  ok("  ...never claimed, reclaimed, submitted, uncertain or failed", [claimed(), reclaimed(), submitted(), uncertain(), failed()].every((r) => !L.isReclaimable(r, E + DAY)));

  /* ---------------------------------------- [f] ---------------------------------------- */
  section("f", "the take-back bookkeeping");
  const base = confirmed({ lastError: "could not read the escrow" });
  const att = L.onReclaimAttempt(base, N + 10);
  ok("onReclaimAttempt records when we asked, and changes nothing else", att.reclaimAttemptAt === N + 10 && att.status === "pending" && att.phase === "confirmed");
  const done = L.onReclaimed(att, HASH, N + 20);
  ok("onReclaimed: status reclaimed with the take-back's hash, no further reads, lastError cleared", done.status === "reclaimed" && done.reclaimHash === HASH && !("nextCheckAt" in done) && !("lastError" in done) && L.isFinal(done));
  const defin = L.onReclaimFailed(att, true, N + 30);
  ok("a DEFINITE failure forgets the attempt (nothing was submitted)", !("reclaimAttemptAt" in defin) && same(defin, without(att, "reclaimAttemptAt")));
  const indef = L.onReclaimFailed(att, false, N + 30);
  ok("a failure that is NOT definite marks the take-back open (never cleared) and reads again in a minute", indef.reclaimOpenAt === N + 30 && !("reclaimAttemptAt" in indef) && indef.nextCheckAt === N + 30 + MIN);
  ok("so a later 'settled' read says only what is known: Claimed after a refused attempt, Closed after an open one", L.onDropRead(defin, "settled", N + 99).status === "claimed" && L.onDropRead(indef, "settled", N + 99).status === "closed");
  const again = L.onReclaimFailed(L.onReclaimAttempt(indef, N + 40), true, N + 50);
  ok("a definite refusal of a LATER attempt keeps the earlier open mark (that attempt may be why this one was refused)", again.reclaimOpenAt === N + 30 && L.onDropRead(again, "settled", N + 99).status === "closed");
  ok("  ...and two open attempts keep the first time", L.onReclaimFailed(L.onReclaimAttempt(indef, N + 40), false, N + 50).reclaimOpenAt === N + 30);

  /* The one last read a failed link is owed. */
  const owed = L.markFailed(submitted(), "It did not go through. Nothing moved, so you can send it again.", DEADLINE + 10 * MIN);
  const back = L.onRecheck(owed, true, owed.recheckAt!);
  ok("onRecheck: the drop is in the escrow after all: confirmed / pending, the failure and the last check gone", back.phase === "confirmed" && back.status === "pending" && !("failReason" in back) && !("recheckAt" in back));
  const stands = L.onRecheck(owed, false, owed.recheckAt!);
  ok("  ...still empty: the failure stands for good (final, never read again)", stands.phase === "failed" && !("recheckAt" in stands) && L.isFinal(stands));
  const later = L.onRecheck(owed, "unknown", owed.recheckAt!);
  ok("  ...unreadable: asked again in ten minutes", later.phase === "failed" && later.recheckAt === owed.recheckAt! + 10 * MIN);
  const giveUp = L.onRecheck(owed, "unknown", DEADLINE + DAY);
  ok("  ...but not past a day after the deadline: then the failure stands", giveUp.phase === "failed" && !("recheckAt" in giveUp));
  ok("  ...and a record that owes no check is returned as it is", L.onRecheck(failed(), true, N) === failed() || L.onRecheck(failed(), true, N).phase === "failed");

  /* The sends that ask for a second thought, and the links "Forget" must not drop silently. */
  const T = N;
  ok("unconfirmedSend: an uncertain or submitted send on this network within six hours", L.unconfirmedSend([uncertain()], "testnet", T) !== null && L.unconfirmedSend([submitted()], "testnet", T) !== null);
  ok("  ...not on the other network, not past six hours, not once confirmed or failed", L.unconfirmedSend([uncertain()], "public", T) === null && L.unconfirmedSend([uncertain({ createdAt: T - 6 * HOUR })], "testnet", T) === null && L.unconfirmedSend([confirmed(), failed()], "testnet", T) === null);
  const openSet = L.openLinks([submitted(), uncertain(), confirmed(), claimed(), reclaimed(), confirmed({ status: "closed" }), failed(), failed({ recheckAt: N + HOUR })]);
  ok("openLinks: being made, unconfirmed, waiting or reclaimable, and failed with a check owed; never the settled ones", openSet.length === 4 && openSet.every((r) => r.phase !== "confirmed" || r.status === "pending"));

  /* Reads go to the escrow a link was made on. */
  const NEWNET: NetworkConfig = { ...NETS.testnet, contract: "CNEW", legacyContracts: ["COLDER"] };
  ok("netForRecord: a record with no contract, or the current one, reads the network as it is", L.netForRecord(NEWNET, confirmed()) === NEWNET && L.netForRecord(NEWNET, confirmed({ contract: "CNEW" })) === NEWNET);
  const moved = L.netForRecord(NEWNET, confirmed({ contract: "COLD" }));
  ok("  ...a record made on a replaced escrow reads that escrow first, and still knows the others", moved.contract === "COLD" && same(moved.legacyContracts, ["CNEW", "COLDER"]) && moved.rpcUrl === NEWNET.rpcUrl);
  ok("fromPrepared keeps the escrow the deposit was made on", L.fromPrepared(prepared(), { ...CTX, contract: "CTEST" }).contract === "CTEST" && !("contract" in L.fromPrepared(prepared(), CTX)));

  /* ---------------------------------------- [g] ---------------------------------------- */
  section("g", "storage helpers: keys, asRecord, sortRecords");
  ok("linkKey is links:<net>:<lowercase hex>", L.linkKey("testnet", LINK_HEX.toUpperCase()) === `links:testnet:${LINK_HEX}` && L.linkKey("public", LINK_HEX) === `links:public:${LINK_HEX}`);
  ok("isLinkKey accepts exactly those", L.isLinkKey(`links:testnet:${LINK_HEX}`) && L.isLinkKey(`links:public:${LINK_HEX}`));
  ok(
    "  ...and refuses other networks, upper case, short ids and other keys",
    !L.isLinkKey(`links:mainnet:${LINK_HEX}`) && !L.isLinkKey(`links:testnet:${LINK_HEX.toUpperCase()}`) && !L.isLinkKey(`links:testnet:${LINK_HEX.slice(1)}`) && !L.isLinkKey("settings") && !L.isLinkKey(`xlinks:testnet:${LINK_HEX}`) && !L.isLinkKey(`links:testnet:${LINK_HEX}0`),
  );
  const good = confirmed();
  ok("asRecord accepts every record this module can produce, after a JSON round trip", [submitted(), uncertain(), confirmed(), claimed(), reclaimed(), failed(), L.fromPrepared(prepared(), CTX)].every((r) => L.asRecord(JSON.parse(JSON.stringify(r))) !== null));
  const junk: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "links"],
    ["a number", 7],
    ["an array", []],
    ["an empty object", {}],
    ["a wrong schema version", { ...good, v: 2 }],
    ["no schema version", without(good, "v")],
    ["a link id that is too short", { ...good, linkHex: "ab".repeat(31) }],
    ["a link id in upper case", { ...good, linkHex: LINK_HEX.toUpperCase() }],
    ["a link id with a non-hex digit", { ...good, linkHex: `${"ab".repeat(31)}zz` }],
    ["a link id that is not a string", { ...good, linkHex: 12 }],
    ["an unknown network", { ...good, net: "mainnet" }],
    ["no network", without(good, "net")],
    ["an unknown phase", { ...good, phase: "done" }],
    ["no phase", without(good, "phase")],
    ["no sender", without(good, "sender")],
    ["a sender that is not a string", { ...good, sender: 5 }],
    ["no amount", without(good, "amount")],
    ["an amount that is a number", { ...good, amount: 2.5 }],
    ["no expiry", without(good, "expiry")],
    ["an expiry that is a string", { ...good, expiry: "soon" }],
    // A record without a real deadline would let an empty escrow read as "nothing moved" at once.
    ["no retrySafeAfter", without(good, "retrySafeAfter")],
    ["a null retrySafeAfter (what JSON makes of Infinity)", { ...good, retrySafeAfter: null }],
    ["a retrySafeAfter that is a string", { ...good, retrySafeAfter: "later" }],
    ["no createdAt", without(good, "createdAt")],
    ["a createdAt that is a string", { ...good, createdAt: "today" }],
  ];
  for (const [label, v] of junk) ok(`asRecord rejects ${label}`, L.asRecord(v) === null);
  const sorted = L.sortRecords([mk({ createdAt: 1 }), mk({ createdAt: 3 }), mk({ createdAt: 2 })]);
  const input = [mk({ createdAt: 1 }), mk({ createdAt: 3 })];
  L.sortRecords(input);
  ok("sortRecords is newest first, and does not reorder its input", same(sorted.map((r) => r.createdAt), [3, 2, 1]) && input[0]!.createdAt === 1);

  /* ---------------------------------------- [h] ---------------------------------------- */
  section("h", "settleOnce: the pass that finishes what a dead worker left");

  interface Rig {
    deps: SettleDeps;
    store: Map<string, LinkRecord>;
    landed: { linkHex: string; sender: string; net: NetworkConfig }[];
    drops: { linkHex: string; sender: string; net: NetworkConfig }[];
    puts: LinkRecord[];
    nets: NetId[];
    clock: { now: number };
  }
  function rig(
    records: LinkRecord[],
    o: { now?: number; landed?: boolean | "unknown" | Error; drop?: "pending" | "settled" | "unknown" | Error; inFlight?: string[] } = {},
  ): Rig {
    const store = new Map(records.map((r) => [r.linkHex, structuredClone(r)]));
    const out: Rig = { deps: null as unknown as SettleDeps, store, landed: [], drops: [], puts: [], nets: [], clock: { now: o.now ?? N + MIN } };
    const busy = new Set(o.inFlight ?? []);
    out.deps = {
      now: () => out.clock.now,
      records: async () => [...store.values()].map((r) => structuredClone(r)),
      get: async (linkHex) => (store.has(linkHex) ? structuredClone(store.get(linkHex)!) : null),
      put: async (r) => {
        out.puts.push(structuredClone(r));
        store.set(r.linkHex, structuredClone(r));
      },
      netConfig: (id) => {
        out.nets.push(id);
        return NETS[id];
      },
      landed: async (linkHex, sender, net) => {
        out.landed.push({ linkHex, sender, net });
        if (o.landed instanceof Error) throw o.landed;
        return o.landed ?? false;
      },
      dropStatus: async (linkHex, sender, net) => {
        out.drops.push({ linkHex, sender, net });
        if (o.drop instanceof Error) throw o.drop;
        return o.drop ?? "pending";
      },
      inFlight: (r) => busy.has(r.linkHex),
    };
    return out;
  }

  const settleSrc = readFileSync(new URL("../src/background/settle.ts", import.meta.url), "utf8");
  const code = settleSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const valueImports = [...code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  ok("by construction: settle.ts imports nothing at runtime but the pure state machine", same(valueImports, ["../lib/links"]), show(valueImports));
  ok("  ...and its code never names a function that creates, sends, takes back or beacons", !/createV2Link|createV2GroupLink|reclaimV2|sendEvent|sendBeacon|fetch\s*\(|XMLHttpRequest|\/v2-deposit|\/v2-reclaim/.test(code));
  const probe = rig([]);
  ok("  ...and the deps it is given are the eight readers and no sender", same(Object.keys(probe.deps).sort(), ["dropStatus", "get", "inFlight", "landed", "netConfig", "now", "put", "records"]));
  ok("MAX_READS_PER_PASS is ten (the plan's number)", MAX_READS_PER_PASS === 10);

  // The cap, across both kinds of reader, oldest-due first.
  const mixed: LinkRecord[] = [];
  for (let i = 0; i < 15; i++) {
    const nextCheckAt = N - 10_000 + i; // distinct, all due
    mixed.push(i % 3 === 0 ? submitted({ nextCheckAt }) : i % 3 === 1 ? uncertain({ nextCheckAt }) : confirmed({ nextCheckAt }));
  }
  const capRig = rig(mixed, { landed: false, drop: "pending" });
  const first = await settleOnce(capRig.deps);
  const reads1 = capRig.landed.length + capRig.drops.length;
  ok("fifteen due records, one pass: at most MAX_READS_PER_PASS reads", reads1 === MAX_READS_PER_PASS && first.length <= MAX_READS_PER_PASS, `${reads1} reads`);
  const readIds = [...capRig.landed, ...capRig.drops].map((c) => c.linkHex).sort();
  ok("  ...the ten that have waited longest (lowest nextCheckAt) are the ones read", same(readIds, mixed.slice(0, 10).map((r) => r.linkHex).sort()));
  const second = await settleOnce(capRig.deps);
  const reads2 = capRig.landed.length + capRig.drops.length - reads1;
  ok("  ...the next pass reads the other five (the first ten are not due again for a minute)", reads2 === 5 && second.length === 5, `${reads2} reads`);
  const third = await settleOnce(capRig.deps);
  ok("  ...and a third pass at the same instant reads nothing", capRig.landed.length + capRig.drops.length === 15 && third.length === 0);

  // Who is skipped.
  const skipRig = rig([claimed(), reclaimed(), failed(), confirmed({ nextCheckAt: N + HOUR })], { landed: false, drop: "pending" });
  await settleOnce(skipRig.deps);
  await settleOnce(skipRig.deps, { force: true });
  ok("final records are never read, not even with force (and a pending one that is not due is read only with force)", skipRig.landed.length === 0 && skipRig.drops.length === 1);
  const busyRec = uncertain();
  const busyRig = rig([busyRec, uncertain()], { landed: false, inFlight: [busyRec.linkHex] });
  await settleOnce(busyRig.deps, { force: true });
  ok("a record whose send is still in flight in this worker is left alone, even with force", busyRig.landed.length === 1 && busyRig.landed[0]!.linkHex !== busyRec.linkHex);

  // Which reader, with which network.
  const subT = submitted({ net: "testnet" });
  const subP = submitted({ net: "public", sender: "GPUBLICSENDER" });
  const uncT = uncertain({ net: "testnet" });
  const uncP = uncertain({ net: "public", sender: "GOTHERSENDER" });
  const cnfT = confirmed({ net: "testnet" });
  const cnfP = confirmed({ net: "public", sender: "GTHIRDSENDER" });
  const readerRig = rig([subT, subP, uncT, uncP, cnfT, cnfP], { landed: false, drop: "pending" });
  await settleOnce(readerRig.deps);
  const byHex = (xs: Rig["landed"], r: LinkRecord) => xs.filter((c) => c.linkHex === r.linkHex);
  ok(
    "submitted and uncertain records are asked 'did it land?' (landed), once each",
    [subT, subP, uncT, uncP].every((r) => byHex(readerRig.landed, r).length === 1 && byHex(readerRig.drops, r).length === 0),
  );
  ok("  ...confirmed records are asked 'what is the drop doing?' (dropStatus), once each", [cnfT, cnfP].every((r) => byHex(readerRig.drops, r).length === 1 && byHex(readerRig.landed, r).length === 0));
  ok(
    "  ...every read carries the record's OWN network config (the very object, testnet or public) and its sender",
    [...readerRig.landed, ...readerRig.drops].every((c) => {
      const r = [subT, subP, uncT, uncP, cnfT, cnfP].find((x) => x.linkHex === c.linkHex)!;
      return c.net === NETS[r.net] && c.sender === r.sender;
    }),
  );
  ok("  ...and both networks were really exercised", readerRig.nets.includes("testnet") && readerRig.nets.includes("public"));

  // An unknown answer never moves a status.
  const unkRig = rig([uncertain({ retrySafeAfter: N - DAY }), confirmed(), submitted({ retrySafeAfter: N - DAY })], { landed: "unknown", drop: "unknown" });
  const unkChanged = await settleOnce(unkRig.deps);
  const unkAfter = [...unkRig.store.values()];
  ok(
    "unknown answers: an uncertain or submitted record past its deadline stays uncertain, never failed",
    unkAfter.filter((r) => r.phase !== "confirmed").every((r) => r.phase === "uncertain" && r.lastError !== undefined && r.failReason === undefined),
  );
  ok("  ...a confirmed record keeps status pending (claimed stays absent) and records the failed read", unkAfter.filter((r) => r.phase === "confirmed").every((r) => r.status === "pending" && r.lastError !== undefined));
  ok("  ...all three changed (a failed read is a change to lastError), and were put", unkChanged.length === 3 && unkRig.puts.length === 3);
  const throwRig = rig([submitted(), confirmed()], { landed: new Error("rpc exploded"), drop: new Error("rpc exploded") });
  const thrown = await settleOnce(throwRig.deps);
  ok(
    "a reader that throws is recorded as a failed read, never acted on",
    thrown.length === 2 && thrown.every((r) => r.lastError === "could not read the escrow" && r.nextCheckAt === throwRig.clock.now + MIN) && [...throwRig.store.values()].map((r) => r.phase).sort().join() === "confirmed,uncertain" && [...throwRig.store.values()].find((r) => r.phase === "confirmed")!.status === "pending",
  );

  // The loop reaching the same verdicts as the state machine.
  const landRig = rig([submitted(), uncertain()], { landed: true });
  const landed = await settleOnce(landRig.deps);
  ok("landed true confirms submitted and uncertain records through the loop", landed.length === 2 && landed.every((r) => r.phase === "confirmed" && r.status === "pending"));
  const lateRig = rig([submitted({ retrySafeAfter: N - L.CLOCK_MARGIN_MS - 1 })], { landed: false });
  const late1 = await settleOnce(lateRig.deps);
  lateRig.clock.now += MIN;
  const late = await settleOnce(lateRig.deps);
  ok("landed false past the deadline twice, a minute apart, fails the record", late1[0]?.phase === "uncertain" && late[0]?.phase === "failed" && lateRig.landed.length === 2);
  ok("  ...which is then not read again, not even with force, until its one last check", (await settleOnce(lateRig.deps, { force: true })).length === 0 && lateRig.landed.length === 2);
  lateRig.clock.now = late[0]!.recheckAt!;
  const last = await settleOnce(lateRig.deps);
  ok("  ...that check reads the escrow once more; still empty, the failure is final and never read again", last[0]?.phase === "failed" && !("recheckAt" in last[0]!) && lateRig.landed.length === 3);
  lateRig.clock.now += DAY;
  ok("  ...(a day later: nothing is read)", (await settleOnce(lateRig.deps, { force: true })).length === 0 && lateRig.landed.length === 3);
  const lateFound = rig([failed({ recheckAt: N - 1, retrySafeAfter: N - HOUR })], { landed: true });
  const found = await settleOnce(lateFound.deps);
  ok("a failed link found in the escrow at its last check comes back as a link: confirmed / pending", found[0]?.phase === "confirmed" && found[0]?.status === "pending" && !("failReason" in found[0]!));
  const earlyRig = rig([submitted({ retrySafeAfter: N + HOUR })], { landed: false });
  const early = await settleOnce(earlyRig.deps);
  ok("landed false before the deadline keeps it open as uncertain", early[0]?.phase === "uncertain");
  const settledRig = rig([confirmed()], { drop: "settled" });
  const settledOut = await settleOnce(settledRig.deps);
  ok("a settled drop through the loop reads Claimed (no take-back asked for)", settledOut[0]?.status === "claimed");
  const settledRigR = rig([confirmed({ reclaimOpenAt: N - 1 })], { drop: "settled" });
  ok("  ...and Closed when a take-back of ours never got its answer", (await settleOnce(settledRigR.deps))[0]?.status === "closed");

  // The answer lands on the record as stored when the read finishes, not on the pass's snapshot.
  const raceRec = confirmed();
  const raceRig = rig([raceRec], { drop: "settled" });
  const realDrop = raceRig.deps.dropStatus;
  raceRig.deps.dropStatus = async (linkHex, sender, net) => {
    // A take-back starts while this read is on the wire.
    const cur = raceRig.store.get(linkHex)!;
    raceRig.store.set(linkHex, { ...cur, reclaimAttemptAt: N });
    return realDrop(linkHex, sender, net);
  };
  const raceAfter = await settleOnce(raceRig.deps);
  ok("a take-back written during the read is not overwritten by the pass, and the settled read then says Closed", raceAfter[0]?.reclaimAttemptAt === N && raceAfter[0]?.status === "closed");
  const goneRig = rig([uncertain()], { landed: false });
  const realLanded = goneRig.deps.landed;
  goneRig.deps.landed = async (linkHex, sender, net) => {
    goneRig.store.delete(linkHex); // "Forget this account" while the read was out
    return realLanded(linkHex, sender, net);
  };
  ok("a record forgotten during the read is not written back", (await settleOnce(goneRig.deps)).length === 0 && goneRig.store.size === 0 && goneRig.puts.length === 0);
  const ownRig = rig([confirmed({ contract: "COLD" })], { drop: "pending" });
  await settleOnce(ownRig.deps);
  ok("a record made on another escrow is read on that escrow", ownRig.drops[0]?.net.contract === "COLD");

  // only / force / the boundary
  const trio = [uncertain({ nextCheckAt: N - 3 }), uncertain({ nextCheckAt: N - 2 }), uncertain({ nextCheckAt: N - 1 })];
  const onlyRig = rig(trio, { landed: false });
  await settleOnce(onlyRig.deps, { only: trio[1]!.linkHex });
  ok("`only` limits the pass to that one link", onlyRig.landed.length === 1 && onlyRig.landed[0]!.linkHex === trio[1]!.linkHex);
  const noneRig = rig(trio, { landed: false });
  await settleOnce(noneRig.deps, { only: hexId(999_999) });
  ok("  ...an id that is not there reads nothing; an id that is final reads nothing", noneRig.landed.length === 0 && (await settleOnce(rig([claimed()]).deps, { only: "x" })).length === 0);
  const forceRig = rig([uncertain({ nextCheckAt: N + HOUR })], { landed: false });
  await settleOnce(forceRig.deps);
  const notForced = forceRig.landed.length;
  await settleOnce(forceRig.deps, { force: true });
  ok("force ignores nextCheckAt; without it a record not yet due is left alone", notForced === 0 && forceRig.landed.length === 1);
  const edgeRig = rig([uncertain({ nextCheckAt: N + 1 })], { landed: false, now: N });
  await settleOnce(edgeRig.deps);
  edgeRig.clock.now = N + 1;
  await settleOnce(edgeRig.deps);
  ok("  ...the boundary: due at nextCheckAt exactly, not a ms before", edgeRig.landed.length === 1);
  const onlyForce = rig([confirmed({ nextCheckAt: N + HOUR }), confirmed({ nextCheckAt: N + HOUR })], { drop: "pending" });
  await settleOnce(onlyForce.deps, { force: true, only: onlyForce.store.keys().next().value as string });
  ok("  ...and `only` with `force` together read exactly the one", onlyForce.drops.length === 1);

  // put only what changed
  const steady = without(uncertain({ lastCheckedAt: N, nextCheckAt: N + MIN }), "lastError");
  const steadyRig = rig([steady, uncertain({ nextCheckAt: N - 5 })], { landed: false, now: N });
  const steadyChanged = await settleOnce(steadyRig.deps, { force: true });
  ok(
    "a record the read left exactly as it was is not written; one that changed is",
    steadyRig.landed.length === 2 && steadyChanged.length === 1 && steadyRig.puts.length === 1 && steadyRig.puts[0]!.linkHex !== steady.linkHex,
    `${steadyRig.puts.length} puts`,
  );
  ok("  ...the returned list is exactly the records that were put", same(steadyChanged, steadyRig.puts));

  // It never sends anything.
  ok("the whole settle section made no network request and called no sender", fetchCalls === 0, `${fetchCalls} fetches`);
  ok("anyOpen: true while any record is not final; false for none or all final", anyOpen([claimed(), uncertain()]) && !anyOpen([claimed(), failed(), reclaimed()]) && !anyOpen([]));
  ok("  ...a failed link that still owes its last check keeps the loop running", anyOpen([failed({ recheckAt: N + HOUR })]));

  /* ---------------------------------------- [i] ---------------------------------------- */
  section("i", "runReclaim: taking an expired link back");
  const { runReclaim } = await import("../src/background/reclaim");
  const { ExtError, MESSAGES } = await import("../src/lib/errors");
  const ARROW = "\u2192";

  interface RRig {
    deps: Parameters<typeof runReclaim>[0];
    store: Map<string, LinkRecord>;
    log: string[];
    puts: LinkRecord[];
    reclaimArgs: unknown[];
  }
  /** `prePost`: the fake fails before the take-back is posted (it never calls onPosting). */
  function rrig(
    rec: LinkRecord | null,
    o: { drop?: "pending" | "settled" | "unknown"; reclaim?: () => Promise<{ hash: string; confirmed?: boolean }>; signerError?: Error; now?: number; prePost?: boolean } = {},
  ): RRig {
    const store = new Map<string, LinkRecord>(rec ? [[rec.linkHex, structuredClone(rec)]] : []);
    const log: string[] = [];
    const puts: LinkRecord[] = [];
    const reclaimArgs: unknown[] = [];
    const signer = { kind: "local-ed25519", publicKey: () => SENDER, sign: async (t: unknown) => t } as unknown as Signer;
    const out: RRig = {
      store,
      log,
      puts,
      reclaimArgs,
      deps: {
        now: () => o.now ?? E + HOUR,
        get: async (hx) => (store.has(hx) ? structuredClone(store.get(hx)!) : null),
        put: async (r) => {
          log.push(`put:${r.phase}/${r.status ?? "-"}${r.reclaimAttemptAt ? "/attempt" : ""}`);
          puts.push(structuredClone(r));
          store.set(r.linkHex, structuredClone(r));
        },
        netConfig: (id) => NETS[id],
        signer: async (pk) => {
          log.push(`signer:${pk === SENDER ? "sender" : pk}`);
          if (o.signerError) throw o.signerError;
          return signer;
        },
        dropStatus: async () => {
          log.push("dropStatus");
          return o.drop ?? "pending";
        },
        reclaim: async (args) => {
          log.push("reclaim");
          reclaimArgs.push(args);
          if (!o.prePost) args.onPosting?.();
          return (o.reclaim ?? (async () => ({ hash: HASH })))();
        },
      },
    };
    return out;
  }
  const codeOf = (r: { value: unknown } | { error: unknown }): string => ("error" in r ? (r.error instanceof ExtError ? r.error.code : `non-ExtError: ${String(r.error)}`) : "returned");

  const expired = () => confirmed({ nextCheckAt: undefined });
  const missing = rrig(null);
  ok("an unknown link id is not-found, and nothing else is touched", codeOf(await outcome(runReclaim(missing.deps, hexId(424242)))) === "not-found" && missing.log.length === 0);

  const young = rrig(confirmed(), { now: E - 1 });
  ok("before the expiry: not-reclaimable, and no key is asked for", codeOf(await outcome(runReclaim(young.deps, [...young.store.keys()][0]!))) === "not-reclaimable" && !young.log.some((l) => l.startsWith("signer") || l === "reclaim"));

  const raced = rrig(expired(), { drop: "settled" });
  const racedOut = await outcome(runReclaim(raced.deps, [...raced.store.keys()][0]!));
  ok(
    "the escrow is read first: a link claimed a minute ago is reported as claimed, and no take-back is attempted",
    codeOf(racedOut) === "not-reclaimable" && "error" in racedOut && /claimed/i.test((racedOut.error as Error).message) && [...raced.store.values()][0]!.status === "claimed" && !raced.log.includes("reclaim") && !raced.log.some((l) => l.startsWith("signer")),
  );

  for (const [label, rec] of [["uncertain", uncertain()], ["submitted", submitted()], ["failed", failed()]] as const) {
    const t = rrig(rec);
    ok(`a ${label} record cannot be taken back, and nothing is signed`, codeOf(await outcome(runReclaim(t.deps, rec.linkHex))) === "not-reclaimable" && !t.log.includes("reclaim") && !t.log.some((l) => l.startsWith("signer")));
  }

  const good2 = rrig(expired());
  const goodId = [...good2.store.keys()][0]!;
  const goodOut = await outcome(runReclaim(good2.deps, goodId));
  const goodRec = "value" in goodOut ? goodOut.value : null;
  ok("success: the record reads reclaimed, with the take-back's hash and no more reads", goodRec?.status === "reclaimed" && goodRec.reclaimHash === HASH && !("nextCheckAt" in goodRec) && L.isFinal(goodRec));
  const iAttempt = good2.log.findIndex((l) => l.endsWith("/attempt"));
  ok("  ...the attempt is on file BEFORE the sponsor is asked (a dead worker still leaves 'we asked')", iAttempt >= 0 && iAttempt < good2.log.indexOf("reclaim"), good2.log.join(" > "));
  ok("  ...the sender's key is requested for the record's sender, after the escrow was read", good2.log.indexOf("dropStatus") < good2.log.indexOf("signer:sender") && good2.log.indexOf("signer:sender") < iAttempt);
  const ra = good2.reclaimArgs[0] as { linkHex: string; sponsorUrl: string; group: boolean; net: NetworkConfig };
  ok("  ...reclaim gets this link's id, its network's sponsor, group false and that network's config object", ra.linkHex === goodId && ra.sponsorUrl === NETS.testnet.sponsorUrl && ra.group === false && ra.net === NETS.testnet);
  const mainRec = confirmed({ net: "public" });
  const mainRig = rrig(mainRec);
  await runReclaim(mainRig.deps, mainRec.linkHex);
  ok("  ...a mainnet record goes to the mainnet sponsor", (mainRig.reclaimArgs[0] as { sponsorUrl: string }).sponsorUrl === NETS.public.sponsorUrl);

  const lockedRig = rrig(expired(), { signerError: new ExtError("locked", MESSAGES.locked) });
  const lockedOut = await outcome(runReclaim(lockedRig.deps, [...lockedRig.store.keys()][0]!));
  ok("a locked key stops it before any attempt is recorded", codeOf(lockedOut) === "locked" && ![...lockedRig.store.values()][0]!.reclaimAttemptAt && !lockedRig.log.includes("reclaim"));

  const failures: [string, string, string, boolean, boolean?][] = [
    ["a failed simulation", "reclaim simulation failed: HostError: Error(Contract, #5)", "sponsor-refused", true, true],
    // Before the take-back was posted nothing can have moved, whatever the error says.
    ["the network unreachable before anything was posted", "fetch failed", "offline", true, true],
    ["the key could not sign it (nothing posted)", "the signer refused", "internal", true, true],
    ["a 403 from the pilot gate", `/v2-reclaim ${ARROW} 403: {"error":"this wallet is not on the pilot allowlist yet"}`, "sponsor-refused", true],
    ["a 429", `/v2-reclaim ${ARROW} 429: {"error":"rate limit"}`, "rate-limited", true],
    // A 503 is read by the sponsor's own sentence, never by the status (D3).
    ["a 503 halt (the Worker's own words)", `/v2-reclaim ${ARROW} 503: {"error":"sponsor temporarily halted"}`, "halted", true],
    ["a 503 busy network (nothing was queued)", `/v2-reclaim ${ARROW} 503: {"error":"the network is busy; try again shortly"}`, "network-busy", true],
    ["a 503 in words the sponsor does not refuse with", `/v2-reclaim ${ARROW} 503: {"error":"paused"}`, "uncertain", false],
    ["the day's fee budget (a 400 raised before the sponsor signs)", `/v2-reclaim ${ARROW} 400: {"error":"today's sponsor fee budget is spent; try again tomorrow"}`, "day-limit", true],
    // The status alone proves nothing: a platform page in place of the sponsor's JSON may come after the submit.
    ["a 503 platform page (not the sponsor's JSON)", `/v2-reclaim ${ARROW} 503: <html>Error 1102</html>`, "uncertain", false],
    ["a 429 with no body", `/v2-reclaim ${ARROW} 429: `, "uncertain", false],
    ["a 400 (the mainnet redaction)", `/v2-reclaim ${ARROW} 400: {"error":"request failed","ref":"1a2b3c4d"}`, "uncertain", false],
    ["a 500", `/v2-reclaim ${ARROW} 500: boom`, "uncertain", false],
    ["a dropped connection", "fetch failed", "uncertain", false],
  ];
  for (const [label, message, code, definite, prePost] of failures) {
    const t = rrig(expired(), { prePost, reclaim: async () => { throw new Error(message); } });
    const id = [...t.store.keys()][0]!;
    const res = await outcome(runReclaim(t.deps, id));
    const after = t.store.get(id)!;
    ok(
      `${label}: ${code}, and the attempt is ${definite ? "forgotten (nothing was submitted)" : "marked open for good (it may have landed)"}`,
      codeOf(res) === code &&
        after.reclaimAttemptAt === undefined &&
        (definite ? after.reclaimOpenAt === undefined : after.reclaimOpenAt !== undefined) &&
        after.status === "pending" &&
        after.phase === "confirmed",
      `${codeOf(res)} open=${String(after.reclaimOpenAt)}`,
    );
    const later = L.onDropRead(after, "settled", E + DAY);
    ok(`  ...so if the escrow then says settled, the record reads ${definite ? "Claimed" : "Closed (claimed or taken back)"}`, later.status === (definite ? "claimed" : "closed"), String(later.status));
  }
  const refused = rrig(expired(), { reclaim: async () => { throw new Error(`/v2-reclaim ${ARROW} 403: {"error":"this wallet is not on the pilot allowlist yet"}`); } });
  const refusedOut = await outcome(runReclaim(refused.deps, [...refused.store.keys()][0]!));
  ok("a 403 carries the sponsor's own sentence and says nothing moved", "error" in refusedOut && /not on the pilot allowlist yet/.test((refusedOut.error as Error).message) && /Nothing moved/.test((refusedOut.error as Error).message));
  const unsure = rrig(expired(), { reclaim: async () => { throw new Error(`/v2-reclaim ${ARROW} 500: boom`); } });
  const unsureOut = await outcome(runReclaim(unsure.deps, [...unsure.store.keys()][0]!));
  ok("an uncertain take-back tells the person it keeps checking, and does not claim to have failed", "error" in unsureOut && /keep checking/.test((unsureOut.error as Error).message) && !/Nothing moved/.test((unsureOut.error as Error).message));
  ok("an uncertain take-back is asked for once: one reclaim call, no retry", unsure.log.filter((l) => l === "reclaim").length === 1);

  // The sponsor's 202 (SOW 2, D3): accepted by the network, not yet seen landing. It is NOT a landed
  // take-back: the record stays open for the settle pass, exactly like an uncertain failure.
  const accepted = rrig(expired(), { reclaim: async () => ({ hash: HASH, confirmed: false }) });
  const acceptedId = [...accepted.store.keys()][0]!;
  const acceptedOut = await outcome(runReclaim(accepted.deps, acceptedId));
  const acceptedRec = accepted.store.get(acceptedId)!;
  ok(
    "a 202 take-back (confirmed:false) is uncertain, keeps the record open and is not marked reclaimed",
    codeOf(acceptedOut) === "uncertain" && acceptedRec.status === "pending" && acceptedRec.reclaimOpenAt !== undefined && acceptedRec.reclaimHash === undefined,
    `${codeOf(acceptedOut)} status=${String(acceptedRec.status)}`,
  );
  ok("  ...and says it keeps checking", "error" in acceptedOut && /keep checking/.test((acceptedOut.error as Error).message));
  ok("  ...and if the escrow then says settled, it reads Closed (claimed or taken back), never Reclaimed on the sponsor's word", L.onDropRead(acceptedRec, "settled", E + DAY).status === "closed");

  globalThis.fetch = realFetch;
}

run("LINKS", "link records (state machine, settle pass, take-back)", main);
