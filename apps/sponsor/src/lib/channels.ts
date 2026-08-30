/**
 * Channel-account pool — the C1 concurrency fix.
 *
 * PROBLEM: the sponsor builds onboarding txs with tx.source = sponsor, so its ONE
 * sequence number serializes every concurrent claim → a viral link → tx_bad_seq for
 * everyone but the first (proven by spike8: 1/20 succeed).
 *
 * FIX: a POOL of sponsor-controlled "channel" accounts, each LENDING its sequence
 * number to one concurrent onboarding. Different concurrent requests use different
 * channels → independent sequences → no collision (spike8: 20/20, 0 tx_bad_seq). This
 * is the exact pattern in Stellar's official "channel accounts" guide.
 *
 * WORKERS REALITY: the sponsor is a Cloudflare Worker; isolates don't share memory,
 * so an in-memory free-list is unsafe under the exact viral load we're fixing. Two
 * isolates could hand out the same channel + sequence. Coordination therefore uses an
 * EXCLUSIVE LEASE in the shared store (the same Upstash Redis the rate-limiter uses):
 * `SET chan:<pub> <token> NX EX <ttl>` is atomic across isolates — exactly one wins.
 * The lease value is a per-lease TOKEN so release() is FENCED (compare-and-delete): a
 * slow isolate whose lease already TTL-expired cannot delete a successor's fresh lease.
 *
 * WHY A LEASE (not a reserved-sequence counter): the create-account client submits the
 * tx itself, and the sequence is BAKED into the XDR the client signs — the server can't
 * retry with a fresh sequence without a re-sign. A monotonic counter would jam on the
 * first abandoned handout (a gap poisons every later sequence). So each channel serves
 * ONE in-flight onboarding at a time (exclusive lease). The lease TTL MUST exceed the
 * tx's timebound, so an abandoned (never-submitted) handout's tx is dead (tx_too_late)
 * before the channel is reused — otherwise a late submit could still land and collide.
 * INVARIANT: any tx built on a leased channel MUST carry maxTime < the lease TTL, and
 * the channel's sequence MUST be read FRESH from chain at each lease (never cached).
 *
 * Empty CHANNEL_SECRETS ⇒ the pool is disabled and callers fall back to the
 * sponsor-sourced path (backward compatible — never worse than today).
 */
import { Keypair } from "@stellar/stellar-sdk";
import { kvConfigFromEnv } from "./rate-limit.js";

/** Exclusive-lease lifetime (seconds). MUST exceed CHANNEL_TX_TIMEOUT_SECONDS. */
export const CHANNEL_LEASE_TTL_SECONDS = 150;
/** Timebound (seconds) of a tx built on a leased channel. MUST be < the lease TTL. */
export const CHANNEL_TX_TIMEOUT_SECONDS = 120;

// The whole TTL>timebound safety (an abandoned handout dies before its channel is
// reused) collapses if this is ever violated — fail loudly at load, not silently at scale.
if (CHANNEL_TX_TIMEOUT_SECONDS >= CHANNEL_LEASE_TTL_SECONDS) {
  throw new Error(
    `channel invariant violated: CHANNEL_TX_TIMEOUT_SECONDS (${CHANNEL_TX_TIMEOUT_SECONDS}) must be < CHANNEL_LEASE_TTL_SECONDS (${CHANNEL_LEASE_TTL_SECONDS})`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A minimal exclusive-lease store with FENCED release (compare-and-delete on a token). */
export interface LeaseStore {
  /** Try to take an exclusive lease on `key` for `ttlSeconds`. Returns the lease token on
   *  success, or null if the key is already leased. */
  acquire(key: string, ttlSeconds: number): Promise<string | null>;
  /** Release the lease ONLY if `token` still owns it (fences against a TTL-expired holder
   *  deleting a successor's lease). Best-effort; the TTL is the backstop. */
  release(key: string, token: string): Promise<void>;
}

function newToken(): string {
  return crypto.randomUUID();
}

/* ---------- durable (cross-isolate) backend: Upstash Redis / Vercel KV REST ---------- */

interface KvConfig {
  url: string;
  token: string;
}

function redisLeaseStore(kv: KvConfig): LeaseStore {
  const pipeline = async (cmd: unknown[]): Promise<unknown> => {
    const res = await fetch(`${kv.url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
      body: JSON.stringify([cmd]),
    });
    if (!res.ok) throw new Error(`channel lease store returned ${res.status}`);
    const [first] = (await res.json()) as Array<{ result?: unknown; error?: string }>;
    if (!first || first.error) throw new Error(`channel lease store error: ${first?.error}`);
    return first.result;
  };
  // Compare-and-delete: only the token that owns the key may release it.
  const FENCED_DEL = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  return {
    // SET NX returns "OK" when the key was set (lease acquired) or null when it already
    // exists (still leased by another isolate) — an atomic compare-and-set.
    async acquire(key, ttlSeconds) {
      const token = newToken();
      const ok = (await pipeline(["SET", key, token, "NX", "EX", String(ttlSeconds)])) === "OK";
      return ok ? token : null;
    },
    async release(key, token) {
      try {
        await pipeline(["EVAL", FENCED_DEL, "1", key, token]);
      } catch {
        /* best-effort — the TTL will reclaim the channel regardless */
      }
    },
  };
}

/* ---------- in-memory fallback: single-process only (local dev / integration test) ---------- */

export function memoryLeaseStore(): LeaseStore {
  const leases = new Map<string, { token: string; expiry: number }>();
  return {
    async acquire(key, ttlSeconds) {
      const now = Date.now();
      const cur = leases.get(key);
      if (cur !== undefined && cur.expiry > now) return null; // still leased
      const token = newToken();
      leases.set(key, { token, expiry: now + ttlSeconds * 1000 });
      return token;
    },
    async release(key, token) {
      const cur = leases.get(key);
      if (cur && cur.token === token) leases.delete(key); // fenced
    },
  };
}

/**
 * Pick the lease backend. Durable (shared) when a KV store is configured; in-memory
 * otherwise. NOTE: in-memory is per-isolate and therefore only correct on a single
 * instance (local/test). On a multi-isolate serverless deploy, channels REQUIRE the KV
 * store — on mainnet a pool without it disables itself rather than lease per-isolate (see
 * ChannelManager).
 */
export function defaultLeaseStore(): LeaseStore {
  const kv = kvConfigFromEnv();
  return kv ? redisLeaseStore(kv) : memoryLeaseStore();
}

export interface ChannelLease {
  /** The channel keypair (sponsor-controlled). It sources the tx + signs as the source. */
  keypair: Keypair;
  publicKey: string;
  /** Drop the lease early — call after the tx CONFIRMS on server-submit paths. Fenced:
   *  a no-op if this lease already TTL-expired and the channel was re-leased. */
  release(): Promise<void>;
}

/**
 * Holds the channel keypairs + the lease store. Constructed once per service instance.
 */
export class ChannelManager {
  private readonly keypairs: Keypair[];
  private readonly store: LeaseStore;
  /** true when at least one channel is configured AND the pool may safely hand out leases. */
  readonly enabled: boolean;
  /** true when channels are configured but only an in-memory (per-isolate) store exists. */
  readonly inMemoryOnly: boolean;

  constructor(channelSecrets: string[], store?: LeaseStore) {
    this.keypairs = channelSecrets.map((s) => Keypair.fromSecret(s));
    this.store = store ?? defaultLeaseStore();
    this.inMemoryOnly = this.keypairs.length > 0 && !store && kvConfigFromEnv() === null;
    // Per-isolate leasing hands the same channel + sequence to two isolates at once — the exact
    // collision the pool exists to remove — so on mainnet the pool stays SHUT. Shut, not fatal:
    // this runs inside the per-request service bootstrap, so a throw here would 400 every route,
    // including the claim of money already escrowed on the ledger.
    const unsafeOnMainnet = this.inMemoryOnly && process.env.STELLAR_NETWORK === "mainnet";
    this.enabled = this.keypairs.length > 0 && !unsafeOnMainnet;
    if (unsafeOnMainnet) {
      console.error(
        "[channels] CHANNEL_SECRETS is set on mainnet but no KV store is configured " +
          "(KV_REST_API_URL/KV_REST_API_TOKEN) — leasing would be per-isolate and two isolates " +
          "could lend the same channel sequence. The pool is DISABLED: every onboarding falls back " +
          "to the sponsor-sourced path (serialized under concurrency). Configure the KV store to " +
          "bring channels back.",
      );
    } else if (this.inMemoryOnly) {
      console.warn(
        "[channels] CHANNEL_SECRETS set but no KV store (KV_REST_API_URL/TOKEN) — leasing is " +
          "IN-MEMORY (per-isolate). Safe for a single instance; UNSAFE on a multi-isolate deploy. " +
          "Configure the KV store before relying on channels under concurrency.",
      );
    }
  }

  get size(): number {
    return this.keypairs.length;
  }

  publicKeys(): string[] {
    return this.keypairs.map((k) => k.publicKey());
  }

  /**
   * Acquire an exclusive lease on a free channel. Scans every channel once from a
   * randomized start (spreads load across isolates), then briefly retries to ride out a
   * transiently-full pool. Returns null if none free OR the store is unavailable — the
   * caller then falls back to the sponsor-sourced path (never worse than today).
   */
  async lease(opts?: { attempts?: number; delayMs?: number }): Promise<ChannelLease | null> {
    if (!this.enabled) return null;
    const attempts = opts?.attempts ?? 6;
    const delayMs = opts?.delayMs ?? 250;
    const n = this.keypairs.length;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const start = Math.floor(Math.random() * n);
      for (let i = 0; i < n; i++) {
        const kp = this.keypairs[(start + i) % n]!;
        const key = `chan:${kp.publicKey()}`;
        let token: string | null;
        try {
          token = await this.store.acquire(key, CHANNEL_LEASE_TTL_SECONDS);
        } catch (e) {
          // Store failure ⇒ give up on channels for this request (fall back). Never block
          // an onboarding on the pool's own infrastructure.
          console.warn(`[channels] lease store unavailable, falling back: ${(e as Error).message}`);
          return null;
        }
        if (token !== null) {
          const t = token;
          return { keypair: kp, publicKey: kp.publicKey(), release: () => this.store.release(key, t) };
        }
      }
      if (attempt < attempts - 1) await sleep(delayMs);
    }
    return null; // pool exhausted — caller falls back
  }
}
