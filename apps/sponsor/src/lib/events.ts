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
 * COUNTERS, NOT EVENT ROWS. This stores tallies — per-day and all-time per event, plus two sets of
 * account ids for the funnel. It deliberately does not keep an event log: a log of what individual
 * people did is a liability that needs a retention policy and a deletion story, and the questions
 * this has to answer are all aggregate. Daily keys expire after 180 days; the funnel sets do not,
 * because a claim in March and a send in August is precisely the retention the funnel is about.
 */
import { kvConfigFromEnv } from "./rate-limit.js";

const ALLOWED_EVENTS = new Set<string>([
  "claim_opened",
  "claim_succeeded",
  "claim_failed",
  "send_started",
  "send_link_created",
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
]);

/** The two funnel stages, by the event that proves the person reached them. */
const FUNNEL_IN = "claim_succeeded";
const FUNNEL_OUT = new Set(["send_link_created", "cashout_sent"]);

/** A hashed id is 16 lowercase hex characters. Anything else is not one of ours. */
const HASH_RE = /^[0-9a-f]{1,32}$/;

const DAY_TTL_SECONDS = 180 * 24 * 60 * 60;

export interface EventInput {
  event?: string;
  /** hashed id for this event's own subject — a claim, a request nonce, an account */
  cid?: string;
  /** hashed ACCOUNT, when one exists. One id space across the funnel. */
  aid?: string;
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

/**
 * Validate + log. Kept SYNCHRONOUS and unchanged in shape, because the route calls it inside a
 * try/catch and answers 200 regardless: a beacon must never be able to fail a request.
 */
export function handleEvent(input: EventInput): { ok: true } {
  if (!input.event || !ALLOWED_EVENTS.has(input.event)) {
    throw new Error("unknown event");
  }
  console.log(
    `[event] ${JSON.stringify({ event: input.event, cid: clean(input.cid), aid: clean(input.aid) })}`,
  );
  return { ok: true };
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

  const cmds: string[][] = [
    ["INCR", `ev:${n}:d:${day}:${input.event}`],
    ["EXPIRE", `ev:${n}:d:${day}:${input.event}`, String(DAY_TTL_SECONDS)],
    ["INCR", `ev:${n}:t:${input.event}`],
    ["SADD", `ev:${n}:days`, day],
  ];
  // The funnel is unique ACCOUNTS, not event counts: somebody who sends three links is one person
  // who reached the second stage, and counting them three times would flatter the number.
  if (aid) {
    if (input.event === FUNNEL_IN) cmds.push(["SADD", `evf:${n}:claimed`, aid]);
    if (FUNNEL_OUT.has(input.event)) cmds.push(["SADD", `evf:${n}:sent`, aid]);
  }
  try {
    await kvPipeline(cmds);
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
    /** accounts that later moved money onward — a link, or out to an exchange */
    acted: number;
    /** accounts in both sets: the honest claim→second-action number */
    both: number;
    /** both / claimed, or null when there is nothing to divide */
    rate: number | null;
  };
}

/**
 * Read the tallies. Aggregate only — there is nothing per-person to return, by construction.
 */
export async function eventsSummary(): Promise<EventsSummary | null> {
  const n = net();
  const names = [...ALLOWED_EVENTS];
  const rows = await kvPipeline([
    ...names.map((e) => ["GET", `ev:${n}:t:${e}`]),
    ["SMEMBERS", `ev:${n}:days`],
    ["SCARD", `evf:${n}:claimed`],
    ["SCARD", `evf:${n}:sent`],
    ["SINTER", `evf:${n}:claimed`, `evf:${n}:sent`],
  ]);
  if (!rows) return null;

  const totals: Record<string, number> = {};
  names.forEach((e, i) => {
    totals[e] = Number(rows[i] ?? 0) || 0;
  });
  const days = (rows[names.length] as string[] | null) ?? [];
  const claimed = Number(rows[names.length + 1] ?? 0) || 0;
  const acted = Number(rows[names.length + 2] ?? 0) || 0;
  const both = ((rows[names.length + 3] as string[] | null) ?? []).length;

  return {
    network: n,
    totals,
    days: days.slice().sort(),
    funnel: { claimed, acted, both, rate: claimed > 0 ? both / claimed : null },
  };
}
