/**
 * Rate limiting — per-IP and per-account (SOW D1 hardening).
 *
 * Two backends, picked per request:
 *  - DURABLE (cross-instance): a fixed-window counter in Upstash Redis / Vercel KV
 *    over its REST API, enabled when `KV_REST_API_URL`/`KV_REST_API_TOKEN` (or the
 *    `UPSTASH_REDIS_REST_*` pair) are set. This is what makes a concurrent burst
 *    against serverless reliably 429.
 *  - IN-MEMORY fallback: per-instance token buckets — used when no store is
 *    configured (local dev, integration test) or if the store errors mid-request.
 *
 * Fee-abuse is also bounded structurally: the fee cap in /feebump means each
 * accepted request costs the sponsor a fixed, tiny maximum. Full abuse-at-scale
 * handling stays out of SOW scope (mainnet upgrade).
 */

interface Bucket {
  tokens: number;
  ts: number;
}

/** A token-bucket keyed store: `true` = this request is over the limit. */
function makeBucketStore() {
  const buckets = new Map<string, Bucket>();
  return function limited(key: string, cap: number, windowMs: number, now: number): boolean {
    const b = buckets.get(key) ?? { tokens: cap, ts: now };
    const refill = ((now - b.ts) / windowMs) * cap;
    b.tokens = Math.min(cap, b.tokens + refill);
    b.ts = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      return true;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    return false;
  };
}

const ipStore = makeBucketStore();
const accountStore = makeBucketStore();

export interface RateLimitConfig {
  ipCap: number;
  ipWindowMs: number;
  accountCap: number;
  accountWindowMs: number;
}

export function rateLimitConfigFromEnv(): RateLimitConfig {
  const int = (name: string, fallback: number) => {
    const v = process.env[name];
    const n = v ? Number.parseInt(v, 10) : NaN;
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    ipCap: int("RATE_CAP", 30),
    ipWindowMs: int("RATE_WINDOW_MS", 60_000),
    accountCap: int("ACCOUNT_RATE_CAP", 5),
    accountWindowMs: int("ACCOUNT_RATE_WINDOW_MS", 60_000),
  };
}

export interface RateLimitVerdict {
  limited: boolean;
  reason?: string;
}

/** Enforce per-IP then per-account limits. `account` is the recipient pubkey (if known). */
export function checkRateLimit(
  ip: string,
  account: string | undefined,
  cfg: RateLimitConfig,
  now: number,
): RateLimitVerdict {
  if (ipStore(`ip:${ipBucket(ip)}`, cfg.ipCap, cfg.ipWindowMs, now)) {
    return { limited: true, reason: "per-IP rate limit exceeded" };
  }
  if (account && accountStore(`acct:${account}`, cfg.accountCap, cfg.accountWindowMs, now)) {
    return { limited: true, reason: "per-account rate limit exceeded" };
  }
  return { limited: false };
}

/* ---------- durable (cross-instance) backend: Upstash Redis / Vercel KV REST ---------- */

interface KvConfig {
  url: string;
  token: string;
}

/**
 * Collapse an address to the unit an operator actually controls, so "per-IP" means something.
 *
 * A single residential IPv6 allocation is a /64 — 18 quintillion addresses. Keying the full
 * address let one attacker present a fresh "IP" per request, which quietly turned every per-IP cap
 * in this service into no cap at all (and that is what made the OTP and free-account limits worth
 * attacking). IPv4 is already one address per host, so it passes through unchanged.
 */
export function ipBucket(ip: string): string {
  if (!ip.includes(":")) return ip; // IPv4, or "unknown"
  const addr = ip.split("%")[0]!.toLowerCase(); // drop any zone index
  const [head, tail] = addr.includes("::") ? addr.split("::") : [addr, undefined];
  const headGroups = head ? head.split(":").filter(Boolean) : [];
  const tailGroups = tail ? tail.split(":").filter(Boolean) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const full = [...headGroups, ...Array(Math.max(0, missing)).fill("0"), ...tailGroups];
  return `${full.slice(0, 4).join(":")}::/64`;
}

/** Vercel KV exposes the Upstash REST pair under KV_*; plain Upstash under UPSTASH_*. */
export function kvConfigFromEnv(): KvConfig | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

/** Fixed-window counter in the shared store: `true` = this request is over the limit. */
async function kvLimited(kv: KvConfig, key: string, cap: number, windowMs: number, now: number): Promise<boolean> {
  const windowKey = `rl:${key}:${Math.floor(now / windowMs)}`;
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify([
      ["INCR", windowKey],
      ["PEXPIRE", windowKey, String(windowMs)],
    ]),
  });
  if (!res.ok) throw new Error(`KV rate-limit store returned ${res.status}`);
  const [first] = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  if (!first || first.error) throw new Error(`KV rate-limit store error: ${first?.error}`);
  return Number(first.result) > cap;
}

/**
 * Durable per-IP + per-account limits when a KV store is configured; otherwise the
 * in-memory buckets. A store failure degrades to in-memory (never blocks a claim
 * on the limiter's own infrastructure).
 */
export async function checkRateLimitDurable(
  ip: string,
  account: string | undefined,
  cfg: RateLimitConfig,
  now: number,
): Promise<RateLimitVerdict> {
  const kv = kvConfigFromEnv();
  if (!kv) return checkRateLimit(ip, account, cfg, now);
  try {
    if (await kvLimited(kv, `ip:${ipBucket(ip)}`, cfg.ipCap, cfg.ipWindowMs, now)) {
      return { limited: true, reason: "per-IP rate limit exceeded" };
    }
    if (account && (await kvLimited(kv, `acct:${account}`, cfg.accountCap, cfg.accountWindowMs, now))) {
      return { limited: true, reason: "per-account rate limit exceeded" };
    }
    return { limited: false };
  } catch (e) {
    console.warn(`rate-limit store unavailable, falling back to in-memory: ${(e as Error).message}`);
    return checkRateLimit(ip, account, cfg, now);
  }
}
