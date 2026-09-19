/**
 * POST /events — the claim→first-send funnel beacon.
 * ============================================================================
 *
 * WHAT WAS WRONG WITH IT. Two things, and the second one mattered more.
 *
 *   1. IT WROTE TO STDOUT AND NOTHING ELSE. Worker logs are a live tail, not a store: unless
 *      somebody happened to be watching `wrangler tail` at that second, the event was gone. So the
 *      funnel could be observed and never counted, which is the same as not being measured.
 *
 *   2. THE TWO HALVES COULD NOT BE JOINED. Claim events carried a hashed CLAIM id; send events
 *      carried a hashed ACCOUNT. Different id spaces, so the data could answer "how many claims"
 *      and "how many sends" but never "did the same person do both" — which is the actual question,
 *      and the one this period exists to answer (H3). Every claim also creates an account, so the
 *      account was available at claim time all along; it simply was not sent.
 *
 * WHAT IT DOES NOW. Every event carries its own id as before (`cid`), and any event that happens
 * for a known account also carries that account, hashed, as `aid`. `aid` is one id space across the
 * whole funnel, so claimed→sent is a set intersection rather than a guess.
 *
 * WHAT IT STILL REFUSES TO CARRY. No URL, no #fragment, no address, no email — see
 * apps/web/lib/events.ts (owner caveat C2). `aid` is SHA-256 truncated to 8 bytes: enough to tell
 * two accounts apart, not enough to reverse into one. A Stellar address is public data anyway; what
 * would be careless is joining it to behaviour, which is exactly why it arrives pre-hashed and the
 * server never sees the address it came from.
 *
 * COUNTERS, NOT EVENT ROWS. This stores tallies — per-day and all-time per event, plus sets of
 * account ids for the funnel. It deliberately does not keep an event log: a log of what individual
 * people did is a liability that needs a retention policy and a deletion story, and the questions
 * this has to answer are all aggregate. Daily keys expire after 180 days; the funnel sets do not,
 * because a claim in March and a send in August is precisely the retention the funnel is about.
 *
 * MEASUREMENT FIXES 2026-09-18 (pre-hackathon, decision register D21; PRO_HACKATHON_SCALE.md 5.2).
 * Four numbers the event's traction slide needs were either wrong or missing, and each fix is a
 * counter or a set, never a per-person row:
 *   - REFERRAL on its own. `funnel.both` mixed "became a sender" with "cashed out". The referral
 *     set holds only accounts that created a link, so `funnel.referral` = claimed ∩ referral is
 *     the honest "recipient became a sender" figure. `acted`/`both` stay, labelled as the mixed
 *     "did anything with the money" figure.
 *   - BANK CASH-OUT separately. `cashout_bank_sent` (the SEP-6 anchor leg, what judges weigh) is
 *     distinct from `cashout_sent` (dollars sent to an exchange address). Both count as acting.
 *   - CLAIM DURATION as buckets. The web sends `dur` (whole seconds, claim opened to claim
 *     succeeded, measured on the device) and it is counted into five buckets. No timestamps are
 *     stored, so no per-person timing exists anywhere.
 *   - REPEATS. Every value event adds the account to the `valued` set; the second time the same
 *     account arrives it is added to the `repeat` set. "Second action" is then a count of people.
 *   - SEEDED COHORT. A link the team funded for the event carries a public `seeded=1` marker and
 *     the claim beacons carry `seeded`. Seeded claims are counted in their own totals and their own
 *     claimed set, so seeded referral and seeded acted are intersections, and organic = total minus
 *     seeded. Seeded activity NEVER counts toward H3 (sender adoption); the summary separates it so
 *     nobody has to remember that by hand.
 *   - TEAM EXCLUSION. `EVENTS_EXCLUDE_AIDS` (comma-separated hashed account ids; compute one with
 *     `pnpm --filter @lumenia/sponsor aid G...`) drops every event those accounts send, before any
 *     counter is touched. Events with no account (`claim_opened`) cannot be excluded this way.
 *   - NEW EVENTS for the event build: `deposit_started` / `deposit_completed` (TRY in over SEP-6),
 *     `cctp_funded` (Circle CCTP inbound), `wallet_funded` (Stellar Wallets Kit), and
 *     `link_shared` (the share or copy button, vs merely creating a link).
 */
import { kvConfigFromEnv } from "./rate-limit.js";

const ALLOWED_EVENTS = new Set<string>([
  "claim_opened",
  "claim_succeeded",
  "claim_failed",
  "send_started",
  "send_link_created",
  // The share sheet or the copy button on a ready link: a link that was CREATED is not
  // necessarily one that was SENT, and the gap is the send flow's own drop-off. Carries the
  // hashed account. Must stay in step with apps/web/lib/events.ts.
  "link_shared",
  // request money — all three carry the hashed request NONCE (one joinable id
  // space; see apps/web/lib/events.ts). Must stay in step with that file.
  "request_created",
  "request_opened",
  "request_paid",
  // Cash-out intent — a recipient tapping "how to turn dollars into local money".
  // Measures off-ramp demand vs. hold-dollars behavior. Carries the hashed account.
  // Must stay in step with apps/web/lib/events.ts.
  "cashout_guide_opened",
  // The off-ramp step actually TAKEN — dollars sent out to an exchange deposit
  // address (/send-out). Paired with cashout_guide_opened it separates people who
  // read about cashing out from people who did it. Carries the hashed account.
  // Must stay in step with apps/web/lib/events.ts.
  "cashout_sent",
  // The same step through the SEP-6 anchor (/send-out/bank): lira on a bank rail, which is the
  // leg the hackathon jury weighs. Kept apart from cashout_sent so the anchor leg has its own
  // number. Carries the hashed account.
  "cashout_bank_sent",
  // TRY in over SEP-6 (the deposit screen, built at the event): a deposit opened, and one the
  // anchor completed on chain. Carry the hashed account.
  "deposit_started",
  "deposit_completed",
  // A link account funded from another chain via Circle CCTP (relayed by the sponsor).
  "cctp_funded",
  // A link funded by an external Stellar wallet through Stellar Wallets Kit.
  "wallet_funded",
]);

/** The two funnel stages, by the event that proves the person reached them. */
const FUNNEL_IN = "claim_succeeded";
/** "Acted": did anything with the money. Mixed on purpose; the referral set is the pure one. */
const FUNNEL_OUT = new Set(["send_link_created", "cashout_sent", "cashout_bank_sent"]);
/** "Referral": the recipient became a SENDER. This is the H3-relevant set, and only this one. */
const REFERRAL_EVENT = "send_link_created";
/**
 * Every event that moves value for a known account. The first one puts the account into `valued`;
 * the second puts it into `repeat`. Funding events count: a person who claimed and then topped up
 * with their own money took a second action, which is exactly the signal the growth team asked for.
 */
const VALUE_EVENTS = new Set([...FUNNEL_OUT, "deposit_completed", "cctp_funded", "wallet_funded"]);

/**
 * Claim duration buckets, in whole seconds from `claim_opened` to `claim_succeeded` as measured on
 * the recipient's device. The 60 s line is the pre-registered H1/H2 bar ("median under 60 s open to
 * balance"); the others give the shape around it. A bucket is a counter; there is no row per claim.
 */
export const DURATION_BUCKETS = ["0-15", "15-30", "30-60", "60-120", "120+"] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];
const MAX_DURATION_S = 24 * 60 * 60;

export function durationBucket(seconds: number): DurationBucket {
  if (seconds < 15) return "0-15";
  if (seconds < 30) return "15-30";
  if (seconds < 60) return "30-60";
  if (seconds < 120) return "60-120";
  return "120+";
}

/** A hashed id is 16 lowercase hex characters. Anything else is not one of ours. */
const HASH_RE = /^[0-9a-f]{1,32}$/;

const DAY_TTL_SECONDS = 180 * 24 * 60 * 60;

export interface EventInput {
  event?: string;
  /** hashed id for this event's own subject — a claim, a request nonce, an account */
  cid?: string;
  /** hashed ACCOUNT, when one exists. One id space across the funnel. */
  aid?: string;
  /** the link this event belongs to was funded by the team for the event (public `seeded=1`). */
  seeded?: unknown;
  /** `claim_succeeded` only: whole seconds since the claim was opened, measured on the device. */
  dur?: unknown;
}

function net(): string {
  return process.env.STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

/** UTC day. Deliberately not the server's local day: two Workers must agree on the key. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.slice(0, 32).toLowerCase();
  return HASH_RE.test(s) ? s : null;
}

/** `seeded` arrives as `1`, `"1"` or `true` from a beacon; anything else is not seeded. */
function isSeeded(v: unknown): boolean {
  return v === 1 || v === "1" || v === true;
}

/** A duration is a non-negative whole number of seconds inside one day; anything else is ignored. */
function cleanDuration(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > MAX_DURATION_S) return null;
  return Math.floor(n);
}

/**
 * Hashed account ids whose events are dropped before any counter is touched: the team's own
 * accounts, so a demo run never reads as a stranger's. Read per call so a `wrangler` var change
 * needs no code change. Compute an id with `pnpm --filter @lumenia/sponsor aid <G...>`.
 */
export function excludedAids(): Set<string> {
  return new Set(
    (process.env.EVENTS_EXCLUDE_AIDS ?? "")
      .split(",")
      .map((s) => clean(s.trim()))
      .filter((s): s is string => s !== null),
  );
}

/**
 * Validate + log. Kept SYNCHRONOUS and unchanged in shape, because the route calls it inside a
 * try/catch and answers 200 regardless: a beacon must never be able to fail a request.
 */
export function handleEvent(input: EventInput): { ok: true } {
  if (!input.event || !ALLOWED_EVENTS.has(input.event)) {
    throw new Error("unknown event");
  }
  console.log(
    `[event] ${JSON.stringify({
      event: input.event,
      cid: clean(input.cid),
      aid: clean(input.aid),
      ...(isSeeded(input.seeded) ? { seeded: 1 } : {}),
    })}`,
  );
  return { ok: true };
}

/** For tests and tooling: the names the sponsor accepts, in declaration order. */
export function allowedEvents(): string[] {
  return [...ALLOWED_EVENTS];
}

async function kvPipeline(commands: string[][]): Promise<unknown[] | null> {
  const kv = kvConfigFromEnv();
  if (!kv) return null;
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as { result?: unknown }[];
  return rows.map((r) => r?.result);
}

/**
 * The durable half. Called from `ctx.waitUntil`, so a slow or unreachable store delays nobody and
 * fails nothing — an event that cannot be counted is a missing number, never a broken claim.
 */
export async function recordEvent(input: EventInput): Promise<void> {
  if (!input.event || !ALLOWED_EVENTS.has(input.event)) return;
  const n = net();
  const day = today();
  const aid = clean(input.aid);
  const seeded = isSeeded(input.seeded);
  if (aid && excludedAids().has(aid)) return;

  const cmds: string[][] = [
    ["INCR", `ev:${n}:d:${day}:${input.event}`],
    ["EXPIRE", `ev:${n}:d:${day}:${input.event}`, String(DAY_TTL_SECONDS)],
    ["INCR", `ev:${n}:t:${input.event}`],
    ["SADD", `ev:${n}:days`, day],
  ];
  // Seeded activity is counted AGAIN under its own prefix, so the organic figure is a subtraction
  // and the seeded figure never has to be reconstructed from memory.
  if (seeded) {
    cmds.push(["INCR", `ev:${n}:s:t:${input.event}`]);
    cmds.push(["INCR", `ev:${n}:s:d:${day}:${input.event}`]);
    cmds.push(["EXPIRE", `ev:${n}:s:d:${day}:${input.event}`, String(DAY_TTL_SECONDS)]);
  }
  if (input.event === FUNNEL_IN) {
    const dur = cleanDuration(input.dur);
    if (dur !== null) cmds.push(["INCR", `ev:${n}:dur:${durationBucket(dur)}`]);
  }
  // The funnel is unique ACCOUNTS, not event counts: somebody who sends three links is one person
  // who reached the second stage, and counting them three times would flatter the number.
  let valuedAt = -1;
  if (aid) {
    if (input.event === FUNNEL_IN) {
      cmds.push(["SADD", `evf:${n}:claimed`, aid]);
      if (seeded) cmds.push(["SADD", `evf:${n}:s:claimed`, aid]);
    }
    if (FUNNEL_OUT.has(input.event)) cmds.push(["SADD", `evf:${n}:sent`, aid]);
    if (input.event === REFERRAL_EVENT) cmds.push(["SADD", `evf:${n}:referral`, aid]);
    if (VALUE_EVENTS.has(input.event)) {
      valuedAt = cmds.length;
      cmds.push(["SADD", `evf:${n}:valued`, aid]);
    }
  }
  try {
    const rows = await kvPipeline(cmds);
    // SADD answers how many members were NEW. Zero means this account had already moved value
    // once before, which makes this its second action: a person, counted once, in the repeat set.
    if (rows && aid && valuedAt >= 0 && Number(rows[valuedAt]) === 0) {
      await kvPipeline([["SADD", `evf:${n}:repeat`, aid]]);
    }
  } catch {
    /* a number we failed to write is not a reason to fail anything else */
  }
}

export interface EventsSummary {
  network: string;
  totals: Record<string, number>;
  days: string[];
  funnel: {
    /** accounts that completed a claim */
    claimed: number;
    /** accounts that later moved money onward — a link, or out to an exchange or a bank rail */
    acted: number;
    /** claimed ∩ acted: the honest claim→any-second-action number (mixed; see `referral`) */
    both: number;
    /** both / claimed, or null when there is nothing to divide */
    rate: number | null;
    /** claimed ∩ created a link: the recipient BECAME A SENDER. The H3-relevant figure. */
    referral: number;
    /** referral / claimed, or null */
    referralRate: number | null;
    /** accounts with at least two value events (a second action), whether or not they claimed */
    repeat: number;
  };
  /**
   * The team-funded cohort, on its own. Everything here is a subset of the figures above, so
   * `organic` is the subtraction and it is spelled out rather than left to the reader.
   */
  seeded: {
    totals: Record<string, number>;
    claimed: number;
    referral: number;
    acted: number;
  };
  organic: {
    claimed: number;
    referral: number;
    acted: number;
  };
  /** claim_opened → claim_succeeded, whole seconds, counted into buckets; never per person */
  durations: Record<DurationBucket, number>;
  /** how many team accounts are configured to be dropped (their count, never their ids) */
  excludedAccounts: number;
}

/**
 * Read the tallies. Aggregate only — there is nothing per-person to return, by construction.
 */
export async function eventsSummary(): Promise<EventsSummary | null> {
  const n = net();
  const names = [...ALLOWED_EVENTS];
  const rows = await kvPipeline([
    ...names.map((e) => ["GET", `ev:${n}:t:${e}`]),
    ...names.map((e) => ["GET", `ev:${n}:s:t:${e}`]),
    ...DURATION_BUCKETS.map((b) => ["GET", `ev:${n}:dur:${b}`]),
    ["SMEMBERS", `ev:${n}:days`],
    ["SCARD", `evf:${n}:claimed`],
    ["SCARD", `evf:${n}:sent`],
    ["SINTER", `evf:${n}:claimed`, `evf:${n}:sent`],
    ["SINTER", `evf:${n}:claimed`, `evf:${n}:referral`],
    ["SCARD", `evf:${n}:repeat`],
    ["SCARD", `evf:${n}:s:claimed`],
    ["SINTER", `evf:${n}:s:claimed`, `evf:${n}:referral`],
    ["SINTER", `evf:${n}:s:claimed`, `evf:${n}:sent`],
  ]);
  if (!rows) return null;

  let i = 0;
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const len = (v: unknown) => ((v as string[] | null) ?? []).length;

  const totals: Record<string, number> = {};
  names.forEach((e) => {
    totals[e] = num(rows[i++]);
  });
  const seededTotals: Record<string, number> = {};
  names.forEach((e) => {
    seededTotals[e] = num(rows[i++]);
  });
  const durations = {} as Record<DurationBucket, number>;
  DURATION_BUCKETS.forEach((b) => {
    durations[b] = num(rows[i++]);
  });
  const days = (rows[i++] as string[] | null) ?? [];
  const claimed = num(rows[i++]);
  const acted = num(rows[i++]);
  const both = len(rows[i++]);
  const referral = len(rows[i++]);
  const repeat = num(rows[i++]);
  const seededClaimed = num(rows[i++]);
  const seededReferral = len(rows[i++]);
  const seededActed = len(rows[i++]);

  return {
    network: n,
    totals,
    days: days.slice().sort(),
    funnel: {
      claimed,
      acted,
      both,
      rate: claimed > 0 ? both / claimed : null,
      referral,
      referralRate: claimed > 0 ? referral / claimed : null,
      repeat,
    },
    seeded: { totals: seededTotals, claimed: seededClaimed, referral: seededReferral, acted: seededActed },
    organic: {
      claimed: claimed - seededClaimed,
      referral: referral - seededReferral,
      acted: both - seededActed,
    },
    durations,
    excludedAccounts: excludedAids().size,
  };
}
