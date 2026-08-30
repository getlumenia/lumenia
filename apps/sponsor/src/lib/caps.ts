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
 * TWO MORE bounds live here, and they are the other kind: `checkOnboardingBudget` counts SPONSORED
 * ACCOUNTS — globally and per caller — because /create-account costs the sponsor a fixed reserve
 * lock and no dollars at all.
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
import { ipBucket, kvConfigFromEnv } from "./rate-limit.js";

/** 1 USDC = 1e7 stroops (Stellar's 7-decimal fixed point). */
export const USDC_STROOPS = 10_000_000n;

/**
 * A refusal that is SAFE to state plainly on mainnet.
 *
 * The Worker hides error text on mainnet, because anti-drain reasons tell an attacker exactly
 * which policy clause tripped — a precise oracle for probing the validator. Caps are different:
 * the per-drop and per-day ceilings are a published product rule (ops/RUNBOOK_MAINNET_DEMO.md),
 * not a secret, and hiding them leaves an honest sender staring at "request failed" with no way
 * to learn their amount was simply too large. Anything thrown as a PublicRefusal keeps its text;
 * everything else still collapses to a reference.
 */
export class PublicRefusal extends Error {
  readonly isPublicRefusal = true;
  constructor(message: string) {
    super(message);
    this.name = "PublicRefusal";
  }
}

/** True for an error that may be shown to the caller verbatim, on any network. */
export function isPublicRefusal(e: unknown): boolean {
  return e instanceof PublicRefusal || (e as { isPublicRefusal?: boolean })?.isPublicRefusal === true;
}


export interface CapsConfig {
  /** Smallest single escrow, in stroops. Below this the reserve costs more than the money moved. */
  minDropStroops: bigint;
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
 * (the largest is 20 USDC), while still bounding a runaway. Mainnet runs far lower — the
 * deployed pilot caps are 5 / 50 (wrangler.toml [env.mainnet]; see ops/RUNBOOK_MAINNET_DEMO.md);
 * 20 / 500 is the post-audit LAUNCH suggestion (recorded in the owner's local decision packet).
 */
export function capsFromEnv(): CapsConfig {
  return {
    minDropStroops: usdcEnv("MIN_DROP_USDC", 0.01),
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

/**
 * The UTC-day bucket key. A day boundary resets the budget; no sliding window needed.
 *
 * Namespaced by network: a testnet and a mainnet sponsor may share one Upstash store, and an
 * un-namespaced key would let testnet traffic consume the mainnet day budget (or the reverse).
 */
export function dayKey(now: number, network = process.env.STELLAR_NETWORK ?? "testnet"): string {
  return `caps:${network}:day:${new Date(now).toISOString().slice(0, 10)}`;
}

/** The onboarding bucket, same shape and namespacing as `dayKey` but counting accounts. */
export function accountDayKey(now: number, network = process.env.STELLAR_NETWORK ?? "testnet"): string {
  return `caps:${network}:accounts:${new Date(now).toISOString().slice(0, 10)}`;
}

/**
 * The per-caller onboarding bucket, inside the same UTC day as `accountDayKey`.
 *
 * `source` is collapsed with the rate limiter's own `ipBucket` — an IPv6 allocation down to its
 * /64, an IPv4 address unchanged — so both bounds mean the same thing by "one caller", and a fresh
 * address out of the same /64 cannot mint a fresh budget. A request that arrives with no address at
 * all shares one bucket rather than escaping the bound.
 */
export function accountSourceDayKey(
  now: number,
  source: string,
  network = process.env.STELLAR_NETWORK ?? "testnet",
): string {
  const who = ipBucket(source?.trim() ? source.trim() : "unknown");
  return `caps:${network}:accounts:${new Date(now).toISOString().slice(0, 10)}:src:${who}`;
}

export interface CapVerdict {
  ok: boolean;
  reason?: string;
  /** Call this if the transaction failed, to give the day's budget back. */
  release?: () => Promise<void>;
}

/**
 * Add to EVERY given counter in one pipeline and return each key's NEW total, in the order asked.
 * One round trip whatever the count, so a second bound costs no extra latency on a claim.
 */
async function addToDays(
  kv: { url: string; token: string },
  keys: string[],
  deltaStroops: bigint,
): Promise<bigint[]> {
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify(
      keys.flatMap((key) => [
        ["INCRBY", key, deltaStroops.toString()],
        // 48h so a bucket outlives its day even with clock skew, then self-cleans.
        ["EXPIRE", key, "172800"],
      ]),
    ),
  });
  if (!res.ok) throw new Error(`caps store returned ${res.status}`);
  const results = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  // Each key contributes two commands; the INCRBY is the first of its pair.
  return keys.map((_, i) => {
    const incr = results[i * 2];
    if (!incr || incr.error) throw new Error(`caps store error: ${incr?.error}`);
    return BigInt(String(incr.result));
  });
}

/** Add to the day counter and return the NEW total (atomic; also sets the key's expiry). */
async function addToDay(
  kv: { url: string; token: string },
  key: string,
  deltaStroops: bigint,
): Promise<bigint> {
  return (await addToDays(kv, [key], deltaStroops))[0]!;
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

  // 0. A FLOOR, not just a ceiling. The caps bound how many dollars move, but the sponsor's real
  // cost per escrow is a fixed ~1 XLM reserve lock that has nothing to do with the amount. A
  // one-stroop send (0.0000001 USDC) sailed through every cap while locking that reserve in full,
  // so the cheapest way to drain the sponsor's float was to send it almost nothing, repeatedly.
  if (amountStroops < caps.minDropStroops) {
    return {
      ok: false,
      reason: `amount ${stroopsToUsdc(amountStroops)} USDC is below the minimum of ${stroopsToUsdc(caps.minDropStroops)} USDC`,
    };
  }

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

/* ------------------------------------------------------------------------------------------
 * ONBOARDING RESERVE BUDGET — a ceiling on the sponsor's own reserves, not on any amount.
 *
 * /create-account is open by design (a friend receiving money is not a pilot user, so the pilot
 * allowlist deliberately does not gate it), and its per-account rate-limit bucket is keyed on a
 * public key the CALLER mints fresh for every request — so that bucket never bites and only the
 * per-IP window is left. Each account handed out locks ~1 XLM of sponsor reserve (0.5 account
 * base + 0.5 trustline subentry) that nothing ever gives back, because nobody merges a claim
 * account. The escrow caps above cannot see any of this: they bound dollars, and this route
 * moves none.
 *
 * TWO counters, not one. The GLOBAL one is the reserve ceiling: the reserve is a single shared
 * pot, and a budget an attacker multiplies by presenting fresh addresses is not a budget. On its
 * own, though, that ceiling is also a switch for turning the product off — the only other bound is
 * ~30 requests a minute per IP, so one caller could spend a whole day's budget inside twenty
 * minutes and every real recipient claiming money afterwards would be refused until UTC midnight.
 * The PER-SOURCE counter is the fix: keyed to the caller exactly as the rate limiter keys one
 * (IPv6 down to its /64, IPv4 as-is — lib/rate-limit.ts) and set to a fraction of the global
 * budget, so exhausting it spends that caller's own share and nobody else's.
 *
 * WHEN THE SLOT IS SPENT — at handout, and an abandoned handout keeps it. /create-account returns
 * a sponsor-signed sandwich that the CLIENT submits (lib/create-account.ts); the sponsor never
 * sees that submission, so it can know it AUTHORIZED an onboarding but never that one happened.
 * `release()` is therefore for the one case the service can actually observe — the handler threw,
 * so no XDR left the building. A signed sandwich that is then dropped still counts against the
 * day, which makes this an upper bound on the reserves the sponsor may commit, never an
 * undercount. (The channel lease behind the same handout is held for exactly this reason.)
 * ------------------------------------------------------------------------------------------ */

/** Sponsored onboardings per UTC day when `MAX_DAY_ACCOUNTS` is unset. */
const DEFAULT_MAX_DAY_ACCOUNTS = 500;

/**
 * One caller's share of the day when `MAX_DAY_ACCOUNTS_PER_SOURCE` is unset: a fifth, so it takes
 * five distinct sources to exhaust the day and no household, office or NAT behind a single address
 * ever notices. Derived rather than fixed, so the relationship survives any tuning of the global
 * budget; the floor keeps a small global budget from leaving a per-source one too tight to use.
 */
function defaultSourceShare(maxDayAccounts: number): number {
  return Math.max(20, Math.ceil(maxDayAccounts / 5));
}

export interface OnboardingBudget {
  /** Largest number of sponsored accounts in one rolling UTC day, across all callers. */
  maxDayAccounts: number;
  /** Largest number from ONE caller (rate-limiter keying) in that same day. */
  maxDaySourceAccounts: number;
  /**
   * What an UNREADABLE counter means. `false`: allow through — the per-IP rate limit is still
   * there. `true`: enforce the same two budgets against the per-isolate counter below instead.
   * Neither value ever refuses on the store's own availability; see that counter for why.
   */
  failClosed: boolean;
}

export function onboardingBudgetFromEnv(): OnboardingBudget {
  const int = (name: string) => {
    const raw = process.env[name];
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const maxDayAccounts = int("MAX_DAY_ACCOUNTS") ?? DEFAULT_MAX_DAY_ACCOUNTS;
  const perSource = int("MAX_DAY_ACCOUNTS_PER_SOURCE") ?? defaultSourceShare(maxDayAccounts);
  return {
    maxDayAccounts,
    // A per-source bound above the global one could never fire; clamping keeps "tighter than the
    // global" true however the two are configured.
    maxDaySourceAccounts: Math.min(perSource, maxDayAccounts),
    // Mainnet enforces whatever CAPS_FAIL_CLOSED says. What this flag picks is WHICH counter the two
    // budgets are enforced against when the shared one cannot be read — never whether onboarding is
    // served: `false` leaves the per-IP rate limit as the only bound, `true` falls back to the
    // per-isolate counter below. Neither value refuses on the store's own availability, because this
    // cap fails in the opposite direction to `checkCaps`; `checkOnboardingBudget` states why.
    failClosed: process.env.STELLAR_NETWORK === "mainnet" || process.env.CAPS_FAIL_CLOSED === "1",
  };
}

/* ---------------------------------------------------------------------------------------------
 * THE DEGRADED COUNTER — per isolate, in memory, reached only while the shared store cannot be.
 *
 * Every other module in this service that reads the same Upstash store refuses to let its outage
 * stop a recipient: the rate limiter drops to in-memory buckets (lib/rate-limit.ts), the halt check
 * reads an unreadable key as "not halted" (lib/kill-switch.ts), and the channel pool falls back to
 * the sponsor-sourced sandwich (lib/channels.ts). This budget has to hold the same line, because
 * the route it gates is the recipient's FIRST step at money already escrowed for them. A refusal
 * there is one no recipient can act on — not by retrying, not by waiting out the day, not from
 * another network — and the store's availability is not something a claim link can carry.
 *
 * So an unreadable counter degrades to this one rather than refusing. It carries the same two
 * budgets; isolates do not share it, so it bounds the outage window instead of guaranteeing the
 * day's total. The stops that hold an incident are the ones that need no store at all:
 * `SPONSOR_HALT=1` halts every value route, and the float watchdog runs every 15 minutes.
 * ------------------------------------------------------------------------------------------- */

/** The day marker the counters below belong to — `accountDayKey`, so a network switch also resets. */
let localDay = "";
const localAccounts = new Map<string, number>();

/**
 * Add to the per-isolate counters and return each key's new total, in the order asked.
 *
 * Entries are dropped at zero and the whole map at a day boundary, so a caller cycling source
 * addresses cannot grow it without bound: a refused reservation leaves nothing behind, and an
 * admitted one is already bounded by `maxDayAccounts`.
 */
function addToLocalDays(keys: string[], delta: number, dayMarker: string): number[] {
  if (dayMarker !== localDay) {
    // A give-back for a day that has already rolled has nothing to give back to, and letting it
    // reset the map would clear the CURRENT day's counters to make room for it.
    if (delta < 0) return keys.map(() => 0);
    localDay = dayMarker;
    localAccounts.clear();
  }
  return keys.map((key) => {
    const next = (localAccounts.get(key) ?? 0) + delta;
    if (next > 0) localAccounts.set(key, next);
    else localAccounts.delete(key);
    return next;
  });
}

/**
 * Reserve ONE sponsored onboarding against BOTH the day's budget and `source`'s share of it. Same
 * atomic INCR-then-release contract as `checkCaps`: on `ok: false` nothing stays reserved; on
 * `ok: true` the caller MUST invoke `release()` if no sandwich was handed out.
 *
 * WHAT IS GUARANTEED:
 *   - shared counter READABLE — both budgets are hard and service-wide: across every isolate, at
 *     most `maxDayAccounts` onboardings in a UTC day and at most `maxDaySourceAccounts` from any one
 *     caller. This is the only state in which a number here is a real ceiling.
 *   - shared counter UNREADABLE — onboarding is still SERVED; nothing is ever refused on the store's
 *     own availability. `failClosed: false` leaves the per-IP rate limit as the only bound;
 *     `failClosed: true` enforces the same two numbers against the per-isolate counter above. That
 *     residual is worth stating plainly: a per-isolate ceiling on a multi-isolate Worker bounds one
 *     isolate, not the fleet, so an outage's true day total is that ceiling times however many
 *     isolates are live. It is a SOFT bound — which is why the stops that actually hold an incident
 *     are the ones needing no store at all (`SPONSOR_HALT=1`, the float watchdog).
 *
 * That is the OPPOSITE direction to `checkCaps`, deliberately. `checkCaps` bounds money ENTERING
 * escrow, so a counter it cannot trust means create no more of it. This bounds /create-account — the
 * step a walletless recipient takes to reach money ALREADY escrowed for them — where a refusal is
 * one nobody can act on. Pausing may gate new escrow; it may never block an exit.
 *
 * `source` is the caller's address as the request carried it (cf-connecting-ip, then
 * x-forwarded-for) — `accountSourceDayKey` collapses it the way the rate limiter does.
 */
export async function checkOnboardingBudget(
  budget: OnboardingBudget,
  source: string,
  now = Date.now(),
): Promise<CapVerdict> {
  // Both counters move together, so neither can be spent without the other.
  const dayGlobalKey = accountDayKey(now);
  const keys = [accountSourceDayKey(now, source), dayGlobalKey];

  /** Reserve against the per-isolate counter — the fallback for a store that cannot be read. */
  const degrade = (): { totals: [bigint, bigint]; giveBack: () => Promise<void> } => {
    const [sourceLocal, dayLocal] = addToLocalDays(keys, 1, dayGlobalKey);
    return {
      totals: [BigInt(sourceLocal!), BigInt(dayLocal!)],
      giveBack: async () => {
        addToLocalDays(keys, -1, dayGlobalKey);
      },
    };
  };

  let held: { totals: [bigint, bigint]; giveBack: () => Promise<void> };
  const kv = kvConfigFromEnv();
  if (!kv) {
    if (!budget.failClosed) return { ok: true }; // the per-IP rate limit still applies
    // Loud: where the counter is meant to be enforced, its absence is a missing secret rather than
    // a choice, and a request that is served anyway says nothing about it.
    console.warn("[caps] no onboarding counter is configured — bounding onboarding per isolate");
    held = degrade();
  } else {
    try {
      const [sourceTotal, dayTotal] = await addToDays(kv, keys, 1n);
      held = {
        totals: [sourceTotal!, dayTotal!],
        giveBack: async () => {
          await addToDays(kv, keys, -1n).catch(() => {});
        },
      };
    } catch (e) {
      console.warn(`[caps] onboarding counter unavailable: ${(e as Error).message}`);
      if (!budget.failClosed) return { ok: true };
      held = degrade();
    }
  }

  const [sourceTotal, dayTotal] = held.totals;
  const giveBack = held.giveBack;

  /* Both refusals below are thrown as a PublicRefusal, so their text survives mainnet redaction —
     a bare "request failed" leaves an honest recipient with nothing to do. Both must also READ as a
     deliberate stop: a refusal the claim screen cannot place is treated as retryable and gets a
     button that would fail identically until UTC midnight, and "paused" is the word that screen
     keys on (apps/web/lib/claim-error.ts). Keep it in both, and keep the limit itself in the
     sentence — it is a published product rule, not a secret. */

  // The per-source share first: it is the tighter bound, and saying which one was hit is the
  // difference between "wait until tomorrow" and "come back from somewhere else".
  if (sourceTotal > BigInt(budget.maxDaySourceAccounts)) {
    await giveBack();
    return {
      ok: false,
      reason: `new accounts from this connection are paused for today — its limit of ${budget.maxDaySourceAccounts} is reached; try again tomorrow`,
    };
  }

  if (dayTotal > BigInt(budget.maxDayAccounts)) {
    await giveBack();
    return {
      ok: false,
      reason: `new accounts are paused for today — the limit of ${budget.maxDayAccounts} a day is reached; try again tomorrow`,
    };
  }

  return { ok: true, release: giveBack };
}
