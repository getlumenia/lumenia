/**
 * CANARY CAPS — a hard ceiling on how much escrow the sponsor will facilitate.
 *
 * Two independent bounds, both on the USDC amount being escrowed (NOT on the sponsor's own
 * spend — the sponsor never sources value; this bounds the blast radius of an unknown bug in
 * the escrow itself):
 *
 *   1. **Per-drop** — a single send/deposit may not exceed `maxDropStroops`. Enforced locally,
 *      no network, so it can never be disabled by an outage.
 *   2. **Per-day** — the rolling UTC-day total across ALL senders may not exceed
 *      `maxDayStroops`. Backed by the same Upstash store the rate-limiter uses.
 *
 * The per-day counter uses a RESERVE-then-release pattern: the amount is added atomically
 * (INCRBY) and checked against the cap in one round trip, so concurrent requests cannot all
 * slip through a read-then-write gap. If the transaction later fails, the caller releases the
 * reservation, so a failed send does not permanently consume the day's budget.
 *
 * Store-unavailable behavior is a DELIBERATE choice, not an accident:
 *   - default (testnet): FAIL OPEN — a limiter outage must not take the product down, and the
 *     per-drop cap plus the rate limits still bound the damage;
 *   - `CAPS_FAIL_CLOSED=1` (recommended for mainnet): FAIL CLOSED — no escrow is created while
 *     the counter cannot be trusted.
 */
import { kvConfigFromEnv } from "./rate-limit.js";

/** 1 USDC = 1e7 stroops (Stellar's 7-decimal fixed point). */
export const USDC_STROOPS = 10_000_000n;

export interface CapsConfig {
  /** Largest single escrow, in stroops. */
  maxDropStroops: bigint;
  /** Largest rolling UTC-day total across all senders, in stroops. */
  maxDayStroops: bigint;
  /** Reject when the day counter is unavailable, instead of allowing through. */
  failClosed: boolean;
}

function usdcEnv(name: string, fallbackUsdc: number): bigint {
  const raw = process.env[name];
  const n = raw ? Number.parseFloat(raw) : Number.NaN;
  const usdc = Number.isFinite(n) && n > 0 ? n : fallbackUsdc;
  // Round to whole stroops; fractional input is truncated, never expanded.
  return BigInt(Math.floor(usdc * Number(USDC_STROOPS)));
}

/**
 * Defaults are TESTNET-shaped: comfortably above every amount the demo and test suites move
 * (the largest is 20 USDC), while still bounding a runaway. Mainnet should start far lower —
 * ops/RUNBOOK_SPONSOR_KEY.md and the mainnet decision packet suggest 20 / 500.
 */
export function capsFromEnv(): CapsConfig {
  return {
    maxDropStroops: usdcEnv("MAX_DROP_USDC", 100),
    maxDayStroops: usdcEnv("MAX_DAY_USDC", 1000),
    failClosed: process.env.CAPS_FAIL_CLOSED === "1",
  };
}

/** Format stroops as a plain USDC string for error messages ("12.5", not "125000000"). */
export function stroopsToUsdc(stroops: bigint): string {
  const whole = stroops / USDC_STROOPS;
  const frac = (stroops % USDC_STROOPS).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** The UTC-day bucket key. A day boundary resets the budget; no sliding window needed. */
export function dayKey(now: number): string {
  return `caps:day:${new Date(now).toISOString().slice(0, 10)}`;
}

export interface CapVerdict {
  ok: boolean;
  reason?: string;
  /** Call this if the transaction failed, to give the day's budget back. */
  release?: () => Promise<void>;
}

/** Add to the day counter and return the NEW total (atomic; also sets the key's expiry). */
async function addToDay(
  kv: { url: string; token: string },
  key: string,
  deltaStroops: bigint,
): Promise<bigint> {
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify([
      ["INCRBY", key, deltaStroops.toString()],
      // 48h so a bucket outlives its day even with clock skew, then self-cleans.
      ["EXPIRE", key, "172800"],
    ]),
  });
  if (!res.ok) throw new Error(`caps store returned ${res.status}`);
  const [first] = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  if (!first || first.error) throw new Error(`caps store error: ${first?.error}`);
  return BigInt(String(first.result));
}

/**
 * Check BOTH caps for an escrow of `amountStroops` and reserve the day budget.
 * On `ok: false` nothing is reserved. On `ok: true` the caller MUST invoke `release()` if the
 * transaction ends up failing.
 */
export async function checkCaps(
  amountStroops: bigint,
  caps: CapsConfig,
  now = Date.now(),
): Promise<CapVerdict> {
  if (amountStroops <= 0n) return { ok: false, reason: "escrow amount must be positive" };

  // 1. Per-drop — local, always enforced.
  if (amountStroops > caps.maxDropStroops) {
    return {
      ok: false,
      reason: `amount ${stroopsToUsdc(amountStroops)} USDC exceeds the per-drop cap of ${stroopsToUsdc(caps.maxDropStroops)} USDC`,
    };
  }

  // 2. Per-day — shared counter.
  const kv = kvConfigFromEnv();
  if (!kv) {
    if (caps.failClosed) {
      return { ok: false, reason: "daily cap counter is not configured (fail-closed)" };
    }
    return { ok: true }; // per-drop cap + rate limits still apply
  }

  const key = dayKey(now);
  let total: bigint;
  try {
    total = await addToDay(kv, key, amountStroops);
  } catch (e) {
    if (caps.failClosed) {
      return { ok: false, reason: `daily cap counter unavailable (fail-closed): ${(e as Error).message}` };
    }
    console.warn(`[caps] day counter unavailable, allowing on the per-drop cap alone: ${(e as Error).message}`);
    return { ok: true };
  }

  if (total > caps.maxDayStroops) {
    // Give back what we just reserved so a rejected request does not consume the budget.
    await addToDay(kv, key, -amountStroops).catch(() => {});
    return {
      ok: false,
      reason: `daily escrow cap of ${stroopsToUsdc(caps.maxDayStroops)} USDC reached; try again tomorrow`,
    };
  }

  return {
    ok: true,
    release: async () => {
      await addToDay(kv, key, -amountStroops).catch(() => {});
    },
  };
}
