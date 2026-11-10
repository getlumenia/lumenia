/**
 * MAIL BUDGET: how many emails this service sends in one UTC day, per route, per inbox and in all.
 *
 * One RESEND_API_KEY carries everything: the recovery codes, the problem reports, the pilot asks,
 * AND the watchdog's pages and the owner's approvals. Until this existed every mail-sending route
 * was bounded by its per-IP window alone (the recovery code also by ten an hour per email), so one
 * client could spend the day's quota of the shared key before the watchdog needed it, and a flood
 * at one inbox was a flood. Three counters, moved together in one pipeline and given back together
 * when any of them is over:
 *
 *   route   MAIL_DAY_CAP_RECOVERY_OTP (40), MAIL_DAY_CAP_FEEDBACK (20), MAIL_DAY_CAP_PILOT_REQUEST
 *           (20), MAIL_DAY_CAP_PILOT_INTEREST (10): what each route may send in a day;
 *   target  MAIL_DAY_CAP_TARGET (20): what ONE inbox may receive in a day from all routes together,
 *           keyed by a hash of the normalized address, never the address itself;
 *   total   MAIL_DAY_CAP_TOTAL (80): everything the routes above send in a day, left under the
 *           free tier's hundred so a page or an approval still goes out on a bad day.
 *
 * Attempts are counted, not deliveries: a refusal from Resend keeps its slot, because the refusal
 * that matters is Resend's own rate limit, and giving the slot back would let the caller keep
 * hitting it. The budget decides whether a mail is SENT; what the route answers depends on what
 * the mail is. Where the mail IS the product (the recovery code, lib/recovery-otp.ts) the caller
 * is told both ways: a spent budget is a 429 with MAIL_BUDGET_BODY and no mail, a refusal from
 * Resend a 503 with MAIL_UNAVAILABLE_BODY (that route used to answer 200 to a code that never
 * left, and the person waited for it). Where the mail is a NOTIFICATION beside a record (a
 * problem report, a pilot ask, a waitlist interest) the record is kept, the route answers as it
 * did, and a skipped or refused mail is one log line.
 *
 * The counter never refuses on the store's own availability: no store, or a store that errors,
 * counts against a per-isolate counter with the same three bounds (as the onboarding budget does,
 * lib/caps.ts). The recovery code is on the way back to money, and a store blip must not close it;
 * the per-isolate counter still bounds the outage window. The counters move with INCR/DECR plus
 * EXPIRE, as the limiter and the pilot slots do, through `storeFetch` and its deadline.
 */
import { kvConfigFromEnv } from "./rate-limit.js";
import { storeFetch } from "./store-fetch.js";

export type MailRoute = "recovery-otp" | "feedback" | "pilot-request" | "pilot-interest";

export interface MailBudget {
  route: number;
  target: number;
  total: number;
}

export const MAIL_BUDGET_ERROR = "We've sent as many emails as we can today. Try again tomorrow.";
export const MAIL_BUDGET_BODY = { error: MAIL_BUDGET_ERROR, code: "mail-budget" } as const;
export const MAIL_UNAVAILABLE_ERROR = "We couldn't send the email just now. Try again in a minute.";
export const MAIL_UNAVAILABLE_BODY = { error: MAIL_UNAVAILABLE_ERROR, code: "mail-unavailable" } as const;

/** A route's, an inbox's or the day's mail budget is spent: no mail was sent. The routes answer 429. */
export class MailBudgetExceeded extends Error {
  readonly mailBudget = true;
  constructor(
    readonly route: MailRoute,
    /** Which bound tripped, for the log; the response carries MAIL_BUDGET_ERROR only. */
    readonly bound: "route" | "target" | "total",
  ) {
    super(MAIL_BUDGET_ERROR);
    this.name = "MailBudgetExceeded";
  }
}

export function isMailBudgetExceeded(e: unknown): boolean {
  return e instanceof MailBudgetExceeded || (e as { mailBudget?: boolean } | null | undefined)?.mailBudget === true;
}

/** Resend refused or did not answer: the mail did not leave. The routes answer 503. */
export class MailNotSent extends Error {
  readonly mailNotSent = true;
  constructor(
    readonly label: string,
    /** Resend's HTTP status, or null when the request itself failed. */
    readonly status: number | null,
  ) {
    super(MAIL_UNAVAILABLE_ERROR);
    this.name = "MailNotSent";
  }
}

export function isMailNotSent(e: unknown): boolean {
  return e instanceof MailNotSent || (e as { mailNotSent?: boolean } | null | undefined)?.mailNotSent === true;
}

const DEFAULT_ROUTE_CAPS: Record<MailRoute, number> = {
  "recovery-otp": 40,
  feedback: 20,
  "pilot-request": 20,
  "pilot-interest": 10,
};
const DEFAULT_TARGET_CAP = 20;
const DEFAULT_TOTAL_CAP = 80;
/** 48h so a bucket outlives its day even with clock skew, then self-cleans (as lib/caps.ts). */
const DAY_KEY_TTL_SECONDS = "172800";

function positiveInt(name: string): number | null {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function mailBudgetFromEnv(route: MailRoute): MailBudget {
  const routeEnv = `MAIL_DAY_CAP_${route.toUpperCase().replace(/-/g, "_")}`;
  return {
    route: positiveInt(routeEnv) ?? DEFAULT_ROUTE_CAPS[route],
    target: positiveInt("MAIL_DAY_CAP_TARGET") ?? DEFAULT_TARGET_CAP,
    total: positiveInt("MAIL_DAY_CAP_TOTAL") ?? DEFAULT_TOTAL_CAP,
  };
}

/** The address as the per-inbox counter sees it: trimmed and lowercased, as every mail path stores it. */
export function normalizeMailTarget(email: string): string {
  return email.trim().toLowerCase();
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

type KvConn = { url: string; token: string };
type KvReply = { result?: unknown; error?: string };

/** Move every key by one (INCR or DECR, each with its EXPIRE) in one pipeline; the new totals, in order. */
async function addToDays(kv: KvConn, keys: string[], delta: 1 | -1): Promise<number[]> {
  const res = await storeFetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify(keys.flatMap((key) => [[delta > 0 ? "INCR" : "DECR", key], ["EXPIRE", key, DAY_KEY_TTL_SECONDS]])),
  });
  if (!res.ok) throw new Error(`mail counter store returned ${res.status}`);
  const replies = (await res.json()) as KvReply[];
  return keys.map((_, i) => {
    const moved = replies[i * 2];
    if (!moved || moved.error) throw new Error(`mail counter store error: ${moved?.error}`);
    return Number(moved.result);
  });
}

/* The per-isolate counter: the fallback for no store, or a store that did not answer. */
let localDay = "";
const local = new Map<string, number>();

function addToLocalDays(keys: string[], delta: number, dayMarker: string): number[] {
  if (dayMarker !== localDay) {
    localDay = dayMarker;
    local.clear();
  }
  return keys.map((key) => {
    const next = (local.get(key) ?? 0) + delta;
    local.set(key, next);
    return next;
  });
}

/** Tests only: forget the per-isolate counters. */
export function __resetMailBudgetForTests(): void {
  localDay = "";
  local.clear();
}

export type MailReservation = { ok: true; release: () => Promise<void> } | { ok: false; bound: "route" | "target" | "total" };

/**
 * Reserve one mail from `route` to `target` today. On `ok: false` nothing is reserved and nothing may
 * be sent. On `ok: true` the slot is spent whether or not Resend accepts the mail (see the header);
 * `release` exists for the one case where the caller decides, after reserving, not to send at all.
 */
export async function reserveMail(route: MailRoute, target: string, now = Date.now()): Promise<MailReservation> {
  const budget = mailBudgetFromEnv(route);
  const network = process.env.STELLAR_NETWORK ?? "testnet";
  const day = utcDay(now);
  const prefix = `mail:${network}:${day}`;
  const keys = [`${prefix}:total`, `${prefix}:route:${route}`, `${prefix}:target:${(await sha256Hex(normalizeMailTarget(target))).slice(0, 32)}`];
  const kv = kvConfigFromEnv();

  let totals: number[];
  let giveBack: () => Promise<void>;
  if (!kv) {
    totals = addToLocalDays(keys, 1, prefix);
    giveBack = async () => void addToLocalDays(keys, -1, prefix);
  } else {
    try {
      totals = await addToDays(kv, keys, 1);
      giveBack = async () => {
        await addToDays(kv, keys, -1).catch(() => {});
      };
    } catch (e) {
      console.warn(`[mail-budget] day counter unavailable, bounding mail per isolate: ${(e as Error).message}`);
      totals = addToLocalDays(keys, 1, prefix);
      giveBack = async () => void addToLocalDays(keys, -1, prefix);
    }
  }

  const [total, perRoute, perTarget] = totals;
  // The inbox first, then the route, then the day: the tightest and most personal bound names itself.
  const over: "route" | "target" | "total" | null =
    perTarget! > budget.target ? "target" : perRoute! > budget.route ? "route" : total! > budget.total ? "total" : null;
  if (over) {
    await giveBack();
    return { ok: false, bound: over };
  }
  return { ok: true, release: giveBack };
}

/** Reserve or throw MailBudgetExceeded (logged with the bound that tripped; the response says only that the budget is spent). */
export async function takeMailSlot(route: MailRoute, target: string): Promise<() => Promise<void>> {
  const slot = await reserveMail(route, target);
  if (!slot.ok) {
    console.log(`[mail-budget] ${route}: the ${slot.bound} budget for today is spent; no mail sent`);
    throw new MailBudgetExceeded(route, slot.bound);
  }
  return slot.release;
}

/**
 * POST one mail to Resend's REST API (no SDK; the bundle stays lean). Throws MailNotSent when Resend
 * refuses (any non-2xx) or does not answer, after one log line with the status and the label; the
 * payload (an address, a code) is never logged. `quiet` leaves the log line to the caller, for a
 * caller that writes exactly one line of its own about the mail (the pilot ask does).
 */
export async function postResend(key: string, payload: Record<string, unknown>, label: string, opts: { quiet?: boolean } = {}): Promise<void> {
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    if (!opts.quiet) console.log(`[${label}] resend unreachable: ${(e as Error).message}`);
    throw new MailNotSent(label, null);
  }
  if (!res.ok) {
    if (!opts.quiet) console.log(`[${label}] resend returned ${res.status}`);
    throw new MailNotSent(label, res.status);
  }
}
