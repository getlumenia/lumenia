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
 * A THIRD bound sits inside the second: the rolling UTC-day total from ONE sender (their public
 * key) may not exceed `maxDaySenderStroops`. It is reserved in the same pipeline as the day
 * counter and released with it, so the two can never disagree. The day cap is the sponsor's
 * blast radius; the per-sender cap is a fairness bound inside it: a client looping on a bug, or
 * one wallet, cannot take the whole day's budget from everybody else before UTC midnight. It is
 * keyed on the key whose USDC moves (/v2-deposit refuses a deposit whose `from` is not the
 * transaction's sender, so the bucket cannot be pointed at somebody else's key), and it is not a
 * security bound against someone who moves their USDC to a fresh key first (that costs an
 * on-ledger payment and is visible); it is the bound that keeps an honest day usable.
 *
 * TWO MORE bounds live here, and they are the other kind: `checkOnboardingBudget` counts SPONSORED
 * ACCOUNTS — globally and per caller — because /create-account costs the sponsor a fixed reserve
 * lock and no dollars at all. And a LAST one, `chargeSponsorFee`, bounds the XLM the sponsor bids
 * in fees across every value route in a day.
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
 *
 * STORE FACTS this module relies on (Upstash REST, https://upstash.com/docs/redis/features/restapi):
 * a `/pipeline` body is a two-dimensional array of commands; "each command in the pipeline will
 * be executed in order", the response is a JSON array "in the same order", and "execution of the
 * pipeline is not atomic" (commands from other clients can interleave). Every command used here is
 * atomic on its own: INCRBY returns the value after the increment (https://redis.io/docs/latest/commands/incrby/),
 * SET ... NX answers "OK" when it set the key and null when the key already existed
 * (https://redis.io/docs/latest/commands/set/), DEL answers how many keys it removed
 * (https://redis.io/docs/latest/commands/del/), and a missing key GETs as `{"result":null}`.
 */
import { StrKey } from "@stellar/stellar-sdk";
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
  /** A stable reason a client may branch on (for example "owner-required"), when there is one. */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "PublicRefusal";
    if (code) this.code = code;
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
  /**
   * Largest rolling UTC-day total from ONE sender (keyed on their public key), in stroops.
   * Optional so a hand-built config keeps compiling; when absent, the day cap is the bound for a
   * single sender too (the testnet shape, where the two numbers are equal by default).
   */
  maxDaySenderStroops?: bigint;
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

/** The per-sender day cap when `MAX_DAY_USDC_PER_SENDER` is unset: half the pilot's $50 day. */
const DEFAULT_MAINNET_SENDER_DAY_USDC = 25;
/** The pilot's own per-transfer and per-day caps, used on mainnet when the variable is missing. */
const DEFAULT_MAINNET_DROP_USDC = 5;
const DEFAULT_MAINNET_DAY_USDC = 50;

/**
 * Defaults are TESTNET-shaped: comfortably above every amount the demo and test suites move
 * (the largest is 20 USDC), while still bounding a runaway. Mainnet runs far lower — the
 * deployed pilot caps are 5 / 50 (wrangler.toml [env.mainnet]; see ops/RUNBOOK_MAINNET_DEMO.md);
 * 20 / 500 is the post-audit LAUNCH suggestion (recorded in the owner's local decision packet).
 *
 * The per-sender day cap reads `MAX_DAY_USDC_PER_SENDER`; unset, it is 25 USDC on mainnet and
 * equal to the day cap elsewhere (so testnet behaves exactly as before). It is clamped to the day
 * cap, because a per-sender bound above the day's could never fire.
 *
 * MAINNET DEFAULTS ARE THE PILOT'S, NOT THE TESTNET'S. `[env.mainnet.vars]` redeclares the variable
 * block rather than inheriting it, so a line dropped while editing that block (flipping PILOT_MODE,
 * say) leaves the variable undefined. Until 2026-10-08 that meant the testnet default: a 100 USDC
 * transfer, a 1,000 USDC day, and a store outage that let deposits through. On mainnet a missing
 * variable now gives the pilot's 5 / 50 and a store outage refuses, whatever CAPS_FAIL_CLOSED says;
 * configuration can still choose other numbers, it just cannot lose them by omission.
 */
export function capsFromEnv(network = process.env.STELLAR_NETWORK ?? "testnet"): CapsConfig {
  const mainnet = network === "mainnet";
  const maxDayStroops = usdcEnv("MAX_DAY_USDC", mainnet ? DEFAULT_MAINNET_DAY_USDC : 1000);
  const senderFallbackUsdc = mainnet ? DEFAULT_MAINNET_SENDER_DAY_USDC : Number(maxDayStroops) / Number(USDC_STROOPS);
  const perSender = usdcEnv("MAX_DAY_USDC_PER_SENDER", senderFallbackUsdc);
  return {
    minDropStroops: usdcEnv("MIN_DROP_USDC", 0.01),
    maxDropStroops: usdcEnv("MAX_DROP_USDC", mainnet ? DEFAULT_MAINNET_DROP_USDC : 100),
    maxDayStroops,
    maxDaySenderStroops: perSender < maxDayStroops ? perSender : maxDayStroops,
    failClosed: mainnet || process.env.CAPS_FAIL_CLOSED === "1",
  };
}

/** Format stroops as a plain USDC string for error messages ("12.5", not "125000000"). */
export function stroopsToUsdc(stroops: bigint): string {
  const whole = stroops / USDC_STROOPS;
  const frac = (stroops % USDC_STROOPS).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** XLM has the same 7-decimal fixed point; the name says which asset a number is. */
export const stroopsToXlm = stroopsToUsdc;

/** The UTC date a counter belongs to, as every key here spells it. */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The UTC-day bucket key. A day boundary resets the budget; no sliding window needed.
 *
 * Namespaced by network: a testnet and a mainnet sponsor may share one Upstash store, and an
 * un-namespaced key would let testnet traffic consume the mainnet day budget (or the reverse).
 */
export function dayKey(now: number, network = process.env.STELLAR_NETWORK ?? "testnet"): string {
  return `caps:${network}:day:${utcDay(now)}`;
}

/**
 * ONE sender's bucket inside the same UTC day as `dayKey`, keyed on their public key. The day is
 * in the key (not only in the expiry) so that a sender's total resets with everybody else's at
 * UTC midnight, and so a testnet sender and a mainnet sender with the same key never share one.
 */
export function senderDayKey(
  now: number,
  senderPublicKey: string,
  network = process.env.STELLAR_NETWORK ?? "testnet",
): string {
  return `caps:${network}:day:${utcDay(now)}:sender:${senderPublicKey}`;
}

/** The onboarding bucket, same shape and namespacing as `dayKey` but counting accounts. */
export function accountDayKey(now: number, network = process.env.STELLAR_NETWORK ?? "testnet"): string {
  return `caps:${network}:accounts:${utcDay(now)}`;
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
  return `caps:${network}:accounts:${utcDay(now)}:src:${who}`;
}

/**
 * The marker that says "this recipient key already holds one of today's onboarding slots". A
 * retry for the same key is then free, because a public key can only ever become ONE account, so
 * the reserve the budget exists to bound is locked at most once per key however many times the
 * route is called for it. Same day and network namespacing as the counters it protects.
 */
export function accountPubkeyDayKey(
  now: number,
  recipientPublicKey: string,
  network = process.env.STELLAR_NETWORK ?? "testnet",
): string {
  return `caps:${network}:accounts:${utcDay(now)}:pk:${recipientPublicKey}`;
}

/**
 * How many times one recipient key's REPEAT may be served in a day FROM ONE SOURCE. A repeat costs
 * no onboarding slot, but each one is a freshly signed sandwich the fee budget counts (the client
 * may submit it, and an included one that fails still pays) and takes the sponsor's next sequence
 * (repeats are served without a channel lease: see worker.ts). Honest retries are a handful (a
 * timed-out submit, a reopened page); ten a day is far above that. Counted per key AND source: a
 * per-key count let anyone who knows an address spend its ten repeats and lock its owner out of a
 * retry for the rest of the UTC day.
 */
export const MAX_REPEATS_PER_KEY = 10;

/** The repeat counter of one recipient key from one source (collapsed like the rate limiter's). */
export function accountRepeatDayKey(
  now: number,
  recipientPublicKey: string,
  source: string,
  network = process.env.STELLAR_NETWORK ?? "testnet",
): string {
  const who = ipBucket(source?.trim() ? source.trim() : "unknown");
  return `caps:${network}:accounts:${utcDay(now)}:rep:${recipientPublicKey}:${who}`;
}

export interface CapVerdict {
  ok: boolean;
  reason?: string;
  /** Call this if the transaction failed, to give the day's budget back. */
  release?: () => Promise<void>;
  /**
   * Onboarding only: this key already holds today's slot, so the request is served without a new
   * reservation (and `release` is a no-op). The worker serves it on the sponsor path, without a
   * channel lease, so repeats cannot occupy the channel pool (see worker.ts).
   */
  repeat?: boolean;
}

type KvConn = { url: string; token: string };
type KvReply = { result?: unknown; error?: string };

/** 48h so a bucket outlives its day even with clock skew, then self-cleans. */
const DAY_KEY_TTL_SECONDS = "172800";

/** One `/pipeline` round trip: the commands in order, the replies in the same order. */
async function pipeline(kv: KvConn, cmds: string[][]): Promise<KvReply[]> {
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!res.ok) throw new Error(`caps store returned ${res.status}`);
  return (await res.json()) as KvReply[];
}

/** The INCRBY + EXPIRE pair every counter here is moved with. */
function incrCmds(key: string, delta: bigint): string[][] {
  return [
    ["INCRBY", key, delta.toString()],
    ["EXPIRE", key, DAY_KEY_TTL_SECONDS],
  ];
}

/** Read the INCRBY replies out of a pipeline result, one per key, starting at `offset`. */
function incrTotals(results: KvReply[], keys: string[], offset = 0): bigint[] {
  // Each key contributes two commands; the INCRBY is the first of its pair.
  return keys.map((_, i) => {
    const incr = results[offset + i * 2];
    if (!incr || incr.error) throw new Error(`caps store error: ${incr?.error}`);
    return BigInt(String(incr.result));
  });
}

/**
 * Add to EVERY given counter in one pipeline and return each key's NEW total, in the order asked.
 * One round trip whatever the count, so a second bound costs no extra latency on a claim.
 */
async function addToDays(kv: KvConn, keys: string[], deltaStroops: bigint): Promise<bigint[]> {
  const results = await pipeline(
    kv,
    keys.flatMap((key) => incrCmds(key, deltaStroops)),
  );
  return incrTotals(results, keys);
}

/** Add to the day counter and return the NEW total (atomic; also sets the key's expiry). */
async function addToDay(kv: KvConn, key: string, deltaStroops: bigint): Promise<bigint> {
  return (await addToDays(kv, [key], deltaStroops))[0]!;
}

/**
 * Check the caps for an escrow of `amountStroops` and reserve the day budget.
 * On `ok: false` nothing is reserved. On `ok: true` the caller MUST invoke `release()` if the
 * transaction ends up failing.
 *
 * With `senderPublicKey` given, the sender's own day total is reserved in the SAME pipeline as
 * the day counter and released with it. Without it, only the day counter moves (the exit and
 * payout routes are not senders).
 */
export async function checkCaps(
  amountStroops: bigint,
  caps: CapsConfig,
  now = Date.now(),
  senderPublicKey?: string,
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

  // 2. Per-day: the shared counter, and the sender's own beside it.
  const kv = kvConfigFromEnv();
  if (!kv) {
    if (caps.failClosed) {
      return { ok: false, reason: "daily cap counter is not configured (fail-closed)" };
    }
    return { ok: true }; // per-drop cap + rate limits still apply
  }

  const sender = senderPublicKey?.trim() ?? "";
  const keys = sender ? [dayKey(now), senderDayKey(now, sender)] : [dayKey(now)];
  const maxSender = caps.maxDaySenderStroops ?? caps.maxDayStroops;
  let totals: bigint[];
  try {
    totals = await addToDays(kv, keys, amountStroops);
  } catch (e) {
    if (caps.failClosed) {
      return { ok: false, reason: `daily cap counter unavailable (fail-closed): ${(e as Error).message}` };
    }
    console.warn(`[caps] day counter unavailable, allowing on the per-drop cap alone: ${(e as Error).message}`);
    return { ok: true };
  }
  // Both counters go back together, so a refusal or a failed send leaves neither one spent.
  const giveBack = async () => {
    await addToDays(kv, keys, -amountStroops).catch(() => {});
  };
  const [dayTotal, senderTotal] = totals;

  // The sender's own share first: it is the tighter bound, and the sentence has to tell the
  // sender that THEY are at a limit (the day is still open to others), not that the day is spent.
  if (sender && senderTotal! > maxSender) {
    await giveBack();
    return {
      ok: false,
      reason: `your sends today add up to the per-sender limit of ${stroopsToUsdc(maxSender)} USDC; try again tomorrow`,
    };
  }

  if (dayTotal! > caps.maxDayStroops) {
    // Give back what we just reserved so a rejected request does not consume the budget.
    await giveBack();
    return {
      ok: false,
      reason: `daily escrow cap of ${stroopsToUsdc(caps.maxDayStroops)} USDC reached; try again tomorrow`,
    };
  }

  return { ok: true, release: giveBack };
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
 *
 * ONE SLOT PER RECIPIENT KEY. A claim that retries (the client's submit timed out, the page was
 * reopened) calls this route again with the SAME recipient key, and each call used to spend a
 * fresh slot: on a 40-a-day mainnet budget a handful of flaky recipients could close the day for
 * everyone. A public key can only ever become one account, so the reserve this budget bounds is
 * locked at most once per key; the per-key marker makes the counters say the same thing. The
 * marker is READ in the same pipeline as the increments (one round trip for the common, first-time
 * case) and written with SET NX only once both limits have passed, so a request the limits refuse
 * never leaves a marker another request could be served on. When the marker already existed, or
 * another request for the key wins the SET NX, the increments are handed straight back and the
 * request is served without a reservation. Not atomic across the round trips (Upstash pipelines are
 * not), but each command is, and the windows between them are the same transient over-count any
 * refused reservation has: the counter can only read HIGH for a moment, never low.
 *
 * The slot is FENCED, so that last sentence also holds for a retry that overtakes its own first
 * attempt. The marker holds the admitting request's random token. A repeat served while that first
 * request is still in flight re-stamps the marker with its own token (SET ... XX), and a release
 * only decrements and deletes when the marker still holds the releasing request's token (one EVAL,
 * the compare-and-delete lib/channels.ts uses for its leases). Before the fence, a first attempt
 * whose Horizon read failed AFTER its retry had been served released the slot the retry was using:
 * the day counter read one low and the key could be admitted again. A repeat is served without a
 * channel lease (see `CapVerdict.repeat`), at most MAX_REPEATS_PER_KEY times a day per source.
 * ------------------------------------------------------------------------------------------ */

/** Sponsored onboardings per UTC day when `MAX_DAY_ACCOUNTS` is unset. */
const DEFAULT_MAX_DAY_ACCOUNTS = 500;

/**
 * One caller's share of the day when `MAX_DAY_ACCOUNTS_PER_SOURCE` is unset.
 *
 * TESTNET: a fifth, with a floor of 20, so it takes five distinct sources to exhaust the day and
 * no household, office or NAT behind a single address ever notices; the floor keeps a small
 * global budget from leaving a per-source share too tight for a demo room.
 *
 * MAINNET: an eighth, with NO floor. The pilot's day is small (60) and real money is behind every
 * slot; a floor of 20 would let three connections close the day, and the 2026-09-01 review found
 * exactly that: the per-source share was half the day. Eight connections to spend a day is the
 * ratio the pilot runs, and the owner tunes the number in wrangler.toml, never the shape.
 */
function defaultSourceShare(maxDayAccounts: number, network: string): number {
  if (network === "mainnet") return Math.ceil(maxDayAccounts / 8);
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

export function onboardingBudgetFromEnv(network = process.env.STELLAR_NETWORK ?? "testnet"): OnboardingBudget {
  const int = (name: string) => {
    const raw = process.env[name];
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const maxDayAccounts = int("MAX_DAY_ACCOUNTS") ?? DEFAULT_MAX_DAY_ACCOUNTS;
  const perSource = int("MAX_DAY_ACCOUNTS_PER_SOURCE") ?? defaultSourceShare(maxDayAccounts, network);
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
    failClosed: network === "mainnet" || process.env.CAPS_FAIL_CLOSED === "1",
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
 * The per-isolate twin of the per-key marker: recipient keys admitted today while the store was
 * unreadable, each with the token of the request that holds its slot (the same fence as the store's
 * marker). Bounded by the day: it only ever holds admitted keys (a refused or released one is
 * removed), and admissions are bounded by `maxDayAccounts`; the whole map goes at a day boundary.
 */
const localPubkeys = new Map<string, string>();
/** The per-isolate twin of the repeat counter (same day boundary, same bound by admitted keys). */
const localRepeats = new Map<string, number>();

/** Start a fresh day for the per-isolate counters when the marker moves on. */
function rollLocalDay(dayMarker: string): void {
  if (dayMarker === localDay) return;
  localDay = dayMarker;
  localAccounts.clear();
  localPubkeys.clear();
  localRepeats.clear();
}

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
    rollLocalDay(dayMarker);
  }
  return keys.map((key) => {
    const next = (localAccounts.get(key) ?? 0) + delta;
    if (next > 0) localAccounts.set(key, next);
    else localAccounts.delete(key);
    return next;
  });
}

/** A reservation in flight: the two new totals, and how to hand them back. */
interface HeldSlot {
  totals: [bigint, bigint];
  giveBack: () => Promise<void>;
  /**
   * Claim the per-key marker, called only once BOTH limits have passed. "stamped": the slot is this
   * request's (with or without a marker; see the KV path). "repeat": another request for the same
   * key was admitted between this one's read and its write; the increments went back and this
   * request is served as that key's repeat. Absent when there is no well-formed key, so no marker.
   */
  stamp?: () => Promise<"stamped" | "repeat">;
}

/** The verdict for a key that already holds today's slot: served, nothing reserved, nothing to release. */
const REPEAT_VERDICT: CapVerdict = { ok: true, release: async () => {}, repeat: true };

/**
 * The fenced release of one onboarding slot: KEYS[1] the per-key marker, KEYS[2] and KEYS[3] the
 * two counters, ARGV[1] the releasing request's token. It gives the slot back only while the marker
 * still holds that token; a repeat served in between has re-stamped it, and its handout is using the
 * slot. The local fake store (cli/fake-kv.ts) answers this exact script, so keep the two in step.
 */
const FENCED_SLOT_RELEASE =
  "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[1]); redis.call('incrby', KEYS[2], -1); redis.call('incrby', KEYS[3], -1); return 1 else return 0 end";

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
 *
 * `recipientPublicKey`, when given and well-formed, makes the reservation idempotent per key for
 * the day (see the header above): a repeat is served with a no-op `release`, because nothing was
 * reserved for it. A malformed key gets no marker; the handler refuses it a moment later and the
 * caller releases the slot as for any other handler failure.
 */
export async function checkOnboardingBudget(
  budget: OnboardingBudget,
  source: string,
  now = Date.now(),
  recipientPublicKey?: string,
): Promise<CapVerdict> {
  // Both counters move together, so neither can be spent without the other.
  const dayGlobalKey = accountDayKey(now);
  const keys = [accountSourceDayKey(now, source), dayGlobalKey];
  const pubkey = recipientPublicKey?.trim() ?? "";
  const marker = pubkey && StrKey.isValidEd25519PublicKey(pubkey) ? accountPubkeyDayKey(now, pubkey) : null;
  const repeatKey = marker ? accountRepeatDayKey(now, pubkey, source) : null;
  /** This request's fence token: whichever request last stamped the marker owns the slot. */
  const token = crypto.randomUUID();
  /** How many times this key's repeat has been served today, this one included (0: unknown). */
  let repeats = 0;

  /** Reserve against the per-isolate counter, the fallback for a store that cannot be read. */
  const degrade = (): HeldSlot | "repeat" => {
    rollLocalDay(dayGlobalKey);
    if (marker && localPubkeys.has(marker)) {
      localPubkeys.set(marker, token); // re-stamp: the earlier admission can no longer give this slot back
      repeats = (localRepeats.get(repeatKey!) ?? 0) + 1;
      localRepeats.set(repeatKey!, repeats);
      return "repeat";
    }
    const [sourceLocal, dayLocal] = addToLocalDays(keys, 1, dayGlobalKey);
    let stamped = false;
    return {
      totals: [BigInt(sourceLocal!), BigInt(dayLocal!)],
      // Within one isolate nothing runs between the read above and this write (no await between
      // them), so it cannot lose; it is deferred like the store's only so both paths share one rule.
      stamp: marker
        ? async () => {
            localPubkeys.set(marker, token);
            stamped = true;
            return "stamped";
          }
        : undefined,
      giveBack: async () => {
        if (marker && stamped) {
          if (localPubkeys.get(marker) !== token) return; // a repeat was served on this slot since
          localPubkeys.delete(marker);
        }
        addToLocalDays(keys, -1, dayGlobalKey);
      },
    };
  };

  /**
   * Try to serve this request as a repeat of the key's admission. The marker is RE-STAMPED first
   * (SET XX with this request's token), and only a re-stamp that took hands the increments back and
   * counts the repeat, in a second round trip. The re-stamp fences the earlier admission: if its
   * handler fails after this repeat was served, its release finds a token that is not its own and
   * leaves the slot counted, which is what the slot now is (this repeat's handout uses it).
   * "fresh": the SET XX found no marker (the admission was released in between, its handler failed)
   * or the store did not answer. Nobody is known to hold the slot, so this request KEEPS its
   * increments and is admitted afresh against the limits: the day reads high, never low. (It used
   * to hand the increments back first and re-stamp after, so a marker that vanished in between left
   * a served request uncounted.) A store that fails on the second round trip leaves the increments
   * counted and the repeat count unknown (0).
   */
  const asRepeat = async (kv: KvConn): Promise<"repeat" | "fresh"> => {
    const set = await pipeline(kv, [["SET", marker!, token, "XX", "EX", DAY_KEY_TTL_SECONDS]]).catch(() => null);
    const restamp = set?.[0];
    if (!restamp || restamp.error || restamp.result === null) return "fresh";
    const back = await pipeline(kv, [...keys.flatMap((key) => incrCmds(key, -1n)), ...incrCmds(repeatKey!, 1n)]).catch(() => null);
    const counted = back?.[keys.length * 2];
    repeats = counted && !counted.error ? Number(counted.result) : 0;
    return "repeat";
  };

  const repeatVerdict = (): CapVerdict =>
    repeats > MAX_REPEATS_PER_KEY
      ? {
          ok: false,
          reason: `new account requests for this key are paused for today: it was already set up and asked ${MAX_REPEATS_PER_KEY} more times; try again tomorrow`,
        }
      : REPEAT_VERDICT;

  let held: HeldSlot | "repeat";
  const kv = kvConfigFromEnv();
  if (!kv) {
    if (!budget.failClosed) return { ok: true }; // the per-IP rate limit still applies
    // Loud: where the counter is meant to be enforced, its absence is a missing secret rather than
    // a choice, and a request that is served anyway says nothing about it.
    console.warn("[caps] no onboarding counter is configured — bounding onboarding per isolate");
    held = degrade();
  } else {
    try {
      /* The marker is READ in the same round trip as the increments (the common, first-time case
         still costs one request before the limits are checked) and WRITTEN only once both limits
         have passed (`stamp`, below). It used to be written first, with SET NX in this pipeline: a
         request the limits then refused held the marker until its release ran, and a concurrent
         request for the same key read it and was served as a repeat with no limit checked at all. */
      const cmds = [...(marker ? [["GET", marker]] : []), ...keys.flatMap((key) => incrCmds(key, 1n))];
      const results = await pipeline(kv, cmds);
      let existing = false;
      if (marker) {
        const got = results[0];
        if (!got || got.error) throw new Error(`caps store error: ${got?.error}`);
        existing = got.result !== null;
      }
      let [sourceTotal, dayTotal] = incrTotals(results, keys, marker ? 1 : 0);
      const repeat = existing ? await asRepeat(kv) : null;
      if (repeat === "fresh") {
        /* The marker vanished after our read: the admission it marked was released, so the totals
           read above still count that slot. Read them again before the limits judge this request;
           an unreadable store keeps the old ones (a refusal that is too strict, never a bypass). */
        const fresh = await pipeline(kv, keys.map((key) => ["GET", key])).catch(() => null);
        const parsed = fresh?.map((r) => (r && !r.error && r.result != null ? BigInt(String(r.result)) : null));
        if (parsed && parsed[0] != null && parsed[1] != null) [sourceTotal, dayTotal] = [parsed[0], parsed[1]];
      }
      if (repeat === "repeat") {
        // The key already holds today's slot.
        held = "repeat";
      } else {
        let stamped = false;
        held = {
          totals: [sourceTotal!, dayTotal!],
          stamp: marker
            ? async () => {
                const set = await pipeline(kv, [["SET", marker, token, "NX", "EX", DAY_KEY_TTL_SECONDS]]).catch(() => null);
                const reply = set?.[0];
                if (!reply || reply.error) {
                  /* No answer: the SET NX may or may not have been applied. Release through the fence
                     either way: it gives the slot back only while the marker holds this request's
                     token, and otherwise leaves it counted. A plain decrement here could leave a
                     marker behind with the day one low, making every later request for the key free. */
                  stamped = true;
                  console.warn(`[caps] onboarding marker write unanswered: ${reply?.error ?? "store unavailable"}`);
                  return "stamped";
                }
                if (reply.result === "OK") {
                  stamped = true;
                  return "stamped";
                }
                /* Another request for this key was admitted between our read and this write: serve
                   this one as its repeat. If that admission is already released again, nobody holds
                   the slot; this request keeps its increments and goes without a marker (a retry of
                   the key then costs another slot: the day reads high, never low). */
                return (await asRepeat(kv)) === "repeat" ? "repeat" : "stamped";
              }
            : undefined,
          giveBack: async () => {
            // Stamped: give the slot back only while the marker is still this request's (fenced, one
            // round trip); a slot handed back frees the key to try again. Unstamped (refused by a
            // limit, or no well-formed key): no marker was ever written, so plain decrements.
            const cmds = stamped
              ? [["EVAL", FENCED_SLOT_RELEASE, "3", marker!, keys[0]!, keys[1]!, token]]
              : keys.flatMap((key) => incrCmds(key, -1n));
            await pipeline(kv, cmds).catch(() => {});
          },
        };
      }
    } catch (e) {
      console.warn(`[caps] onboarding counter unavailable: ${(e as Error).message}`);
      if (!budget.failClosed) return { ok: true };
      held = degrade();
    }
  }

  if (held === "repeat") return repeatVerdict();

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

  // Both limits passed: only now does the key's marker say it holds a slot.
  const stamp = held.stamp ? await held.stamp() : "stamped";
  if (stamp === "repeat") return repeatVerdict();
  return { ok: true, release: giveBack };
}

export interface DayCountersReading {
  /** The UTC day the numbers belong to. */
  day: string;
  /** USDC escrowed so far today, as a plain string; null when the store could not be read. */
  escrowUsdc: string | null;
  /** Sponsored onboardings handed out so far today; null when the store could not be read. */
  accounts: number | null;
  maxDayUsdc: string;
  maxDayAccounts: number;
}

/**
 * Today's two day counters as /health reads them: one pipeline of GETs, never a write. The
 * limits come from the same env readers the routes use, so the page shows what is enforced.
 */
export async function readDayCounters(now = Date.now()): Promise<DayCountersReading> {
  const caps = capsFromEnv();
  const budget = onboardingBudgetFromEnv();
  const base = { day: utcDay(now), maxDayUsdc: stroopsToUsdc(caps.maxDayStroops), maxDayAccounts: budget.maxDayAccounts };
  const kv = kvConfigFromEnv();
  if (!kv) return { ...base, escrowUsdc: null, accounts: null };
  try {
    const [escrow, accounts] = await pipeline(kv, [
      ["GET", dayKey(now)],
      ["GET", accountDayKey(now)],
    ]);
    if (!escrow || escrow.error || !accounts || accounts.error) {
      throw new Error(`caps store error: ${escrow?.error ?? accounts?.error}`);
    }
    const asBig = (r: KvReply) => (r.result == null ? 0n : BigInt(String(r.result)));
    return { ...base, escrowUsdc: stroopsToUsdc(asBig(escrow)), accounts: Number(asBig(accounts)) };
  } catch {
    return { ...base, escrowUsdc: null, accounts: null };
  }
}

/* ------------------------------------------------------------------------------------------
 * SPONSOR FEE BUDGET: a ceiling on the XLM the sponsor will spend in fees in one UTC day.
 *
 * The two escrow caps above bound the USDC that moves, and the onboarding budget bounds the
 * reserves the sponsor locks. Neither sees the fees: every value route ends with the sponsor
 * signing a transaction whose fee it pays. On the Soroban relays the inner fee may be up to 2 XLM
 * (V2_DEPOSIT_FEE_CAP, lib/soroban-relay.ts), and the fee-bump around it BIDS base x (inner ops + 1)
 * plus the resource fee, so one relay can bid 4 XLM and more; an honest deposit bids about
 * 0.42-0.57 XLM and a claim about 0.2 XLM plus its resource fee. Thirty requests a minute per
 * address against a float of about 130 XLM is a float gone in minutes, with every request inside
 * the rules.
 * This counter is the bound: the fee each route is about to BID is added to the day's total
 * BEFORE the signer is asked for anything, and a total past `MAX_DAY_FEE_XLM` is refused with a
 * sentence the caller may read on any network.
 *
 * WHO IS CHARGED: every route where the sponsor's own account pays. The Horizon fee-bumps
 * (/feebump, /send-link, /payout, /sweep) charge the fee-bump's declared fee; /create-account
 * charges the sandwich's fee on whichever path hands one out (the channel is sponsor money too; a
 * sandwich handed out is counted whether or not the client ever submits it, because this service
 * never sees that submission, and a channel sandwich abandoned for the sponsor path gives its own
 * charge back first); the Soroban relays (/v2-deposit, /v2-claim, /v2-reclaim) and /cctp-relay
 * charge their envelope's fee. /faucet and /demo-link are NOT charged: the faucet key pays its own fee from its
 * own, separate float (two blast radii, lib/config.ts), and it does not exist on mainnet.
 *
 * Three rules that make it a ceiling rather than an estimate:
 *   - it counts the BID (the fee the envelope declares) from before the signature until the
 *     network DECIDES the transaction, so while one is in flight, or its outcome is unknown, the
 *     number is an upper bound on what it can cost however the network prices it (the base fee is
 *     "the maximum amount you are willing to pay per operation", and a fee-bump's fee is the base
 *     fee times the inner operations plus one, plus any Soroban resource fee:
 *     https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering and
 *     https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions);
 *   - a charge moves only on an answer that decides the fee, never on a guess (`FeeCharge`). The
 *     whole bid comes back when the transaction provably never reached a ledger: the signer threw
 *     before any signature existed, or the network refused it while validating it (a Soroban RPC
 *     `ERROR` or `TRY_AGAIN_LATER`, a JSON-RPC refusal, a Horizon 4xx that never reached core, or a
 *     Horizon refusal whose result code core only returns while validating). An INCLUDED
 *     transaction, SUCCESS or FAILED, pays its fee, and the count drops to the fee its result
 *     reports (`TransactionResult.feeCharged`), which is never above the bid. Everything else (a
 *     timeout, a 5xx, NOT_FOUND after the window, a result that does not parse) keeps the whole
 *     bid. So the count is at or above the day's real spend at every moment;
 *   - the store being unreadable degrades to the per-isolate counter below rather than refusing,
 *     for the same reason the onboarding budget does: this bound sits on the EXIT routes too
 *     (/v2-claim, /feebump, /sweep, /v2-reclaim), and a recipient must never be refused money
 *     already escrowed for them because a counter store had a bad minute. The halt switch and the
 *     watchdog are the stops that need no store.
 *
 * WHY CHARGES COME BACK NOW (2026-10-08, amending "never released" in the D3 brief). The first cut
 * never gave anything back, and a review measured what that bought. A well-formed transaction the
 * network refuses before inclusion costs its sender nothing, yet its bid stayed counted: about
 * 30,000 junk /sweep posts, or about 20 stale-sequence deposits, spent mainnet's 15 XLM, after which
 * every exit (claims, reclaims, sweeps) refused until UTC midnight. A KMS outage did the same with
 * retries that were never signed. And counting bids alone overstated an honest day about
 * thirty-fold (a relayed deposit bids about 0.5 XLM and is charged about 0.02), so the budget
 * bounded traffic, not spend. Giving back only what a decided answer proves unspent keeps the one
 * property the budget exists for, a count at or above what the sponsor really paid.
 * ------------------------------------------------------------------------------------------ */

/** The public refusal, kept to one sentence so the claim screen can show it (lib/claim-error.ts). */
export const FEE_BUDGET_REFUSAL = "today's sponsor fee budget is spent; try again tomorrow";

/** Mainnet is a capped pilot; testnet is play money and must never refuse a demo over fees. */
const DEFAULT_MAX_DAY_FEE_XLM: Record<string, number> = { mainnet: 15, testnet: 2000 };

export interface FeeBudget {
  /** Largest sum of fee bids in one rolling UTC day, in stroops. */
  maxDayFeeStroops: bigint;
}

/** `MAX_DAY_FEE_XLM`, read at call time (the Worker hydrates process.env per request). */
export function feeBudgetFromEnv(network = process.env.STELLAR_NETWORK ?? "testnet"): FeeBudget {
  const raw = process.env.MAX_DAY_FEE_XLM;
  const n = raw ? Number.parseFloat(raw) : Number.NaN;
  const xlm = Number.isFinite(n) && n > 0 ? n : (DEFAULT_MAX_DAY_FEE_XLM[network] ?? DEFAULT_MAX_DAY_FEE_XLM.testnet!);
  return { maxDayFeeStroops: BigInt(Math.floor(xlm * Number(USDC_STROOPS))) };
}

/** The fee bucket, same shape and namespacing as `dayKey`, counting stroops of fee bids. */
export function feeDayKey(now: number, network = process.env.STELLAR_NETWORK ?? "testnet"): string {
  return `caps:${network}:fees:${utcDay(now)}`;
}

/** The per-isolate fallback, reached only while the shared store cannot be read. */
let localFeeDay = "";
let localFeeStroops = 0n;
/** The per-isolate twin of the gross key: accepted bids, never reduced by a give-back or a true-up. */
let localFeeGross = 0n;

function addToLocalFees(delta: bigint, dayMarker: string, gross = 0n): bigint {
  if (dayMarker !== localFeeDay) {
    if (delta < 0n) return 0n; // a give-back for a day that rolled has nothing to give back to
    localFeeDay = dayMarker;
    localFeeStroops = 0n;
    localFeeGross = 0n;
  }
  localFeeStroops = localFeeStroops + delta < 0n ? 0n : localFeeStroops + delta;
  localFeeGross = localFeeGross + gross < 0n ? 0n : localFeeGross + gross;
  return localFeeStroops;
}

/**
 * The day's GROSS fee key: every bid the budget accepted, never reduced by a give-back or a
 * true-up (a refusal undoes its own increment here too, since nothing was signed). The net key is
 * the bound; this one is the record of how much traffic reached the step before a signature. With
 * give-backs, a transaction that got past every guard, was signed and was then refused by the
 * network leaves the net where it was, so only the gross shows it: the scripted adversarial run
 * reads it (`/health` `fees.grossXlm`) to prove its junk never got that far.
 */
export function feeGrossDayKey(now: number, network = process.env.STELLAR_NETWORK ?? "testnet"): string {
  return `${feeDayKey(now, network)}:gross`;
}

/**
 * A fee bid as the SDK hands it over: a fee-bump's `.fee` is a decimal string of stroops, a
 * classic tx's `.fee` the same, and a hand-computed bid a number. Whole stroops only; a fraction
 * of a number rounds UP (the bound errs toward "spent"); anything else is a programming error,
 * not a refusal, and nothing is counted for it.
 */
function toStroops(fee: bigint | number | string): bigint {
  let n: bigint;
  if (typeof fee === "bigint") n = fee;
  else if (typeof fee === "number") {
    if (!Number.isFinite(fee)) throw new Error("a fee bid must be a finite number of stroops");
    n = BigInt(Math.ceil(fee));
  } else {
    const s = fee.trim();
    if (!/^-?\d+$/.test(s)) throw new Error(`a fee bid must be a whole number of stroops, got "${fee}"`);
    n = BigInt(s);
  }
  if (n < 0n) throw new Error("a fee bid cannot be negative");
  return n;
}

/**
 * One charge against the day's fee budget, and the only two ways it may move afterwards. Each
 * handle settles at most once: the first call to either method decides, later calls do nothing, so
 * a route cannot give the same bid back twice. A route that never calls either keeps the whole bid
 * counted, which is the safe default for every outcome it cannot name.
 */
export interface FeeCharge {
  /** The day's total right after this charge, in stroops. */
  totalStroops: bigint;
  /** False when the shared store was unreadable and the per-isolate counter took the charge. */
  shared: boolean;
  /** The bid this charge counted, in stroops. */
  bidStroops: bigint;
  /**
   * The transaction never reached a ledger: the signer threw before any signature existed, or the
   * network refused it while validating it (the header lists the answers that prove that). The
   * whole bid comes back. Never call this for an answer that leaves the outcome open.
   */
  notIncluded(): Promise<void>;
  /**
   * The ledger included the transaction (SUCCESS or FAILED) and its result says it charged
   * `feeCharged` stroops: the count drops from the bid to that. A value that does not parse, or one
   * above the bid, changes nothing and still closes the handle.
   */
  settled(feeCharged: bigint | number | string | null | undefined): Promise<void>;
}

/** A ledger-reported fee as whole stroops, or null for anything that is not one. Never throws. */
function chargedStroops(v: bigint | number | string | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  try {
    return toStroops(v);
  } catch {
    return null;
  }
}

/**
 * Add `feeBid` (stroops; the envelope's declared fee) to the day's sponsor fee total, or refuse.
 *
 * Call this AFTER every guard has passed and immediately BEFORE the sponsor signs, on every route
 * where the sponsor pays the fee. Throws a `PublicRefusal` past the budget; the refused increment
 * is undone, because nothing was signed. On success it hands back a `FeeCharge`: call
 * `notIncluded()` or `settled(feeCharged)` once the network has DECIDED the transaction, and
 * nothing at all when it has not (see the header above).
 */
export async function chargeSponsorFee(
  feeBid: bigint | number | string,
  budget = feeBudgetFromEnv(),
  now = Date.now(),
): Promise<FeeCharge> {
  const fee = toStroops(feeBid);
  // The day the charge landed in. A give-back after midnight goes to THAT day, never to the new one.
  const key = feeDayKey(now);
  const grossKey = feeGrossDayKey(now);
  const kv = kvConfigFromEnv();
  let total: bigint;
  let shared = true;
  if (!kv) {
    total = addToLocalFees(fee, key, fee);
    shared = false;
  } else {
    try {
      // The net and the gross move in one round trip; only the net is compared with the budget.
      [total] = (await addToDays(kv, [key, grossKey], fee)) as [bigint, bigint];
    } catch (e) {
      console.warn(`[caps] fee counter unavailable, bounding per isolate: ${(e as Error).message}`);
      total = addToLocalFees(fee, key, fee);
      shared = false;
    }
  }
  if (total > budget.maxDayFeeStroops) {
    // Nothing was signed, so this increment is the one kind that can honestly be undone, in both keys.
    if (shared) await addToDays(kv!, [key, grossKey], -fee).catch(() => {});
    else addToLocalFees(-fee, key, -fee);
    throw new PublicRefusal(FEE_BUDGET_REFUSAL);
  }

  let open = true;
  const giveBack = async (stroops: bigint): Promise<void> => {
    if (!open) return;
    open = false;
    if (stroops <= 0n) return;
    if (!shared) {
      addToLocalFees(-stroops, key);
      return;
    }
    try {
      await addToDay(kv!, key, -stroops);
    } catch (e) {
      // The count stays high, which is the safe direction for a ceiling; nothing else to do.
      console.warn(`[caps] fee give-back not recorded, the count stays high: ${(e as Error).message}`);
    }
  };
  return {
    totalStroops: total,
    shared,
    bidStroops: fee,
    notIncluded: () => giveBack(fee),
    settled: async (feeCharged) => {
      const charged = chargedStroops(feeCharged);
      if (charged === null || charged > fee) {
        open = false;
        return;
      }
      await giveBack(fee - charged);
    },
  };
}

/**
 * Run the signature for a charged transaction. A signer that throws produced nothing that can be
 * submitted, so the charge comes back before the error goes on: a KMS outage must not spend the
 * day's budget on retries that were never signed.
 */
export async function signCharged(charge: FeeCharge, sign: () => void | Promise<void>): Promise<void> {
  try {
    await sign();
  } catch (e) {
    await charge.notIncluded();
    throw e;
  }
}

export interface FeeDayReading {
  day: string;
  /** The day's count (bids in flight or undecided, charges once decided), in stroops; null when the shared store could not be read. */
  spentStroops: bigint | null;
  /** Every bid the budget accepted today, never reduced by a give-back; null when unreadable. */
  grossStroops: bigint | null;
  maxStroops: bigint;
  /** 0..1 of the budget used (null while the store is unreadable). */
  used: number | null;
}

/** One `/get/<key>` read as stroops: 0 for a missing key, null for a store that did not answer. */
async function getStroops(kv: KvConn, key: string): Promise<bigint | null> {
  try {
    const res = await fetch(`${kv.url}/get/${key}`, { headers: { authorization: `Bearer ${kv.token}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown };
    return body.result == null ? 0n : BigInt(String(body.result));
  } catch {
    return null;
  }
}

/** Today's fee totals as /health and the watchdog read them: GETs, never a write. */
export async function readSponsorFeeDay(
  budget = feeBudgetFromEnv(),
  now = Date.now(),
): Promise<FeeDayReading> {
  const key = feeDayKey(now);
  const day = key.slice(key.lastIndexOf(":") + 1);
  const max = budget.maxDayFeeStroops;
  const kv = kvConfigFromEnv();
  if (!kv) {
    const mine = localFeeDay === key;
    const local = mine ? localFeeStroops : 0n;
    return {
      day,
      spentStroops: local,
      grossStroops: mine ? localFeeGross : 0n,
      maxStroops: max,
      used: max > 0n ? Number(local) / Number(max) : null,
    };
  }
  const [spent, gross] = await Promise.all([getStroops(kv, key), getStroops(kv, feeGrossDayKey(now))]);
  return {
    day,
    spentStroops: spent,
    grossStroops: gross,
    maxStroops: max,
    used: spent === null ? null : max > 0n ? Number(spent) / Number(max) : null,
  };
}
