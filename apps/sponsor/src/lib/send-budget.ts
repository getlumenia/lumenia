/**
 * SPONSORED-BALANCE BUDGET: how many Claimable Balances the sponsor will reserve for in one UTC day.
 *
 * /send-link makes the sponsor the reserve payer of a Claimable Balance the sender creates: about
 * 1 XLM (two claimants at the base reserve) locked until somebody claims it or the sender takes it
 * back, and returned to the sponsor only then. The escrow caps (lib/caps.ts) bound the DOLLARS in
 * it; nothing bounded the NUMBER of them, and the number is what spends the sponsor's float. The
 * claimant shape is pinned beside this (lib/anti-drain.ts, SEND_RECLAIM_AFTER_MAX_SECONDS), so a
 * balance can always be released by somebody other than the sender; this budget bounds how much of
 * the float can be waiting on that at once. Two counters, as the onboarding budget keeps them: the
 * day's total and the sender's share of it, moved together in one pipeline and given back together.
 *
 * It fails CLOSED where the escrow caps do (CAPS_FAIL_CLOSED=1, which every mainnet deployment sets,
 * and mainnet regardless): a counter that cannot be read refuses the send. A send is value IN, and a
 * refused send costs the sender a retry, never money; the budgets that fail open are the ones on a
 * recipient's way to money already escrowed (lib/caps.ts says why). Off that flag, and in local runs
 * and suites with no store configured, a per-isolate counter holds the same two bounds, so the
 * budget never disappears entirely.
 *
 * Env: MAX_DAY_SENDS (default 200 on testnet, 40 on mainnet, about 40 XLM of reserve in flight at
 * most) and MAX_DAY_SENDS_PER_SENDER (default a fifth of the day with a floor of 10 on testnet, an
 * eighth on mainnet; clamped to the day).
 */
import { kvConfigFromEnv } from "./rate-limit.js";
import { storeFetch } from "./store-fetch.js";

export interface SendBudget {
  /** Largest number of sponsored Claimable Balances in one UTC day, across all senders. */
  maxDaySends: number;
  /** Largest number from ONE sender in that same day. */
  maxDaySenderSends: number;
  /** An unreadable counter refuses the send (true) or counts against the per-isolate counter (false). */
  failClosed: boolean;
}

export interface SendBudgetVerdict {
  ok: boolean;
  reason?: string;
  /** Call this when the send definitely did not happen, to give the day's slot back. */
  release?: () => Promise<void>;
}

const DEFAULT_MAX_DAY_SENDS = 200;
const MAINNET_DEFAULT_MAX_DAY_SENDS = 40;
/** 48h so a bucket outlives its day even with clock skew, then self-cleans (as lib/caps.ts). */
const DAY_KEY_TTL_SECONDS = "172800";

function positiveInt(name: string): number | null {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function sendBudgetFromEnv(network = process.env.STELLAR_NETWORK ?? "testnet"): SendBudget {
  const maxDaySends = positiveInt("MAX_DAY_SENDS") ?? (network === "mainnet" ? MAINNET_DEFAULT_MAX_DAY_SENDS : DEFAULT_MAX_DAY_SENDS);
  const defaultShare = network === "mainnet" ? Math.ceil(maxDaySends / 8) : Math.max(10, Math.ceil(maxDaySends / 5));
  const perSender = positiveInt("MAX_DAY_SENDS_PER_SENDER") ?? defaultShare;
  return {
    maxDaySends,
    maxDaySenderSends: Math.min(perSender, maxDaySends),
    failClosed: network === "mainnet" || process.env.CAPS_FAIL_CLOSED === "1",
  };
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The day's counter of sponsored balances, per network. */
export function sendDayKey(now: number, network = process.env.STELLAR_NETWORK ?? "testnet"): string {
  return `sends:${network}:day:${utcDay(now)}`;
}

/** One sender's share of that day. */
export function senderSendDayKey(now: number, sender: string, network = process.env.STELLAR_NETWORK ?? "testnet"): string {
  return `sends:${network}:day:${utcDay(now)}:sender:${sender}`;
}

type KvConn = { url: string; token: string };
type KvReply = { result?: unknown; error?: string };

/**
 * Move every key by one in one pipeline (INCR or DECR, each with its EXPIRE, as the limiter and the
 * pilot slots move theirs) through `storeFetch` and its deadline; the new totals, in order.
 */
async function addToDays(kv: KvConn, keys: string[], delta: 1 | -1): Promise<number[]> {
  const res = await storeFetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify(keys.flatMap((key) => [[delta > 0 ? "INCR" : "DECR", key], ["EXPIRE", key, DAY_KEY_TTL_SECONDS]])),
  });
  if (!res.ok) throw new Error(`send counter store returned ${res.status}`);
  const replies = (await res.json()) as KvReply[];
  return keys.map((_, i) => {
    const moved = replies[i * 2];
    if (!moved || moved.error) throw new Error(`send counter store error: ${moved?.error}`);
    return Number(moved.result);
  });
}

/* The per-isolate counter: the fallback where the budget is not meant to fail closed. */
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
export function __resetSendBudgetForTests(): void {
  localDay = "";
  local.clear();
}

/**
 * Reserve one sponsored balance for `senderPublicKey` today. On `ok: false` nothing is reserved.
 * On `ok: true` the caller MUST call `release()` if the send definitely did not happen (and must
 * NOT for a submission the network never ruled on, which may still land).
 */
export async function checkSendBudget(budget: SendBudget, senderPublicKey: string, now = Date.now()): Promise<SendBudgetVerdict> {
  const dayKey = sendDayKey(now);
  const keys = [dayKey, senderSendDayKey(now, senderPublicKey.trim())];
  const kv = kvConfigFromEnv();

  let totals: number[];
  let giveBack: () => Promise<void>;
  const degrade = () => {
    totals = addToLocalDays(keys, 1, dayKey);
    giveBack = async () => void addToLocalDays(keys, -1, dayKey);
  };
  if (!kv) {
    if (budget.failClosed) return { ok: false, reason: "the day's send counter is not configured, so no sponsored send is made (fail-closed)" };
    degrade();
  } else {
    try {
      totals = await addToDays(kv, keys, 1);
      giveBack = async () => {
        await addToDays(kv, keys, -1).catch(() => {});
      };
    } catch (e) {
      if (budget.failClosed) {
        return { ok: false, reason: `the day's send counter is unavailable, so no sponsored send is made (fail-closed): ${(e as Error).message}` };
      }
      console.warn(`[send-budget] day counter unavailable, bounding sends per isolate: ${(e as Error).message}`);
      degrade();
    }
  }

  const [dayTotal, senderTotal] = totals!;
  // The sender's own share first: the sentence has to tell the sender that THEY are at a limit.
  if (senderTotal! > budget.maxDaySenderSends) {
    await giveBack!();
    return { ok: false, reason: `your sends today reached the per-sender limit of ${budget.maxDaySenderSends} sponsored balances; try again tomorrow` };
  }
  if (dayTotal! > budget.maxDaySends) {
    await giveBack!();
    return { ok: false, reason: `today's budget of ${budget.maxDaySends} sponsored balances is spent; try again tomorrow` };
  }
  return { ok: true, release: giveBack! };
}
