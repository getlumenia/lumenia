/**
 * Offline correctness tests for the channel-lease manager (C1 fix, no network).
 *
 * The lease is what guarantees no two concurrent onboardings ever borrow the same
 * channel sequence. These tests pin the invariants the exclusive-lease design rests on:
 *   D  store atomicity        — acquire is a compare-and-set; a held key can't be re-taken
 *   E  store TTL expiry       — a lease auto-releases after its TTL (abandoned handouts)
 *   A  distinct under load     — N concurrent leases over N channels → N distinct, 0 dupes
 *   B  bounded by pool size    — N+K concurrent over N channels → exactly N leased, K null
 *   C  release → reuse         — releasing a channel returns it to the pool
 *   F  disabled when empty     — no CHANNEL_SECRETS ⇒ lease() returns null (fallback path)
 *   G  mainnet needs the store — a pool with only per-isolate leasing disables itself
 *
 * RUN: pnpm --filter @lumenia/sponsor test:channels   (offline, deterministic)
 */
import { Keypair } from "@stellar/stellar-sdk";
import { ACQUIRE_ANY_SCRIPT, ChannelManager, MAX_LEASE_PROBES, defaultLeaseStore, memoryLeaseStore } from "./lib/channels.js";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label} ${extra}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** N throwaway channel secrets — random keypairs, no funding needed for lease tests. */
function makeSecrets(n: number): string[] {
  return Array.from({ length: n }, () => Keypair.random().secret());
}

async function main() {
  console.log("============================================================");
  console.log(" CHANNEL-LEASE MANAGER — offline correctness");
  console.log("============================================================\n");

  /* --- D: store atomicity (compare-and-set) + FENCED release --- */
  console.log("[D] store atomicity — a held lease can't be re-acquired; release is fenced");
  {
    const store = memoryLeaseStore();
    const t1 = await store.acquire("chan:X", 100);
    const t2 = await store.acquire("chan:X", 100);
    ok("first acquire wins (returns a token)", typeof t1 === "string");
    ok("second acquire on a held key fails (null)", t2 === null);
    await store.release("chan:X", "wrong-token");
    ok("release with the WRONG token is a no-op (still held)", (await store.acquire("chan:X", 100)) === null);
    await store.release("chan:X", t1!);
    ok("release with the OWNING token frees it", typeof (await store.acquire("chan:X", 100)) === "string");
  }

  /* --- E: TTL expiry (abandoned handout self-heals) --- */
  console.log("\n[E] TTL expiry — a lease auto-releases after its TTL");
  {
    const store = memoryLeaseStore();
    ok("acquire with 1s TTL", typeof (await store.acquire("chan:Y", 1)) === "string");
    ok("still held before TTL", (await store.acquire("chan:Y", 1)) === null);
    await sleep(1150);
    ok("re-acquirable after TTL", typeof (await store.acquire("chan:Y", 1)) === "string");
  }

  /* --- A: N concurrent leases over N channels → all distinct --- */
  console.log("\n[A] N concurrent leases over N channels → N distinct, 0 duplicates");
  {
    const N = 20;
    const mgr = new ChannelManager(makeSecrets(N), memoryLeaseStore());
    const leases = await Promise.all(Array.from({ length: N }, () => mgr.lease({ attempts: 1 })));
    const got = leases.filter((l) => l !== null);
    const uniq = new Set(got.map((l) => l!.publicKey));
    ok(`all ${N} acquired a channel`, got.length === N, `(got ${got.length})`);
    ok("every lease is a DISTINCT channel (no double hand-out)", uniq.size === N, `(uniq ${uniq.size})`);
  }

  /* --- B: N+K concurrent over N channels → exactly N leased, K null --- */
  console.log("\n[B] over-subscription — 30 concurrent over 20 channels → 20 leased, 10 null");
  {
    const N = 20;
    const K = 10;
    const mgr = new ChannelManager(makeSecrets(N), memoryLeaseStore());
    const leases = await Promise.all(
      Array.from({ length: N + K }, () => mgr.lease({ attempts: 1 })),
    );
    const got = leases.filter((l) => l !== null);
    const nulls = leases.filter((l) => l === null);
    const uniq = new Set(got.map((l) => l!.publicKey));
    ok(`exactly ${N} leased`, got.length === N, `(got ${got.length})`);
    ok(`exactly ${K} fell back (null)`, nulls.length === K, `(got ${nulls.length})`);
    ok("no channel double-leased", uniq.size === got.length);
  }

  /* --- C: release → reuse --- */
  console.log("\n[C] release returns the channel to the pool");
  {
    const mgr = new ChannelManager(makeSecrets(2), memoryLeaseStore());
    const a = await mgr.lease({ attempts: 1 });
    const b = await mgr.lease({ attempts: 1 });
    const cNone = await mgr.lease({ attempts: 1 }); // pool of 2 exhausted
    ok("both channels leased", a !== null && b !== null);
    ok("third lease is null (pool exhausted)", cNone === null);
    await a!.release();
    const reused = await mgr.lease({ attempts: 1 });
    ok("after release, a channel is available again", reused !== null);
    ok("reused channel is the released one", reused!.publicKey === a!.publicKey);
  }

  /* --- F: disabled when no secrets --- */
  console.log("\n[F] disabled pool — no CHANNEL_SECRETS ⇒ lease() returns null (fallback)");
  {
    const mgr = new ChannelManager([], memoryLeaseStore());
    ok("enabled === false", mgr.enabled === false);
    ok("size === 0", mgr.size === 0);
    ok("lease() returns null", (await mgr.lease({ attempts: 1 })) === null);
  }

  /* --- G: mainnet disables a pool it can only lease per-isolate --- */
  console.log("\n[G] mainnet fail-closed — a configured pool with no shared store disables itself");
  {
    const throws = (secrets: string[]) => {
      try {
        new ChannelManager(secrets);
        return false;
      } catch {
        return true;
      }
    };
    // The pool is a speed-up; the claim of money already escrowed is not. Per-isolate leasing on
    // mainnet must therefore SHUT the pool, never fail the bootstrap every route is built on.
    const disabledNotFatal = async (secrets: string[]) => {
      try {
        const mgr = new ChannelManager(secrets);
        return mgr.enabled === false && (await mgr.lease({ attempts: 1 })) === null;
      } catch {
        return false;
      }
    };
    const savedNet = process.env.STELLAR_NETWORK;
    // kvConfigFromEnv() reads the UPSTASH_* names too — clearing only KV_* would let a shell
    // that exports Upstash silently exercise the has-a-store branch under a no-store label.
    const KV_VARS = [
      "KV_REST_API_URL",
      "KV_REST_API_TOKEN",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
    ] as const;
    const savedKv = KV_VARS.map((k) => [k, process.env[k]] as const);
    const clearKv = () => {
      for (const k of KV_VARS) delete process.env[k];
    };
    clearKv();

    process.env.STELLAR_NETWORK = "mainnet";
    ok(
      "mainnet + channels + no KV store ⇒ constructs with the pool DISABLED (onboarding falls back to the sponsor-sourced path)",
      await disabledNotFatal(makeSecrets(2)),
    );
    ok("mainnet + NO channels ⇒ still constructs (sponsor-sourced fallback survives)", !throws([]));
    ok(
      "mainnet + an injected store ⇒ constructs (the store is the thing that matters)",
      (() => {
        try {
          return new ChannelManager(makeSecrets(2), memoryLeaseStore()).enabled;
        } catch {
          return false;
        }
      })(),
    );
    process.env.KV_REST_API_URL = "https://fake-kv.test";
    process.env.KV_REST_API_TOKEN = "t";
    ok("mainnet + channels + a configured KV store ⇒ constructs", !throws(makeSecrets(2)));
    clearKv();

    process.env.STELLAR_NETWORK = "testnet";
    ok("testnet + channels + no KV store ⇒ still constructs (local dev keeps working)", !throws(makeSecrets(2)));

    if (savedNet === undefined) delete process.env.STELLAR_NETWORK;
    else process.env.STELLAR_NETWORK = savedNet;
    clearKv();
    for (const [k, v] of savedKv) if (v !== undefined) process.env[k] = v;
  }

  console.log("\n[7] a full pool costs a bounded number of store round trips (the Workers subrequest limit)");
  {
    // A live testnet run had /create-account fail with "Too many subrequests" once the pool filled:
    // a full pool cost attempts x pool size probes, each one a subrequest. Bounded now.
    const counting = (inner: ReturnType<typeof memoryLeaseStore>) => {
      const seen = { acquires: 0 };
      return {
        seen,
        store: {
          acquire: (k: string, t: number) => (seen.acquires++, inner.acquire(k, t)),
          release: (k: string, tok: string) => inner.release(k, tok),
        },
      };
    };
    const big = counting(memoryLeaseStore());
    const mgr = new ChannelManager(makeSecrets(40), big.store);
    for (let i = 0; i < 40; i++) await big.store.acquire(`chan:${mgr.publicKeys()[i]}`, 150); // every channel leased elsewhere
    big.seen.acquires = 0;
    const none = await mgr.lease({ delayMs: 1 });
    ok(`a full pool of 40 returns null after at most ${MAX_LEASE_PROBES} probes (it used to be 6 x 40 = 240)`, none === null && big.seen.acquires === MAX_LEASE_PROBES, `${big.seen.acquires} probes`);
    const small = counting(memoryLeaseStore());
    const mgr3 = new ChannelManager(makeSecrets(3), small.store);
    await small.store.acquire(`chan:${mgr3.publicKeys()[0]}`, 150);
    await small.store.acquire(`chan:${mgr3.publicKeys()[1]}`, 150);
    small.seen.acquires = 0;
    const last = await mgr3.lease({ delayMs: 1 });
    ok("a small pool's last free channel is still found within the bound", last !== null && last.publicKey === mgr3.publicKeys()[2] && small.seen.acquires <= 3, `${small.seen.acquires} probes`);
    await last?.release();
  }

  console.log("\n[8] the shared store leases the first free channel of a pass in ONE round trip");
  {
    const saved = { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN, fetch: globalThis.fetch };
    process.env.KV_REST_API_URL = "https://fake-kv.test";
    process.env.KV_REST_API_TOKEN = "t";
    const held = new Map<string, string>();
    let trips = 0;
    // Upstash as the lease store sees it: the one-round-trip lease script and the fenced release.
    globalThis.fetch = (async (_u: string | URL, init?: { body?: string }) => {
      trips++;
      const [cmd] = JSON.parse(String(init?.body)) as string[][];
      let result: unknown = null;
      if (cmd![0] === "EVAL" && cmd![1] === ACQUIRE_ANY_SCRIPT) {
        const n = Number(cmd![2]);
        const keys = cmd!.slice(3, 3 + n);
        const token = cmd![3 + n]!;
        result = 0;
        for (const [i, k] of keys.entries()) {
          if (!held.has(k)) {
            held.set(k, token);
            result = i + 1;
            break;
          }
        }
      } else if (cmd![0] === "EVAL") {
        const [k, tok] = [cmd![3]!, cmd![4]!];
        result = held.get(k) === tok ? (held.delete(k), 1) : 0;
      }
      return { ok: true, status: 200, json: async () => [{ result }] } as unknown as Response;
    }) as typeof fetch;
    const mgr = new ChannelManager(makeSecrets(40), defaultLeaseStore());
    for (const pk of mgr.publicKeys().slice(0, 39)) held.set(`chan:${pk}`, "elsewhere");
    trips = 0;
    const last = await mgr.lease({ delayMs: 1 });
    ok("a 40-channel pool with ONE free channel leases it in one round trip (it used to take up to 40)", last !== null && last.publicKey === mgr.publicKeys()[39] && trips === 1, `${trips} round trips`);
    trips = 0;
    const none = await mgr.lease({ delayMs: 1 });
    ok("a full pool answers null after one round trip per attempt (6), not one per channel (6 x 40 = 240)", none === null && trips === 6, `${trips} round trips`);
    await last!.release();
    ok("and the lease's release is the fenced compare-and-delete", !held.has(`chan:${mgr.publicKeys()[39]}`));
    globalThis.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = saved.url;
    if (saved.token === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = saved.token;
  }

  console.log("\n============================================================");
  console.log(
    failed === 0
      ? ` ✅ CHANNEL-LEASE TESTS PASS (${passed}/${passed + failed})`
      : ` ❌ CHANNEL-LEASE TESTS FAIL (${failed} failed)`,
  );
  console.log("============================================================");
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\n💥 channel-lease test crashed:", e);
  process.exit(1);
});
