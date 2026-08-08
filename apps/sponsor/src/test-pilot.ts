/**
 * PILOT GUARD TESTS — the mainnet-pilot allowlist + per-wallet tx budget (lib/pilot.ts).
 * Offline: a fake in-memory KV stands in for Upstash, so this runs with no network and no
 * secrets. Proves: only approved wallets are admitted, each gets exactly PILOT_MAX_TX slots,
 * a failed op releases its slot, revoke locks a wallet out, the store is fail-closed, and the
 * allowlist is namespaced per network.
 *
 * RUN: pnpm --filter @lumenia/sponsor test:pilot
 */
import { enforcePilot, approvePilot, revokePilot, pilotStatus, pilotEnabled, mintApprovalToken, verifyApprovalToken } from "./lib/pilot.js";
import { ipBucket } from "./lib/rate-limit.js";

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

/** In-memory stand-in for the Upstash REST pipeline lib/pilot.ts talks to (GET/SET/DEL/INCR/DECR). */
function installFakeKv() {
  const store = new Map<string, string>();
  process.env.KV_REST_API_URL = "https://fake-kv.test";
  process.env.KV_REST_API_TOKEN = "t";
  globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
    const cmds = JSON.parse(String(init?.body ?? "[]")) as string[][];
    const results = cmds.map(([op, key, arg]) => {
      switch (op) {
        case "GET":
          return { result: store.has(key!) ? store.get(key!) : null };
        case "SET":
          store.set(key!, String(arg));
          return { result: "OK" };
        case "DEL": {
          const had = store.delete(key!);
          return { result: had ? 1 : 0 };
        }
        case "INCR": {
          const n = Number(store.get(key!) ?? "0") + 1;
          store.set(key!, String(n));
          return { result: n };
        }
        case "DECR": {
          const n = Number(store.get(key!) ?? "0") - 1;
          store.set(key!, String(n));
          return { result: n };
        }
        default:
          throw new Error(`unexpected command ${op}`);
      }
    });
    return { ok: true, status: 200, json: async () => results } as unknown as Response;
  }) as typeof fetch;
  return store;
}
function clearKv() {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
}

const W = "GABFQIK63R2NETJM7T673EAMZN4RJLLGP3OFUEJU5SZVTGWUKULZJNL6";
const W2 = "GBHB3NAY2ADZ3XAGJNO6UN6GWT2D3PC4DXEQ2SVBGPIX6N6RS4PRBUK2";

async function main() {
  console.log("============================================================");
  console.log(" PILOT GUARD TESTS (offline)");
  console.log("============================================================\n");

  console.log("[1] the mode flag");
  delete process.env.PILOT_MODE;
  check("pilot is OFF by default (a no-op on the open product)", pilotEnabled() === false);
  process.env.PILOT_MODE = "1";
  check("PILOT_MODE=1 turns the gate on", pilotEnabled() === true);
  delete process.env.STELLAR_NETWORK; // → testnet namespace
  delete process.env.PILOT_MAX_TX; // → default 5

  console.log("[2] an un-approved wallet is refused");
  installFakeKv();
  const na = await enforcePilot(W);
  check("un-approved wallet rejected", !na.ok);
  check("the reason says it's not on the allowlist", /allowlist/.test(na.reason ?? ""), na.reason);

  console.log("[3] owner approval");
  await approvePilot(W);
  const st = await pilotStatus(W);
  check("after approve: approved, 0 used, limit 5", st.approved && st.used === 0 && st.limit === 5);

  console.log("[4] a hard budget of 5 value ops");
  let admitted = 0;
  for (let i = 0; i < 5; i++) if ((await enforcePilot(W)).ok) admitted++;
  check("the first 5 ops are admitted", admitted === 5, `${admitted}/5`);
  const sixth = await enforcePilot(W);
  check("the 6th is rejected", !sixth.ok);
  check("the reason names the limit", /5 transactions/.test(sixth.reason ?? ""), sixth.reason);
  check("a rejected op did NOT consume a slot (still 5 used)", (await pilotStatus(W)).used === 5);

  console.log("[5] a failed op releases its slot");
  installFakeKv();
  await approvePilot(W2);
  const r = await enforcePilot(W2);
  check("op admitted, exposes release()", r.ok && typeof r.release === "function");
  check("one slot used", (await pilotStatus(W2)).used === 1);
  await r.release!(); // pretend the transaction failed
  check("release() hands the slot back (0 used)", (await pilotStatus(W2)).used === 0);

  console.log("[6] revoke locks a wallet out again");
  await revokePilot(W2);
  check("a revoked wallet is rejected", !(await enforcePilot(W2)).ok);

  console.log("[7] fail-closed: no store, no admission");
  clearKv();
  check("with no KV configured, admission is refused", !(await enforcePilot(W)).ok);

  console.log("[8] the allowlist is namespaced per network");
  installFakeKv();
  await approvePilot(W); // approved on testnet (default)
  check("approved on testnet", (await pilotStatus(W)).approved);
  process.env.STELLAR_NETWORK = "mainnet";
  check("the SAME wallet is NOT approved on mainnet", !(await pilotStatus(W)).approved);
  check("and is rejected there", !(await enforcePilot(W)).ok);
  delete process.env.STELLAR_NETWORK;
  delete process.env.PILOT_MODE;
  clearKv();

  console.log("[approval links] a signed, per-wallet, expiring token — not the shared secret");
  process.env.PILOT_APPROVE_TOKEN = "test-owner-secret";
  const NOW = Date.parse("2026-08-08T12:00:00Z");
  const OTHER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
  const minted = (await mintApprovalToken("approve", W, NOW))!;
  check("a token is minted when a secret is configured", Boolean(minted?.token));
  check(
    "the minted token verifies for its own wallet + action",
    await verifyApprovalToken("approve", W, minted.token, String(minted.exp), NOW),
  );
  check(
    "it does NOT approve a DIFFERENT wallet (a leaked link is not a master key)",
    !(await verifyApprovalToken("approve", OTHER, minted.token, String(minted.exp), NOW)),
  );
  check(
    "it does NOT work for the other action (approve link cannot decline)",
    !(await verifyApprovalToken("reject", W, minted.token, String(minted.exp), NOW)),
  );
  check(
    "it expires",
    !(await verifyApprovalToken("approve", W, minted.token, String(minted.exp), NOW + 8 * 24 * 3600 * 1000)),
  );
  check(
    "an attacker cannot extend it by editing the exp in the URL",
    !(await verifyApprovalToken("approve", W, minted.token, String(minted.exp + 3600), NOW)),
  );
  check("a garbage token is refused", !(await verifyApprovalToken("approve", W, "nope", String(minted.exp), NOW)));
  check(
    "the raw shared secret is NOT itself a valid token (the old scheme is gone)",
    !(await verifyApprovalToken("approve", W, "test-owner-secret", String(minted.exp), NOW)),
  );
  delete process.env.PILOT_APPROVE_TOKEN;
  check("no secret configured → no token minted", (await mintApprovalToken("approve", W, NOW)) === null);

  console.log("[rate-limit keying] IPv6 collapses to its /64, so a caller cannot mint fresh IPs");
  check(
    "two addresses in one /64 share a bucket",
    ipBucket("2a02:0db8:1234:5678:0000:0000:0000:0001") === ipBucket("2a02:0db8:1234:5678:ffff:ffff:ffff:ffff"),
  );
  check(
    "a different /64 is a different bucket",
    ipBucket("2a02:0db8:1234:5678::1") !== ipBucket("2a02:0db8:1234:9999::1"),
  );
  check("the elided :: form collapses the same as the expanded one",
    ipBucket("2a02:db8:1234:5678::1") === ipBucket("2a02:db8:1234:5678:0:0:0:2"));
  check("IPv4 is untouched", ipBucket("203.0.113.9") === "203.0.113.9");

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ PILOT GUARD TESTS PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
