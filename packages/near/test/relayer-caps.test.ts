import { describe, expect, it } from "vitest";
import { Caps, MemoryCapStore, dayKey, kvCapStore, secondsToDayEnd } from "../src/relayer/caps.js";

function clock(start = Date.UTC(2026, 10, 11, 12, 0, 0)) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
}

describe("caps", () => {
  it("cools a sender down for 10 s after a relay", async () => {
    const c = clock();
    const caps = new Caps(new MemoryCapStore(c.now), { perSenderPerDay: 20, globalPerDay: 500, senderCooldownS: 10 }, c.now);
    expect(await caps.check("a.testnet")).toEqual({ ok: true });
    await caps.record("a.testnet");
    const d = await caps.check("a.testnet");
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.code).toBe("cooldown");
      expect(d.retryAfterS).toBeLessThanOrEqual(10);
      expect(d.retryAfterS).toBeGreaterThan(0);
    }
    expect((await caps.check("b.testnet")).ok).toBe(true);
    c.tick(9_000);
    expect((await caps.check("a.testnet")).ok).toBe(false);
    c.tick(1_001);
    expect((await caps.check("a.testnet")).ok).toBe(true);
  });

  it("stops a sender at 20 relays per UTC day and lets another sender through", async () => {
    const c = clock();
    const caps = new Caps(new MemoryCapStore(c.now), { perSenderPerDay: 20, globalPerDay: 500, senderCooldownS: 10 }, c.now);
    for (let i = 0; i < 20; i++) {
      expect((await caps.check("a.testnet")).ok).toBe(true);
      await caps.record("a.testnet");
      c.tick(11_000);
    }
    const d = await caps.check("a.testnet");
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.code).toBe("sender_daily");
      expect(d.retryAfterS).toBe(secondsToDayEnd(c.now()));
    }
    expect((await caps.check("b.testnet")).ok).toBe(true);
    const snap = await caps.snapshot("a.testnet");
    expect(snap.globalToday).toBe(20);
    expect(snap.senderToday).toBe(20);
  });

  it("stops everyone at the global daily cap", async () => {
    const c = clock();
    const caps = new Caps(new MemoryCapStore(c.now), { perSenderPerDay: 100, globalPerDay: 3, senderCooldownS: 0 }, c.now);
    for (const s of ["a", "b", "c"]) {
      expect((await caps.check(`${s}.testnet`)).ok).toBe(true);
      await caps.record(`${s}.testnet`);
    }
    const d = await caps.check("d.testnet");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("global_daily");
  });

  it("resets at the UTC day boundary", async () => {
    const c = clock(Date.UTC(2026, 10, 11, 23, 59, 50));
    const caps = new Caps(new MemoryCapStore(c.now), { perSenderPerDay: 1, globalPerDay: 1, senderCooldownS: 0 }, c.now);
    await caps.record("a.testnet");
    expect((await caps.check("a.testnet")).ok).toBe(false);
    expect(dayKey(c.now())).toBe("2026-11-11");
    c.tick(20_000);
    expect(dayKey(c.now())).toBe("2026-11-12");
    expect((await caps.check("a.testnet")).ok).toBe(true);
    expect((await caps.snapshot()).globalToday).toBe(0);
  });

  it("secondsToDayEnd counts to the next UTC midnight", () => {
    expect(secondsToDayEnd(Date.UTC(2026, 10, 11, 23, 59, 59))).toBe(1);
    expect(secondsToDayEnd(Date.UTC(2026, 10, 11, 0, 0, 0))).toBe(86_400);
  });

  it("MemoryCapStore forgets expired values", async () => {
    const c = clock();
    const store = new MemoryCapStore(c.now);
    await store.put("k", "v", 5);
    expect(await store.get("k")).toBe("v");
    c.tick(5_001);
    expect(await store.get("k")).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("kvCapStore rounds the TTL up to KV's 60 s minimum", async () => {
    const calls: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
    const store = kvCapStore({
      get: async () => null,
      put: async (key, value, options) => {
        calls.push({ key, value, options });
      },
    });
    await store.put("cool:a", "1", 10);
    await store.put("day:x", "2", 3600.4);
    expect(calls[0]?.options?.expirationTtl).toBe(60);
    expect(calls[1]?.options?.expirationTtl).toBe(3601);
  });
});
