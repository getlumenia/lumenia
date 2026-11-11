// Daily caps and a per-sender cooldown. The store is a tiny key-value
// interface: Cloudflare KV on the deployed Worker, a Map for local runs and
// tests. Counts are read-modify-write, so two relays landing in the same
// millisecond on two Worker isolates can both pass; the caps bound abuse,
// they are not an accounting ledger.

export interface CapLimits {
  perSenderPerDay: number;
  globalPerDay: number;
  senderCooldownS: number;
}

export const DEFAULT_CAPS: CapLimits = { perSenderPerDay: 20, globalPerDay: 500, senderCooldownS: 10 };

export interface CapStore {
  get(key: string): Promise<string | null>;
  /** ttlSeconds: how long the value lives; stores may round it up (KV needs at least 60). */
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** In-memory store with expiry, for `pnpm relayer:local` and the tests. */
export class MemoryCapStore implements CapStore {
  private readonly items = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    const item = this.items.get(key);
    if (!item) return null;
    if (item.expiresAt <= this.now()) {
      this.items.delete(key);
      return null;
    }
    return item.value;
  }

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.items.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  size(): number {
    return this.items.size;
  }
}

/** The subset of a Cloudflare KVNamespace the relayer uses (kept structural to avoid a types dependency). */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
}

export function kvCapStore(kv: KvLike): CapStore {
  return {
    get: (key) => kv.get(key),
    put: async (key, value, ttlSeconds) => {
      await kv.put(key, value, { expirationTtl: Math.max(60, Math.ceil(ttlSeconds)) });
    },
  };
}

export type CapCode = "cooldown" | "sender_daily" | "global_daily";

export type CapDecision = { ok: true } | { ok: false; code: CapCode; reason: string; retryAfterS: number };

export interface CapSnapshot {
  day: string;
  globalToday: number;
  senderToday?: number;
  limits: CapLimits;
  resetsInS: number;
}

const DAY_MS = 86_400_000;

export function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function secondsToDayEnd(nowMs: number): number {
  return Math.ceil((DAY_MS - (nowMs % DAY_MS)) / 1000);
}

export class Caps {
  constructor(
    private readonly store: CapStore,
    readonly limits: CapLimits = DEFAULT_CAPS,
    private readonly now: () => number = Date.now,
  ) {}

  private keys(senderId: string, nowMs: number) {
    const day = dayKey(nowMs);
    return {
      cooldown: `cool:${senderId}`,
      sender: `day:${day}:sender:${senderId}`,
      global: `day:${day}:global`,
    };
  }

  /** Read-only: would a relay for this sender pass right now? */
  async check(senderId: string): Promise<CapDecision> {
    const nowMs = this.now();
    const k = this.keys(senderId, nowMs);
    const { perSenderPerDay, globalPerDay, senderCooldownS } = this.limits;

    const last = await this.store.get(k.cooldown);
    if (last !== null) {
      const elapsedS = (nowMs - Number(last)) / 1000;
      if (elapsedS >= 0 && elapsedS < senderCooldownS) {
        const wait = Math.max(1, Math.ceil(senderCooldownS - elapsedS));
        return {
          ok: false,
          code: "cooldown",
          reason: `one relay per sender every ${senderCooldownS} s: try again in ${wait} s`,
          retryAfterS: wait,
        };
      }
    }
    const senderCount = toCount(await this.store.get(k.sender));
    if (senderCount >= perSenderPerDay) {
      return {
        ok: false,
        code: "sender_daily",
        reason: `daily cap reached for ${senderId}: ${perSenderPerDay} relays per sender per day (UTC)`,
        retryAfterS: secondsToDayEnd(nowMs),
      };
    }
    const globalCount = toCount(await this.store.get(k.global));
    if (globalCount >= globalPerDay) {
      return {
        ok: false,
        code: "global_daily",
        reason: `the relayer's daily cap of ${globalPerDay} relays is used up for today (UTC)`,
        retryAfterS: secondsToDayEnd(nowMs),
      };
    }
    return { ok: true };
  }

  /** Count one relay for the sender (called before the transaction is sent, so a failed send still counts). */
  async record(senderId: string): Promise<void> {
    const nowMs = this.now();
    const k = this.keys(senderId, nowMs);
    const dayTtl = secondsToDayEnd(nowMs) + 60;
    await this.store.put(k.cooldown, String(nowMs), Math.max(1, this.limits.senderCooldownS));
    const senderCount = toCount(await this.store.get(k.sender));
    await this.store.put(k.sender, String(senderCount + 1), dayTtl);
    const globalCount = toCount(await this.store.get(k.global));
    await this.store.put(k.global, String(globalCount + 1), dayTtl);
  }

  async snapshot(senderId?: string): Promise<CapSnapshot> {
    const nowMs = this.now();
    const k = this.keys(senderId ?? "-", nowMs);
    const snap: CapSnapshot = {
      day: dayKey(nowMs),
      globalToday: toCount(await this.store.get(k.global)),
      limits: this.limits,
      resetsInS: secondsToDayEnd(nowMs),
    };
    if (senderId) snap.senderToday = toCount(await this.store.get(k.sender));
    return snap;
  }
}

function toCount(v: string | null): number {
  const n = v === null ? 0 : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
