/**
 * PILOT GUARD TESTS — the mainnet-pilot allowlist + per-wallet tx budget (lib/pilot.ts).
 * Offline: a fake in-memory KV stands in for Upstash, so this runs with no network and no
 * secrets. Proves: only approved wallets are admitted, each gets exactly PILOT_MAX_TX slots,
 * a failed op releases its slot, revoke locks a wallet out, the store is fail-closed, and the
 * allowlist is namespaced per network. Also pins the shape of the one email↔wallet join this
 * service keeps: where it lives, that it expires, and that revoking erases it.
 *
 * RUN: pnpm --filter @lumenia/sponsor test:pilot
 */
import {
  enforcePilot,
  approvePilot,
  resetPilotBudget,
  revokePilot,
  pilotStatus,
  pilotEnabled,
  mintApprovalToken,
  verifyApprovalToken,
  startPilotRequest,
  getPilotEmail,
  PILOT_EMAIL_RETENTION_SECONDS,
  listPilot,
} from "./lib/pilot.js";
import { notifyPilotApproved, notifyPilotRejected } from "./lib/pilot-request.js";
import { ipBucket } from "./lib/rate-limit.js";
import { SubmitUnconfirmedError } from "./lib/stellar.js";
import { resetHaltCache } from "./lib/kill-switch.js";
import { Keypair } from "@stellar/stellar-sdk";
import worker, { resetHealthCache, withPilotSlot } from "./worker.js";

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✔" : "✗"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

/**
 * In-memory stand-in for the Upstash REST pipeline lib/pilot.ts talks to (GET/SET/DEL/INCR/DECR).
 * `ttls` records the `EX` seconds of a SET so a test can prove a key was written with an expiry —
 * an unbounded write and a bounded one are otherwise indistinguishable from the outside.
 */
function installFakeKv(opts: { failGets?: () => boolean } = {}) {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  process.env.KV_REST_API_URL = "https://fake-kv.test";
  process.env.KV_REST_API_TOKEN = "t";
  globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
    // A store that stops answering reads (the approve-link test's outage), on request.
    if (opts.failGets?.()) return { ok: false, status: 500, json: async () => [] } as unknown as Response;
    // The plain `/get/<key>` read that /health's counters and the watchdog stamp use.
    const got = String(_url).match(/\/get\/([^?]+)$/);
    if (got) {
      const key = decodeURIComponent(got[1]!);
      return { ok: true, status: 200, json: async () => ({ result: store.has(key) ? store.get(key) : null }) } as unknown as Response;
    }
    const cmds = JSON.parse(String(init?.body ?? "[]")) as string[][];
    const results = cmds.map((cmd) => {
      const [op, key, arg] = cmd;
      switch (op) {
        case "GET":
          return { result: store.has(key!) ? store.get(key!) : null };
        case "SET": {
          if (cmd.includes("NX") && store.has(key!)) return { result: null };
          store.set(key!, String(arg));
          const ex = cmd.indexOf("EX");
          ttls.delete(key!);
          if (ex > 0 && cmd[ex + 1] !== undefined) ttls.set(key!, Number(cmd[ex + 1]));
          return { result: "OK" };
        }
        case "DEL": {
          const had = store.delete(key!);
          ttls.delete(key!);
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
        case "SCAN": {
          // SCAN <cursor> MATCH <glob> COUNT <n>: one page holds everything, the cursor comes back "0".
          const at = cmd.indexOf("MATCH");
          const glob = at > 0 ? String(cmd[at + 1]) : "*";
          const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
          return { result: ["0", [...store.keys()].filter((k) => re.test(k))] };
        }
        default:
          throw new Error(`unexpected command ${op}`);
      }
    });
    return { ok: true, status: 200, json: async () => results } as unknown as Response;
  }) as typeof fetch;
  return { store, ttls };
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
  check("and its status follows the allowlist: declined, never 'approved' with no flag behind it", (await pilotStatus(W2)).state === "rejected");

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

  console.log("[9] the one email↔wallet join is bounded, and it is the only one");
  {
    const { store, ttls } = installFakeKv();
    const APPLICANT = "someone@example.test";
    await startPilotRequest(W, APPLICANT);
    check("the outcome mail still has an address to go to", (await getPilotEmail(W)) === APPLICANT);
    check(
      "it is written with a retention TTL, not forever",
      ttls.get(`pilot:testnet:email:${W}`) === PILOT_EMAIL_RETENTION_SECONDS,
      String(ttls.get(`pilot:testnet:email:${W}`)),
    );
    check(
      "no KEY NAME carries the address (the 'already applied' marker is hashed)",
      [...store.keys()].every((k) => !k.includes(APPLICANT) && !k.includes("@")),
    );
    check(
      "exactly ONE stored value is the address",
      [...store.values()].filter((v) => v === APPLICANT).length === 1,
    );
    await approvePilot(W);
    check("approval does not disturb it", (await getPilotEmail(W)) === APPLICANT);
    await revokePilot(W);
    check("revoking erases it", (await getPilotEmail(W)) === null);
    clearKv();
  }

  console.log("[10] the owner can list who is waiting without an inbox");
  {
    const kv = installFakeKv();
    process.env.STELLAR_NETWORK = "mainnet";
    await startPilotRequest(W, "one@example.com");
    await startPilotRequest(W2, "two@example.com");
    await approvePilot(W2);
    kv.store.set("pilot:testnet:status:GTESTNETONLY", "pending"); // the other network's queue
    const pending = await listPilot("pending");
    check("a pending wallet is listed with its contact flag", pending.length === 1 && pending[0]!.pubkey === W && pending[0]!.hasEmail);
    const approved = await listPilot("approved");
    check("an approved wallet is listed under approved", approved.length === 1 && approved[0]!.pubkey === W2);
    const all = await listPilot();
    check("the default lists every state on THIS network only", all.length === 2 && all.every((r) => r.pubkey !== "GTESTNETONLY"));
    kv.store.delete(`pilot:mainnet:email:${W}`);
    check("a contact that expired shows as unreachable", (await listPilot("pending"))[0]!.hasEmail === false);
    installFakeKv();
    check("an empty store lists nothing", (await listPilot()).length === 0);
    delete process.env.STELLAR_NETWORK;
    clearKv();
  }

  console.log("[11] the welcome mail says whether Resend took it, and quotes the cap it is given");
  {
    const sent: string[] = [];
    let status = 200;
    globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
      sent.push(String(init?.body ?? ""));
      return { ok: status >= 200 && status < 300, status } as Response;
    }) as typeof fetch;
    delete process.env.RESEND_API_KEY;
    check("no RESEND_API_KEY -> reported as not sent, nothing posted", (await notifyPilotApproved(W, "one@example.com")) === false && sent.length === 0);
    process.env.RESEND_API_KEY = "re_test";
    process.env.MAX_DROP_USDC = "5";
    check("Resend accepts -> reported as sent", (await notifyPilotApproved(W, "one@example.com")) === true);
    check("the mail quotes the cap from MAX_DROP_USDC, not the code default", sent.length === 1 && sent[0]!.includes("capped at $5") && !sent[0]!.includes("$100"));
    status = 403; // e.g. an unverified RESEND_FROM sending to a real inbox
    check("Resend refuses -> reported as NOT sent (the CLI must not print \"emailed\")", (await notifyPilotApproved(W, "one@example.com")) === false);
    check("the decline mail follows the same contract", (await notifyPilotRejected(W, "one@example.com")) === false);
    delete process.env.RESEND_API_KEY;
    delete process.env.MAX_DROP_USDC;
  }

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

  /* ------------------------------------------------------------------------------------------
   * SOW 2, D3 (item c residuals, item i): the slot guard around a value handler, the approve link
   * tapped twice, the open answer when the pilot is retired, and the /health page.
   * ------------------------------------------------------------------------------------------ */
  console.log("[12] the pilot slot goes back only for a transaction that definitely did not happen");
  {
    const { store } = installFakeKv();
    process.env.PILOT_MODE = "1";
    process.env.STELLAR_NETWORK = "testnet";
    const used = () => Number(store.get(`pilot:testnet:tx:${W}`) ?? "0");
    await approvePilot(W);
    const plain = await withPilotSlot(W, async () => {
      throw new Error("anti-drain rejected the inner tx");
    }).then(() => "returned", (e: Error) => e.message);
    check("a handler that throws a plain error gives the slot back (the transaction never happened)", plain !== "returned" && used() === 0, `used ${used()}`);
    const undecided = await withPilotSlot(W, async () => {
      throw new SubmitUnconfirmedError("Horizon answered 504", "ab".repeat(32));
    }).then(() => "returned", (e: Error) => e.message);
    check("a handler that throws an UNCONFIRMED submit keeps the slot (the transaction may still land)", /submit unconfirmed/.test(undecided) && used() === 1, `used ${used()}`);
    const accepted = await withPilotSlot(W, async () => ({ hash: "cd".repeat(32), confirmed: false }));
    check("a handler that RETURNS {confirmed:false} keeps the slot too (nothing threw, nothing is released)", !!accepted && "confirmed" in accepted && used() === 2, `used ${used()}`);
    const landed = await withPilotSlot(W, async () => ({ hash: "ef".repeat(32), confirmed: true }));
    check("a confirmed transaction keeps its slot, as before", !!landed && used() === 3, `used ${used()}`);
    const notApproved = await withPilotSlot(W2, async () => "ran");
    check("an un-approved wallet is refused before the handler runs", typeof notApproved === "object" && "error" in notApproved);
    delete process.env.PILOT_MODE;
    const off = await withPilotSlot(W2, async () => "ran");
    check("with PILOT_MODE unset the guard is a no-op: the handler simply runs (the retirement switch, item i)", off === "ran");
    clearKv();
  }

  console.log("[13] the emailed Approve link, tapped twice, does not refill a wallet's budget");
  {
    const kvState = { failing: false };
    const { store } = installFakeKv({ failGets: () => kvState.failing });
    process.env.PILOT_MODE = "1";
    process.env.STELLAR_NETWORK = "testnet";
    process.env.PILOT_APPROVE_TOKEN = "an-approve-secret";
    process.env.SPONSOR_SECRET = Keypair.random().secret();
    process.env.USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    delete process.env.RESEND_API_KEY;
    const used = () => Number(store.get(`pilot:testnet:tx:${W}`) ?? "0");
    const minted = await mintApprovalToken("approve", W, Date.now());
    const tap = () =>
      worker.fetch(new Request(`https://sponsor.test/pilot-approve?pubkey=${W}&token=${minted!.token}&exp=${minted!.exp}`), {});
    const first = await tap();
    check("the first tap approves (200)", first.status === 200 && store.get(`pilot:testnet:appr:${W}`) === "1", String(first.status));
    for (let i = 0; i < 3; i++) await enforcePilot(W);
    check("the wallet then spends three of its slots", used() === 3, `used ${used()}`);
    const second = await tap();
    const body = await second.text();
    check("the second tap answers 'Already approved'", second.status === 200 && /Already approved/.test(body), body.slice(0, 80));
    check("and the three spent slots are still spent (approvePilot was not re-run)", used() === 3, `used ${used()}`);
    check("the wallet stays approved", store.get(`pilot:testnet:appr:${W}`) === "1");
    // A REVOKED wallet's still-valid link re-admits it: the check reads the allowlist flag, not
    // the status (a revoke used to leave status 'approved' and the link answered "Already approved").
    await revokePilot(W);
    const third = await tap();
    check("after a revoke, the same link re-admits the wallet", third.status === 200 && store.get(`pilot:testnet:appr:${W}`) === "1", String(third.status));
    check("and re-approval does NOT refill the slots it had spent (the counter is written with SET NX)", used() === 3, `used ${used()}`);
    const was = await resetPilotBudget(W);
    check("the owner's explicit reset is the one way to refill them, and says what was spent", was === 3 && used() === 0, `was ${was}, now ${used()}`);
    for (let i = 0; i < 3; i++) await enforcePilot(W);
    // A store that cannot answer the allowlist read: nothing is approved, and the page says so.
    await revokePilot(W);
    kvState.failing = true;
    const outage = await tap();
    kvState.failing = false;
    check("a failed allowlist read answers 503 and approves nothing", outage.status === 503 && store.get(`pilot:testnet:appr:${W}`) !== "1", String(outage.status));
    check("and the spent slots are untouched", used() === 3, `used ${used()}`);
    await approvePilot(W);
    const status = await worker.fetch(new Request(`https://sponsor.test/pilot-status?pubkey=${W}`), {});
    const st = (await status.json()) as { pilot: boolean; approved: boolean; state?: string };
    check("/pilot-status in pilot mode answers pilot:true for the approved wallet", st.pilot === true && st.approved === true, JSON.stringify(st));
    delete process.env.PILOT_MODE;
    const open = (await (await worker.fetch(new Request(`https://sponsor.test/pilot-status?pubkey=${W2}`), {})).json()) as { pilot: boolean; approved: boolean; state?: string };
    check("with PILOT_MODE unset /pilot-status answers {pilot:false, approved:true, state:'open'} for ANY wallet", open.pilot === false && open.approved === true && open.state === "open", JSON.stringify(open));
    const noKey = await worker.fetch(new Request("https://sponsor.test/pilot-status"), {});
    const noKeyBody = (await noKey.json()) as { pilot?: boolean; state?: string };
    check("and to a request with NO pubkey at all (a device with no account yet)", noKey.status === 200 && noKeyBody.pilot === false && noKeyBody.state === "open", JSON.stringify(noKeyBody));
    const burst: number[] = [];
    for (let i = 0; i < 40; i++) burst.push((await worker.fetch(new Request("https://sponsor.test/pilot-status"), {})).status);
    check("answered BEFORE the rate limiter: 40 asks in a row from one address are all 200 (the IP cap is 30)", burst.every((s) => s === 200), burst.filter((s) => s !== 200).join(","));
    process.env.PILOT_MODE = "1";
    const pilotNoKey = await worker.fetch(new Request("https://sponsor.test/pilot-status"), {});
    check("in pilot mode a missing pubkey is still a 400", pilotNoKey.status === 400);
    delete process.env.PILOT_MODE;
    delete process.env.PILOT_APPROVE_TOKEN;
    clearKv();
  }

  console.log("[14] /health names the signer, the account, the halt, the heartbeat and the day's budgets");
  {
    const { store } = installFakeKv();
    process.env.STELLAR_NETWORK = "testnet";
    process.env.PILOT_MODE = "1";
    store.set("watchdog:testnet:lastrun", new Date(Date.now() - 120_000).toISOString());
    store.set("sponsor:halt:testnet", "1");
    store.set("sponsor:halt:testnet:reason", "2026-10-07T18:00:00.000Z watchdog auto-halt: test");
    resetHaltCache(); // the kill switch caches its verdict for 5 s per isolate; [13] read it a moment ago
    resetHealthCache(); // and /health caches its store readings for 5 s the same way
    const res = await worker.fetch(new Request("https://sponsor.test/health"), {});
    const h = (await res.json()) as Record<string, any>;
    check("200 with ok:true", res.status === 200 && h.ok === true);
    check("signer.kind is 'env' here, and the public key is the account (no SPONSOR_ACCOUNT_ID set)", h.signer?.kind === "env" && h.signer?.publicKey === h.account && h.sponsorPublicKey === h.account, JSON.stringify(h.signer));
    check("pilotMode reflects PILOT_MODE", h.pilotMode === true);
    check("halt reports the store flag and its stored reason", h.halt?.halted === true && h.halt?.source === "store" && /auto-halt/.test(h.halt?.reason ?? ""), JSON.stringify(h.halt));
    check("watchdog.lastRun is the stamp and ageSeconds is about two minutes", typeof h.watchdog?.lastRun === "string" && h.watchdog?.ageSeconds >= 119 && h.watchdog?.ageSeconds <= 125, JSON.stringify(h.watchdog));
    check("alerting says what is missing", h.alerting?.configured === false && Array.isArray(h.alerting?.missing));
    check("fees carries the day, the spend, the budget and the fraction", typeof h.fees?.day === "string" && typeof h.fees?.maxXlm === "string" && "spentXlm" in h.fees && "used" in h.fees, JSON.stringify(h.fees));
    check("and the gross (every bid accepted today, never lowered by a give-back)", "grossXlm" in h.fees, JSON.stringify(h.fees));
    check("counters carries the day's escrow and account totals and their ceilings", typeof h.counters?.maxDayUsdc === "string" && typeof h.counters?.maxDayAccounts === "number" && "escrowUsdc" in h.counters && "accounts" in h.counters, JSON.stringify(h.counters));
    const text = JSON.stringify(h);
    check("no secret-shaped value anywhere in the page", !/S[A-Z2-7]{55}/.test(text) && !/Bearer|token|KEY_ID|arn:/i.test(text));
    // The readings are cached per isolate: a store change shows after the window, not per request,
    // so a GET loop on /health cannot turn into one store read per request.
    store.set("watchdog:testnet:lastrun", "2026-10-08T00:00:00.000Z");
    const cached = (await (await worker.fetch(new Request("https://sponsor.test/health"), {})).json()) as Record<string, any>;
    check("a second read inside 5 s serves the cached readings (the store change is not visible yet)", cached.watchdog?.lastRun === h.watchdog?.lastRun, String(cached.watchdog?.lastRun));
    resetHealthCache();
    const fresh = (await (await worker.fetch(new Request("https://sponsor.test/health"), {})).json()) as Record<string, any>;
    check("and a read after the window sees it", fresh.watchdog?.lastRun === "2026-10-08T00:00:00.000Z", String(fresh.watchdog?.lastRun));
    delete process.env.PILOT_MODE;
    clearKv();
  }

  console.log("\n============================================================");
  console.log(fail === 0 ? ` ✅ PILOT GUARD TESTS PASS (${pass}/${pass})` : ` ❌ ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
