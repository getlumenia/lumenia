/**
 * WATCHDOG TESTS, OFFLINE: every tripwire in lib/watchdog.ts driven against a fake Horizon, a fake
 * Soroban RPC, a fake Upstash store and a fake Resend, so the heartbeat, the auto-halt scope and
 * the namespaced kill switch are proven in CI with no network and no keys (SOW 2, D3 item f).
 *
 * The live smoke test (test-watchdog.ts, `test:watchdog`) still exists, is read-only, and still
 * needs testnet; this suite is the one the CI gate runs. What it pins:
 *   - the heartbeat stamp `watchdog:<net>:lastrun` is written at the end of EVERY scheduled run,
 *     including a run where every check threw, and `watchdog:<net>:lastfull` only when every check
 *     completed;
 *   - the sponsor halts ITSELF on exactly two conditions, a sponsor-sourced forbidden operation from
 *     the last day and a changed escrow wasm hash that a second read confirms, through
 *     `sponsor:halt:<net>` of the CONFIG's network (never the bare key, never the shell's network,
 *     never on float, capacity, state expiry, a governance event, an older operation, an
 *     unconfirmed read or a failed check), because a halt also blocks the exit routes;
 *   - halting and every store write are opt-in: a run without `autoHalt` and `heartbeat` (the
 *     smoke test, an operator's script) halts nothing, writes nothing and mails nothing;
 *   - a NEW halt (an operator deleted the key and the next run halted again) is mailed whatever the
 *     cooldown says, and a wasm halt's page says to pin the new hash BEFORE resuming;
 *   - the forbidden-operation scan reads the newest operations on a cold start, pages through a
 *     backlog, says when it is behind, and keeps its cursor short of a tripwire whose halt failed;
 *   - the governance scan does not skip the events past a full getEvents page;
 *   - the alert cooldown is per network and starts only once Resend has accepted the email;
 *   - the kill switch honours the env flag, the namespaced key and the legacy key, clears cleanly,
 *     and fails OPEN on a store error (decided and disclosed, not an accident);
 *   - the Worker's scheduled handler scans the sponsor ACCOUNT, not the signer, and stamps the heartbeat.
 *
 * The `[watchdog:page]` lines in the output are the watchdog's own console log of what it found.
 *
 * RUN: pnpm --filter @lumenia/sponsor test:watchdog-offline
 */
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { makeConfig, USDC_ISSUERS } from "./lib/config.js";
import {
  AUTO_HALT_FAILED_TITLE,
  BLIND_GRACE_MS,
  AUTO_HALT_SKIPPED_TITLE,
  AUTO_HALT_TITLE,
  EVENTS_PAGE_SIZE,
  FORBIDDEN_OP_OLD_TITLE,
  OPS_MAX_PAGES,
  OPS_PAGE_SIZE,
  OPS_SCAN_BEHIND_TITLE,
  TRIPWIRE_FORBIDDEN_OP,
  TRIPWIRE_WASM_CHANGED,
  WASM_CONFIRM_DELAY_MS,
  WASM_UNCONFIRMED_TITLE,
  alertingStatus,
  isAutoHaltTripwire,
  lastFullRunKey,
  lastRunKey,
  markAlerted,
  runWatchdog,
  watchdogAge,
  watchdogLastRun,
  watchdogStamps,
  withoutRepeats,
  type Alert,
  type WatchdogOptions,
} from "./lib/watchdog.js";
import {
  HALT_KEY,
  clearHalt,
  haltKey,
  haltReasonKey,
  haltStatus,
  isHalted,
  resetHaltCache,
  setHalt,
  storeHaltIsSet,
} from "./lib/kill-switch.js";
import { feeDayKey } from "./lib/caps.js";
import worker from "./worker.js";

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

const CONTRACT = "CAMCI5VPRLQUL6H4QKLZ6X7ASLVCEYBYWS7N3QG7JVOA25HCY2TN3HP3";
const WASM = "4b5780ebf4848913c4f1557df1468391e3c26f4106ef0ff23ec1e3caf79cb68b";
const OTHER_WASM = "ab".repeat(32);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const sponsor = Keypair.random();
const stranger = Keypair.random();

const config = makeConfig({
  network: "testnet",
  sponsorSecret: sponsor.secret(),
  usdcIssuer: USDC_ISSUERS.testnet,
  lumendropContract: CONTRACT,
  horizonUrl: "https://horizon.fake",
  sorobanRpcUrl: "https://rpc.fake",
});
const mainnetConfig = makeConfig({
  network: "mainnet",
  sponsorSecret: sponsor.secret(),
  usdcIssuer: USDC_ISSUERS.mainnet,
  lumendropContract: CONTRACT,
  horizonUrl: "https://horizon.fake",
  sorobanRpcUrl: "https://rpc.fake",
});
const SPONSOR = sponsor.publicKey();
const OPS_CURSOR = `watchdog:ops:${SPONSOR}`;

/** What the Worker's scheduled handler passes, with the wasm confirmation pause shortened (its default is pinned in [25]). */
const WORKER: WatchdogOptions = { autoHalt: true, heartbeat: true, confirmDelayMs: 5 };

/* ------------------------------- the fake world ------------------------------- */

interface Op {
  type: string;
  source_account: string;
  transaction_hash: string;
  paging_token: string;
  created_at: string;
}

interface World {
  xlm: string;
  sponsoring: number;
  /** Horizon answers the account without a native balance. */
  accountUnreadable: boolean;
  ops: Op[];
  events: Array<{ topic: string[]; ledger: number; txHash: string }>;
  runningWasm: string;
  /** Per-read answers for the escrow instance, used up in order; null = no instance entry on that read. */
  wasmReads: Array<string | null>;
  /** The escrow instance does not exist (archived, or a wrong id). */
  instanceMissing: boolean;
  latest: number;
  instanceUntil: number;
  codeUntil: number;
  /**
   * Fail these upstreams: "horizon" a 502, "rpc" Cloudflare's throttle (429, "error code: 1015"), "kv" a
   * 500 for every store request. Answers about the request, never busy: "horizon-404" (no such account),
   * "rpc-answer" (a JSON-RPC error object), "rpc-refused" (a 403 firewall block). "kv-set": the store
   * reads, and refuses every plain /set/.
   */
  down: Set<"horizon" | "horizon-404" | "rpc" | "rpc-answer" | "rpc-refused" | "kv" | "kv-set">;
  /** The Retry-After header the RPC throttle sends, or null for none. */
  retryAfter: string | null;
  /** The fee counter the caps module keeps, in stroops. */
  feeSpent: bigint | null;
  /** Every SET inside a store pipeline fails (a store refusing the halt write); plain /set/ still works. */
  pipelineSetFails: boolean;
  /** Plain GETs of matching keys answer 500 (a store that fails one read while the rest works). */
  getFails: RegExp | null;
  /** Pipelines that start with a GET answer this many ms late (a read still in flight). */
  readDelayMs: number;
  /** Pipelines that start with a GET never answer until the caller aborts them (a hung read). */
  readHangs: boolean;
  /** The status Resend answers with. */
  resendStatus: number;
}

const world: World = {
  xlm: "100.0000000",
  sponsoring: 10,
  accountUnreadable: false,
  ops: [],
  events: [],
  runningWasm: WASM,
  wasmReads: [],
  instanceMissing: false,
  latest: 1_000_000,
  instanceUntil: 1_000_000 + 1_000_000,
  codeUntil: 1_000_000 + 1_000_000,
  down: new Set(),
  retryAfter: null,
  feeSpent: 0n,
  pipelineSetFails: false,
  getFails: null,
  readDelayMs: 0,
  readHangs: false,
  resendStatus: 200,
};

const kv = new Map<string, string>();
/** How many pipelines reached the store (the halt read's one-read-per-burst rule counts them). */
let storePipelines = 0;
const resend: Array<{ subject: string; text: string }> = [];
/** Every Horizon URL requested, and the operations URLs on their own. */
const horizonRequests: string[] = [];
const opsRequests: string[] = [];
/** When each read of the escrow instance happened (ms). */
const instanceReads: number[] = [];
/** Every request the run made, in order, as a short label (the early-halt section reads the order). */
const trace: string[] = [];
/** Each reason a halt write carried, in order. */
const haltReasons: string[] = [];
/** Whether the halt key was already set when the run's first Soroban RPC request left. */
let haltedAtFirstRpc: boolean | null = null;
/** Every Soroban RPC request, answered or not. */
let rpcRequests = 0;

function instanceEntryXdr(hashHex: string): string {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: Address.fromString(CONTRACT).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hashHex, "hex")),
          storage: null,
        }),
      ),
    }),
  ).toXDR("base64");
}

const topic = (name: string) => nativeToScVal(name, { type: "symbol" }).toXDR("base64");

/** One Horizon operation record; `ageMs` sets its created_at relative to the real clock. */
function op(type: string, source: string, token: number, ageMs = 60_000): Op {
  return {
    type,
    source_account: source,
    transaction_hash: token.toString(16).padStart(64, "0"),
    paging_token: String(token),
    created_at: new Date(Date.now() - ageMs).toISOString(),
  };
}

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
function text(body: string, status = 500, headers: Record<string, string> = {}): Response {
  return {
    ok: status < 400,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

/** Routes every fetch the watchdog, the caps reader and the kill switch make. */
async function fakeFetch(url: string | URL, init?: { method?: string; body?: string }): Promise<Response> {
  const u = String(url);

  if (u.startsWith("https://horizon.fake/")) {
    horizonRequests.push(u);
    trace.push(/\/operations\?/.test(u) ? "horizon:ops" : "horizon:account");
    if (world.down.has("horizon")) return text("error code: 502", 502);
    if (world.down.has("horizon-404")) return json({ title: "Resource Missing", status: 404 }, 404);
    if (/\/operations\?/.test(u)) {
      opsRequests.push(u);
      // Horizon's paging: asc returns the records AFTER the cursor, desc the records BEFORE it
      // (newest first without one), at most `limit` of them.
      const q = new URL(u).searchParams;
      const limit = Number(q.get("limit") ?? "10");
      const cursor = q.get("cursor");
      const sorted = [...world.ops].sort((a, b) => Number(a.paging_token) - Number(b.paging_token));
      const records =
        q.get("order") === "desc"
          ? sorted.filter((o) => !cursor || Number(o.paging_token) < Number(cursor)).reverse().slice(0, limit)
          : sorted.filter((o) => !cursor || Number(o.paging_token) > Number(cursor)).slice(0, limit);
      return json({ _embedded: { records } });
    }
    return json({
      balances: world.accountUnreadable ? [] : [{ asset_type: "native", balance: world.xlm }],
      subentry_count: 0,
      num_sponsoring: world.sponsoring,
    });
  }

  if (u.startsWith("https://rpc.fake")) {
    rpcRequests++;
    if (haltedAtFirstRpc === null) haltedAtFirstRpc = kv.get(haltKey("testnet")) === "1";
    // How the public RPC's Cloudflare front answered on 2026-10-10.
    if (world.down.has("rpc")) return text("error code: 1015", 429, world.retryAfter === null ? {} : { "retry-after": world.retryAfter });
    if (world.down.has("rpc-refused")) return text("error code: 1020", 403);
    // A considered JSON-RPC answer (not a busy source): the RPC refused the request itself.
    if (world.down.has("rpc-answer")) return json({ jsonrpc: "2.0", id: 1, error: { message: "startLedger must be within the ledger range" } });
    const req = JSON.parse(String(init?.body ?? "{}")) as {
      method: string;
      params?: { keys?: string[]; startLedger?: number; pagination?: { limit?: number } };
    };
    const firstKey = req.params?.keys?.[0];
    trace.push(
      req.method === "getLedgerEntries" && firstKey
        ? `rpc:getLedgerEntries:${xdr.LedgerKey.fromXDR(firstKey, "base64").switch().name === "contractData" ? "instance" : "code"}`
        : `rpc:${req.method}`,
    );
    if (req.method === "getLatestLedger") return json({ jsonrpc: "2.0", id: 1, result: { sequence: world.latest } });
    if (req.method === "getEvents") {
      // Ascending, from startLedger, at most `limit`: the shape the governance scan relies on.
      const start = req.params?.startLedger ?? 0;
      const limit = req.params?.pagination?.limit ?? 100;
      const events = world.events.filter((e) => e.ledger >= start).slice(0, limit);
      return json({ jsonrpc: "2.0", id: 1, result: { events, latestLedger: world.latest } });
    }
    if (req.method === "getLedgerEntries") {
      const entries = (req.params?.keys ?? []).flatMap((k) => {
        const key = xdr.LedgerKey.fromXDR(k, "base64");
        if (key.switch().name === "contractData") {
          instanceReads.push(Date.now());
          const hex = world.wasmReads.length > 0 ? world.wasmReads.shift()! : world.instanceMissing ? null : world.runningWasm;
          return hex === null ? [] : [{ xdr: instanceEntryXdr(hex), liveUntilLedgerSeq: world.instanceUntil }];
        }
        return [{ xdr: "AAAA", liveUntilLedgerSeq: world.codeUntil }];
      });
      return json({ jsonrpc: "2.0", id: 1, result: { latestLedger: world.latest, entries } });
    }
    return json({ jsonrpc: "2.0", id: 1, error: { message: `unknown method ${req.method}` } });
  }

  if (u.startsWith("https://fake-kv.test/")) {
    if (world.down.has("kv")) return text("store down", 500);
    const path = u.slice("https://fake-kv.test".length);
    if (path === "/pipeline") {
      const cmds = JSON.parse(String(init?.body ?? "[]")) as string[][];
      storePipelines++;
      trace.push(`kv:pipeline ${cmds.map(([op, key]) => `${op} ${key}`).join(", ")}`);
      for (const [op, key, value] of cmds) if (op === "SET" && key === haltReasonKey("testnet")) haltReasons.push(String(value));
      if (cmds[0]?.[0] === "GET" && world.readHangs) {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      if (cmds[0]?.[0] === "GET" && world.readDelayMs > 0) await new Promise((r) => setTimeout(r, world.readDelayMs));
      return json(
        cmds.map(([op, key, value]) => {
          if (op === "GET") return { result: kv.has(key!) ? kv.get(key!) : null };
          if (op === "SET") {
            if (world.pipelineSetFails) return { error: "READONLY You can't write against a read only replica." };
            kv.set(key!, String(value));
            return { result: "OK" };
          }
          if (op === "DEL") return { result: kv.delete(key!) ? 1 : 0 };
          if (op === "INCRBY") {
            const next = BigInt(kv.get(key!) ?? "0") + BigInt(value!);
            kv.set(key!, next.toString());
            return { result: next.toString() };
          }
          if (op === "EXPIRE") return { result: 1 };
          throw new Error(`fake kv: unexpected command ${op}`);
        }),
      );
    }
    const get = path.match(/^\/get\/(.+)$/);
    if (get) {
      const key = decodeURIComponent(get[1]!);
      trace.push(`kv:get ${key}`);
      if (world.getFails?.test(key)) return text("store blip", 500);
      if (key === feeDayKey(Date.now())) {
        // `null` in the world means "the store cannot answer for this key", not "zero".
        if (world.feeSpent === null) return text("store down", 500);
        return json({ result: world.feeSpent.toString() });
      }
      return json({ result: kv.has(key) ? kv.get(key) : null });
    }
    const set = path.match(/^\/set\/([^/]+)\/(.*)$/);
    if (set) {
      trace.push(`kv:set ${decodeURIComponent(set[1]!)}`);
      if (world.down.has("kv-set")) return json({ error: "OOM command not allowed when used memory > 'maxmemory'." }, 400);
      kv.set(decodeURIComponent(set[1]!), decodeURIComponent(set[2]!));
      return json({ result: "OK" });
    }
    throw new Error(`fake kv: unexpected path ${path}`);
  }

  if (u === "https://api.resend.com/emails") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { subject: string; text: string };
    resend.push(body);
    return world.resendStatus < 400 ? json({ id: "mail" }, world.resendStatus) : text("resend refused", world.resendStatus);
  }

  throw new Error(`unexpected fetch ${u}`);
}

globalThis.fetch = fakeFetch as typeof fetch;

/** A quiet world: nothing to page about. */
function quiet(): void {
  world.xlm = "100.0000000";
  world.sponsoring = 10;
  world.accountUnreadable = false;
  world.ops = [];
  world.events = [];
  world.runningWasm = WASM;
  world.wasmReads = [];
  world.instanceMissing = false;
  world.latest = 1_000_000;
  world.instanceUntil = world.latest + 1_000_000;
  world.codeUntil = world.latest + 1_000_000;
  world.down.clear();
  world.retryAfter = null;
  world.feeSpent = 0n;
  world.pipelineSetFails = false;
  world.getFails = null;
  world.readDelayMs = 0;
  world.readHangs = false;
  world.resendStatus = 200;
  kv.clear();
  resend.length = 0;
  horizonRequests.length = 0;
  opsRequests.length = 0;
  instanceReads.length = 0;
  trace.length = 0;
  haltReasons.length = 0;
  haltedAtFirstRpc = null;
  rpcRequests = 0;
  resetHaltCache();
  delete process.env.SPONSOR_HALT;
  delete process.env.RESEND_API_KEY;
  delete process.env.ALERT_NOTIFY_TO;
  delete process.env.FEEDBACK_NOTIFY_TO;
  delete process.env.LUMENDROP_WASM_HASH;
  delete process.env.MAX_DAY_FEE_XLM;
  // The store's fallback names, in case the shell running this exports a real store under them.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.STELLAR_NETWORK = "testnet";
  process.env.WATCHDOG_RETRY_BASE_MS = "1"; // the 1 s and 3 s pauses between retries, shrunk for the suite
  process.env.KV_REST_API_URL = "https://fake-kv.test";
  process.env.KV_REST_API_TOKEN = "t";
  process.env.SPONSOR_MIN_XLM = "50";
  process.env.SPONSOR_MIN_RECIPIENTS = "25";
  process.env.SPONSOR_MIN_TTL_DAYS = "21";
}

function mailOn(): void {
  process.env.RESEND_API_KEY = "re_test";
  process.env.ALERT_NOTIFY_TO = "owner@example.test";
}

const titles = (alerts: Alert[], severity?: Alert["severity"]) =>
  alerts.filter((a) => !severity || a.severity === severity).map((a) => a.title);
const has = (alerts: Alert[], title: string) => alerts.some((a) => a.title === title);
const detail = (alerts: Alert[], title: string) => alerts.find((a) => a.title === title)?.detail ?? "";
const halted = () => kv.get(haltKey("testnet")) === "1";

async function main() {
  console.log("============================================================");
  console.log(" WATCHDOG TESTS (offline: fake Horizon, RPC, store and mail)");
  console.log("============================================================\n");

  console.log("[1] a quiet scheduled run: every check runs, nothing pages, both heartbeat stamps are written");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check(
      "all five checks ran",
      ["sponsor-account", "escrow-governance", "escrow-wasm", "escrow-ttl", "fee-budget"].every((c) => r.checked.includes(c)),
      r.checked.join(","),
    );
    const pages = titles(r.alerts, "page").filter((t) => t !== "Watchdog cannot deliver alerts");
    check("no page other than the unconfigured-alerting one", pages.length === 0, pages.join(" | "));
    check("the heartbeat stamp was written under watchdog:<net>:lastrun", /^\d{4}-\d{2}-\d{2}T/.test(kv.get(lastRunKey("testnet")) ?? ""), kv.get(lastRunKey("testnet")));
    check("the report carries the same stamp", r.lastRun === kv.get(lastRunKey("testnet")));
    check("watchdogLastRun() reads it back", (await watchdogLastRun("testnet")) === r.lastRun);
    check("every check completed, so watchdog:<net>:lastfull carries the same stamp", r.lastFullRun === r.lastRun && kv.get(lastFullRunKey("testnet")) === r.lastRun);
    const stamps = await watchdogStamps("testnet");
    check("watchdogStamps() returns both stamps for /health", stamps.lastRun === r.lastRun && stamps.lastFullRun === r.lastRun, JSON.stringify(stamps));
    check("nothing auto-halted and the halt key is absent", !r.autoHalted && !halted());
    check("the fee budget check reports an info line with the day's spend", has(r.alerts, "Sponsor fee budget"));
    check("the state expiry check reports an info line", has(r.alerts, "Escrow contract state expiry"));
  }

  console.log("[2] float under the floor: a page, never a halt (halt blocks the exits)");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.xlm = "20.0000000";
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("pages 'Sponsor float below the floor'", has(r.alerts, "Sponsor float below the floor"));
    check("does NOT halt", !r.autoHalted && !halted());
  }

  console.log("[3] onboarding capacity under the floor: a page, never a halt");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.xlm = "60.0000000";
  world.sponsoring = 100; // minimum = (2 + 100) * 0.5 = 51 XLM -> 9 XLM spendable -> 6 recipients
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    const a = r.alerts.find((x) => x.title === "Sponsor onboarding capacity below the floor");
    check("pages the capacity floor", !!a);
    check("names how many recipients are left, computed from the sponsored entries", /Only 6 more recipients/.test(a?.detail ?? ""), a?.detail.slice(0, 60));
    check("does NOT halt", !r.autoHalted && !halted());
  }

  console.log("[4] the sponsor SOURCED a forbidden operation: a page AND an auto-halt through sponsor:halt:<net>");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.ops = [op("create_account", SPONSOR, 1), op("set_options", SPONSOR, 2)];
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("pages the forbidden-op tripwire", has(r.alerts, TRIPWIRE_FORBIDDEN_OP));
    check("the page names the transaction", detail(r.alerts, TRIPWIRE_FORBIDDEN_OP).includes(op("set_options", SPONSOR, 2).transaction_hash));
    check("the run reports autoHalted", r.autoHalted);
    check("sponsor:halt:testnet is now '1' in the store", halted());
    check("the reason is stored next to it, stamped and naming the tripwire", /^\d{4}-.*watchdog auto-halt: Sponsor SOURCED a forbidden operation/.test(kv.get(haltReasonKey("testnet")) ?? ""), kv.get(haltReasonKey("testnet")));
    check("the bare legacy key was NOT written (a testnet halt must never reach mainnet)", !kv.has(HALT_KEY));
    check("an AUTO-HALTED page tells the operator how to resume", has(r.alerts, AUTO_HALT_TITLE) && /del\/sponsor:halt:testnet/.test(detail(r.alerts, AUTO_HALT_TITLE)));
    check("the kill switch now reads halted from the store", (resetHaltCache(), await isHalted()) === true);
    check("haltStatus names the store and the reason", await haltStatus().then((h) => h.source === "store" && /auto-halt/.test(h.reason ?? "")));
    check("the ops cursor advanced past the scanned page", kv.get(OPS_CURSOR) === "2");
    const again = await runWatchdog(config, SPONSOR, WORKER);
    check("the next run, with no new operations, pages nothing new and does not re-halt", !has(again.alerts, TRIPWIRE_FORBIDDEN_OP) && !again.autoHalted);
  }

  console.log("[5] the same operations sourced by somebody else: nothing");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.ops = [op("payment", stranger.publicKey(), 3), op("set_options", stranger.publicKey(), 4)];
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("no forbidden-op page", !has(r.alerts, TRIPWIRE_FORBIDDEN_OP));
    check("no halt", !r.autoHalted && !halted());
  }

  console.log("[6] an escrow governance event: a page, never a halt (the owner may well have meant it)");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.events = [{ topic: [topic("paused")], ledger: 999_990, txHash: "ee".repeat(32) }];
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("pages 'Escrow governance event: paused'", has(r.alerts, "Escrow governance event: paused"));
    check("does NOT halt", !r.autoHalted && !halted());
    check("the ledger cursor advanced to the latest ledger", kv.get(`watchdog:ledger:${CONTRACT}`) === String(world.latest));
  }

  console.log("[7] the escrow wasm hash changed and a second read agrees: a page AND an auto-halt");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.runningWasm = OTHER_WASM;
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("pages the wasm tripwire", has(r.alerts, TRIPWIRE_WASM_CHANGED));
    check("the page names both hashes", /(ab){32}.*expected 4b5780eb/.test(detail(r.alerts, TRIPWIRE_WASM_CHANGED).replace(/\n/g, " ")));
    check("the mismatch was read twice before anything halted", instanceReads.length === 2, `${instanceReads.length} reads`);
    check("auto-halted through the namespaced key", r.autoHalted && halted());
    check("the reason names the wasm tripwire", /Escrow WASM CHANGED/.test(kv.get(haltReasonKey("testnet")) ?? ""));
    const page = detail(r.alerts, AUTO_HALT_TITLE);
    check(
      "the AUTO-HALTED page says to pin the new hash and deploy FIRST, then resume",
      page.includes(`LUMENDROP_WASM_HASH = "${OTHER_WASM}"`) && /FIRST/.test(page) && /THEN resume/.test(page) && page.indexOf("LUMENDROP_WASM_HASH") < page.indexOf("To resume:"),
      page.slice(0, 120),
    );
  }

  console.log("[8] the wasm hash matches, or there is no pin yet");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("a matching pin pages nothing", !has(r.alerts, TRIPWIRE_WASM_CHANGED) && !r.autoHalted);
  }
  quiet();
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("with no pin the first sighting becomes the baseline in the store", kv.get(`watchdog:wasm:${CONTRACT}`) === WASM && !has(r.alerts, TRIPWIRE_WASM_CHANGED));
    world.runningWasm = OTHER_WASM;
    const next = await runWatchdog(config, SPONSOR, WORKER);
    check("and a later change against that baseline pages and halts", has(next.alerts, TRIPWIRE_WASM_CHANGED) && next.autoHalted);
    check(
      "whose page says to record the new baseline in the store FIRST",
      detail(next.alerts, AUTO_HALT_TITLE).includes(`/set/watchdog:wasm:${CONTRACT}/${OTHER_WASM}`),
    );
  }

  console.log("[9] state expiry: a page inside the floor, an info line outside, never a halt");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.codeUntil = world.latest + 100_000; // 5.8 days at 5 s per ledger
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    const a = r.alerts.find((x) => x.title === "Escrow contract state expiry approaching");
    check("pages the expiry floor", !!a);
    check("the page says which entry and carries the extend commands", /The code entry archives/.test(a?.detail ?? "") && /stellar contract extend --wasm-hash/.test(a?.detail ?? ""));
    check("does NOT halt", !r.autoHalted && !halted());
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("far from expiry the check reports an info line", has(r.alerts, "Escrow contract state expiry") && !has(r.alerts, "Escrow contract state expiry approaching"));
  }

  console.log("[10] a check that cannot run reports its own failure, never halts, never stops the others");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.down.add("horizon");
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("reports 'Watchdog check failed: sponsor account'", has(r.alerts, "Watchdog check failed: sponsor account"));
    check("a busy source on its first run is an info line, not a page", !titles(r.alerts, "page").includes("Watchdog check failed: sponsor account") && titles(r.alerts, "info").includes("Watchdog check failed: sponsor account"));
    check("the failure names the host and the status, not a parser error", /horizon\.fake answered 502/.test(r.alerts.find((a) => a.title.endsWith("sponsor account"))?.detail ?? ""));
    check("the other checks still ran", r.checked.includes("escrow-governance") && r.checked.includes("escrow-wasm") && r.checked.includes("fee-budget"));
    check("no halt", !r.autoHalted && !halted());
    check("the heartbeat was still written", !!kv.get(lastRunKey("testnet")));
    check("but not the full-run stamp: a check failed", r.lastFullRun === null && !kv.has(lastFullRunKey("testnet")));
  }

  console.log("[11] the fee budget: a page at 80 percent, an info line below, an info line when unreadable");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  process.env.MAX_DAY_FEE_XLM = "10";
  world.feeSpent = 85_000_000n; // 8.5 XLM of 10
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    const a = r.alerts.find((x) => x.title === "Sponsor fee budget nearly spent");
    check("pages 'Sponsor fee budget nearly spent'", !!a);
    check("the page carries the numbers in XLM", /8\.5 of 10 XLM/.test(a?.detail ?? ""), a?.detail.slice(0, 40));
    check("does NOT halt", !r.autoHalted && !halted());
  }
  world.feeSpent = 30_000_000n;
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("below 80 percent only the info line", has(r.alerts, "Sponsor fee budget") && !has(r.alerts, "Sponsor fee budget nearly spent"));
  }
  world.feeSpent = null;
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("an unreadable counter is an info line, not a page", has(r.alerts, "Sponsor fee budget unreadable") && !has(r.alerts, "Sponsor fee budget nearly spent"));
  }

  console.log("[12] delivery: unconfigured sends nothing; configured sends once, per-network cooldown, started only by a delivered mail");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.xlm = "20.0000000";
  {
    check("alertingStatus names what is missing", !alertingStatus().configured && alertingStatus().missing.includes("RESEND_API_KEY"));
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("unconfigured: pages 'Watchdog cannot deliver alerts'", has(r.alerts, "Watchdog cannot deliver alerts"));
    check("unconfigured: no mail was sent", resend.length === 0);
    check("unconfigured: no cooldown key was stamped (so the first configured run still mails)", ![...kv.keys()].some((k) => k.includes(":alerted:")));
  }
  mailOn();
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("configured: the unconfigured page is gone", !has(r.alerts, "Watchdog cannot deliver alerts"));
    check("configured: exactly one mail, naming the float page", resend.length === 1 && /float below the floor/i.test(resend[0]!.subject + resend[0]!.text));
    check("the cooldown keys are namespaced by network", [...kv.keys()].some((k) => k.startsWith("watchdog:testnet:alerted:")) && ![...kv.keys()].some((k) => k.startsWith("watchdog:alerted:")));
    await runWatchdog(config, SPONSOR, WORKER);
    check("a second run inside the cooldown sends no second mail", resend.length === 1);
    const mainnetDue = await withoutRepeats([{ severity: "page", title: "Sponsor float below the floor", detail: "x" }], "mainnet");
    check("the same title on MAINNET is not silenced by testnet's cooldown", mainnetDue.length === 1);
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.xlm = "20.0000000";
  mailOn();
  world.resendStatus = 500;
  {
    await runWatchdog(config, SPONSOR, WORKER);
    check("Resend answered 500: the mail was attempted and no cooldown was started", resend.length === 1 && ![...kv.keys()].some((k) => k.includes(":alerted:")));
    world.resendStatus = 200;
    await runWatchdog(config, SPONSOR, WORKER);
    check(
      "so the next run sends the same page again, and only that delivered mail starts the cooldown",
      resend.length === 2 && Number(kv.get("watchdog:testnet:alerted:sponsor-float-below-the-floor") ?? "0") > 0,
    );
    await runWatchdog(config, SPONSOR, WORKER);
    check("after which the page is held", resend.length === 2);
  }
  quiet();
  {
    const one: Alert[] = [{ severity: "page", title: "A test page", detail: "first" }];
    check("withoutRepeats: a new page is due", (await withoutRepeats(one, "testnet")).length === 1);
    check("and withoutRepeats alone starts no cooldown", (await withoutRepeats(one, "testnet")).length === 1);
    await markAlerted(one, "testnet");
    check("once marked delivered, the same title is held", (await withoutRepeats([{ severity: "page", title: "A test page", detail: "other numbers" }], "testnet")).length === 0);
    check("unless it is forced through", (await withoutRepeats(one, "testnet", { force: () => true })).length === 1);
    await withoutRepeats([], "testnet"); // a run where the condition cleared
    check("a page that cleared and came back is due again", (await withoutRepeats(one, "testnet")).length === 1);
  }

  console.log("[13] the heartbeat is written even when every upstream is down");
  quiet();
  world.down.add("horizon");
  world.down.add("rpc");
  {
    const t0 = Date.now();
    await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 }); // the outage begins
    kv.delete(lastRunKey("testnet"));
    const r = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 + BLIND_GRACE_MS + 60_000 });
    check("once the outage has lasted the grace, every check pages its own failure", titles(r.alerts, "page").filter((t) => t.startsWith("Watchdog check failed")).length >= 4, titles(r.alerts, "page").join(" | "));
    check("no halt from failures", !r.autoHalted && !halted());
    check("the heartbeat stamp is there", !!kv.get(lastRunKey("testnet")));
    check("and the full-run stamp is not", !kv.has(lastFullRunKey("testnet")));
  }

  console.log("[13b] a busy source pages only once it has lasted the grace; an answer, an operator's run or an unreadable store page at once");
  quiet();
  mailOn();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.down.add("rpc");
  {
    const BLIND = "watchdog:testnet:blind";
    const RPC_CHECKS = ["Watchdog check failed: escrow governance", "Watchdog check failed: escrow wasm hash", "Watchdog check failed: escrow state expiry"];
    const t0 = Date.now();
    const first = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 });
    check("first throttled run: the three RPC checks are info lines", RPC_CHECKS.every((t) => titles(first.alerts, "info").includes(t)), titles(first.alerts).join(" | "));
    check("first throttled run: none of them pages", RPC_CHECKS.every((t) => !titles(first.alerts, "page").includes(t)));
    check("first throttled run: no mail about them", !resend.some((m) => /Watchdog check failed/.test(`${m.subject}\n${m.text}`)));
    check("the info line says when it will page", /pages if this lasts 45 minutes/.test(detail(first.alerts, RPC_CHECKS[0]!)), detail(first.alerts, RPC_CHECKS[0]!).slice(-160));
    const ledger = JSON.parse(kv.get(BLIND) ?? "{}") as Record<string, number>;
    check("the blind ledger records when each RPC check began failing", Object.keys(ledger).length === 3 && Object.values(ledger).every((v) => v === t0), kv.get(BLIND));
    check("the full-run stamp stays stale while blind", first.lastFullRun === null);

    const mid = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 + 30 * 60_000 });
    check("30 minutes in: still info lines, still no page", RPC_CHECKS.every((t) => titles(mid.alerts, "info").includes(t) && !titles(mid.alerts, "page").includes(t)));
    check("30 minutes in: the line counts the minutes", /for 30 minutes so far/.test(detail(mid.alerts, RPC_CHECKS[1]!)), detail(mid.alerts, RPC_CHECKS[1]!).slice(-160));
    check("30 minutes in: the start time is kept, not reset", (JSON.parse(kv.get(BLIND) ?? "{}") as Record<string, number>)[Object.keys(ledger)[0]!] === t0);

    const late = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 + 46 * 60_000 });
    check("46 minutes in: all three page", RPC_CHECKS.every((t) => titles(late.alerts, "page").includes(t)), titles(late.alerts, "page").join(" | "));
    check("46 minutes in: the page says how long and since when", /Every run for 46 minutes \(since \d{4}-/.test(detail(late.alerts, RPC_CHECKS[2]!)), detail(late.alerts, RPC_CHECKS[2]!).slice(-120));
    check("46 minutes in: the page was mailed", resend.some((m) => /Watchdog check failed: escrow governance/.test(`${m.subject}\n${m.text}`)));

    world.down.delete("rpc");
    const back = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 + 60 * 60_000 });
    check("the source answers again: no check-failed line at all", !titles(back.alerts).some((t) => t.startsWith("Watchdog check failed")));
    check("and the blind ledger is emptied", kv.get(BLIND) === "{}", kv.get(BLIND));
    check("and the run is a full run again", back.lastFullRun !== null);
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.down.add("rpc");
  {
    const r = await runWatchdog(config, SPONSOR, { autoHalt: false, heartbeat: false, confirmDelayMs: 5 });
    check("an operator's run (no heartbeat) pages a busy source at once", titles(r.alerts, "page").includes("Watchdog check failed: escrow governance"));
    check("and writes no blind ledger", !kv.has("watchdog:testnet:blind"));
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.down.add("rpc-answer");
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("a considered RPC answer (an error object) pages at once, no grace", titles(r.alerts, "page").includes("Watchdog check failed: escrow governance"), titles(r.alerts).join(" | "));
    check("and it is not recorded as blind", !(kv.get("watchdog:testnet:blind") ?? "{}").includes("governance"));
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.down.add("rpc");
  world.down.add("kv");
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("with the store unreadable there is no memory, so a busy source pages at once", titles(r.alerts, "page").includes("Watchdog check failed: escrow governance"), titles(r.alerts).join(" | "));
  }

  console.log("[13c] the grace rests on a record the store keeps, a refusal is no busy source, a late cron start costs no run, and a tripwire missed while blind still halts");
  {
    const GOV = "Watchdog check failed: escrow governance";
    const WASM_CHECK = "Watchdog check failed: escrow wasm hash";
    const ACCOUNT = "Watchdog check failed: sponsor account";
    const BLIND = "watchdog:testnet:blind";
    const mailed = (title: string) => resend.some((m) => `${m.subject}\n${m.text}`.includes(title));

    quiet();
    mailOn();
    process.env.LUMENDROP_WASM_HASH = WASM;
    delete process.env.KV_REST_API_URL;
    world.down.add("rpc");
    {
      const t0 = Date.now();
      const first = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 });
      const later = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 + 3 * HOUR });
      check(
        "with no store at all nothing carries a start time between runs, so a busy source pages at once, on every run",
        [first, later].every((r) => titles(r.alerts, "page").includes(GOV)),
        titles(first.alerts).join(" | "),
      );
    }
    process.env.KV_REST_API_URL = "https://fake-kv.test";

    quiet();
    mailOn();
    process.env.LUMENDROP_WASM_HASH = WASM;
    world.down.add("rpc");
    world.down.add("kv-set");
    {
      const r = await runWatchdog(config, SPONSOR, WORKER);
      check(
        "a store that reads but refuses the write: no later run could count the grace, so the busy checks page now",
        titles(r.alerts, "page").includes(GOV) && titles(r.alerts, "page").includes(WASM_CHECK) && !titles(r.alerts, "info").includes(GOV),
        titles(r.alerts).join(" | "),
      );
      check("the page says why it did not wait", /could not save when this began/.test(detail(r.alerts, GOV)), detail(r.alerts, GOV).slice(-110));
      check("and it was mailed", mailed(GOV));
    }
    quiet();
    process.env.LUMENDROP_WASM_HASH = WASM;
    world.down.add("rpc");
    world.down.add("kv-set");
    {
      // An outage already 15 minutes old, kept by an earlier run; this run's write (the sponsor
      // account check cleared) is refused, but the RPC checks' start is in the store already.
      const t0 = Date.now();
      kv.set(BLIND, JSON.stringify({ "watchdog-check-failed-escrow-governance": t0 - 15 * 60_000, "watchdog-check-failed-sponsor-account": t0 - 15 * 60_000 }));
      const r = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 });
      check("a refused write does not page a failure whose start an earlier run already kept", titles(r.alerts, "info").includes(GOV), titles(r.alerts).join(" | "));
      check("while one whose start rested on this write does", titles(r.alerts, "page").includes(WASM_CHECK), titles(r.alerts).join(" | "));
    }

    quiet();
    process.env.LUMENDROP_WASM_HASH = WASM;
    world.down.add("rpc-refused");
    {
      const r = await runWatchdog(config, SPONSOR, WORKER);
      check(
        "the RPC refusing the request (403, a firewall block) is an answer, not a busy source: it pages at once",
        titles(r.alerts, "page").includes(GOV) && titles(r.alerts, "page").includes(WASM_CHECK),
        titles(r.alerts).join(" | "),
      );
      check("unretried: one request each for getLatestLedger and the instance read", rpcRequests === 2, `${rpcRequests} requests`);
      check("and nothing is recorded as blind", !kv.has(BLIND), kv.get(BLIND));
      check("the page names the status and the body", /HTTP 403, and the body was not JSON: error code: 1020/.test(detail(r.alerts, GOV)), detail(r.alerts, GOV));
    }
    quiet();
    process.env.LUMENDROP_WASM_HASH = WASM;
    world.down.add("horizon-404");
    {
      const r = await runWatchdog(config, SPONSOR, WORKER);
      check(
        "Horizon answering 404 for the sponsor account (merged, or a wrong id) pages at once, unretried",
        titles(r.alerts, "page").includes(ACCOUNT) && /horizon\.fake answered 404/.test(detail(r.alerts, ACCOUNT)) && horizonRequests.length === 1,
        `${horizonRequests.length} requests: ${detail(r.alerts, ACCOUNT)}`,
      );
    }

    quiet();
    process.env.LUMENDROP_WASM_HASH = WASM;
    world.down.add("rpc");
    {
      // Cron runs start some seconds after their minute, by a different amount each time.
      const t0 = Date.now();
      const at = (minutes: number, lateSeconds: number) => runWatchdog(config, SPONSOR, { ...WORKER, now: t0 + minutes * 60_000 + lateSeconds * 1000 });
      await at(0, 20);
      await at(15, 5);
      const thirty = await at(30, 9);
      check("the run 30 minutes on still waits", titles(thirty.alerts, "info").includes(GOV) && !titles(thirty.alerts, "page").includes(GOV));
      const fortyFive = await at(45, 1);
      check(
        "the run 45 minutes on pages although it started less late than the first did (44 min 41 s apart)",
        titles(fortyFive.alerts, "page").includes(GOV),
        titles(fortyFive.alerts).join(" | "),
      );
    }

    quiet();
    process.env.LUMENDROP_WASM_HASH = WASM;
    process.env.WATCHDOG_RETRY_BASE_MS = "50"; // pauses of 50 and 150 ms, at most 200 ms each
    world.down.add("rpc");
    world.retryAfter = "3600";
    {
      const t = Date.now();
      await runWatchdog(config, SPONSOR, { autoHalt: false, heartbeat: false, confirmDelayMs: 5 });
      const took = Date.now() - t;
      // getLatestLedger and the instance read, three attempts each: four pauses, 400 ms without the header.
      check("the throttle's Retry-After is honoured up to the cap (four pauses of 200 ms)", took >= 700, `${took} ms`);
      check("and never past it: an hour asked is not an hour waited", took < 5_000, `${took} ms`);
    }

    quiet();
    mailOn();
    process.env.LUMENDROP_WASM_HASH = WASM;
    kv.set(OPS_CURSOR, "100");
    world.down.add("horizon");
    {
      const t0 = Date.now();
      const blind1 = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 });
      world.ops = [op("create_account", SPONSOR, 101), op("payment", SPONSOR, 102)]; // the theft, while the scan cannot see
      const blind2 = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 + 15 * 60_000 });
      check(
        "while Horizon is busy the scan waits as an info line and its cursor stays put",
        [blind1, blind2].every((r) => titles(r.alerts, "info").includes(ACCOUNT) && !r.autoHalted) && kv.get(OPS_CURSOR) === "100",
      );
      world.down.delete("horizon");
      const back = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 + 30 * 60_000 });
      check(
        "the first run Horizon answers walks on from the old cursor, finds the operation and halts, grace or not",
        has(back.alerts, TRIPWIRE_FORBIDDEN_OP) && back.autoHalted && halted() && kv.get(OPS_CURSOR) === "102",
        kv.get(OPS_CURSOR),
      );
      check("and that halt is mailed", resend.some((m) => /AUTO-HALTED/.test(m.text)));
    }
  }

  console.log("[14] the kill switch: env flag, namespaced key, legacy key, clear, explicit network, and fail-open on a store error");
  quiet();
  {
    check("not halted by default", !(await isHalted()));
    resetHaltCache();
    kv.set(haltKey("testnet"), "1");
    kv.set(haltReasonKey("testnet"), "2026-10-07T00:00:00.000Z by hand");
    check("sponsor:halt:testnet = 1 halts, source 'store', with the reason", await haltStatus().then((h) => h.halted && h.source === "store" && h.reason === "2026-10-07T00:00:00.000Z by hand"));
    resetHaltCache();
    kv.set(haltKey("mainnet"), "1");
    kv.delete(haltKey("testnet"));
    kv.delete(haltReasonKey("testnet"));
    check("sponsor:halt:mainnet does NOT halt the testnet sponsor", !(await isHalted()));
    check("but an explicit mainnet read sees it", await isHalted(Date.now(), "mainnet"));
    kv.delete(haltKey("mainnet"));
    resetHaltCache();
    kv.set(HALT_KEY, "1");
    check("the legacy bare key still halts, source 'store-legacy'", await haltStatus().then((h) => h.halted && h.source === "store-legacy"));
    kv.delete(HALT_KEY);
    resetHaltCache();
    process.env.SPONSOR_HALT = "1";
    check("SPONSOR_HALT=1 halts with no store read, source 'env'", await haltStatus().then((h) => h.halted && h.source === "env"));
    delete process.env.SPONSOR_HALT;
    resetHaltCache();
    {
      // A burst that finds the cache stale shares ONE store read (per isolate and network), instead
      // of each request starting its own while the first is still out.
      const before = storePipelines;
      const burst = await Promise.all(Array.from({ length: 25 }, () => haltStatus()));
      check(
        "25 concurrent halt reads on a stale cache cost ONE store read, and all get the same verdict",
        storePipelines - before === 1 && burst.every((h) => !h.halted),
        `${storePipelines - before} reads`,
      );
      const again = storePipelines;
      await haltStatus();
      check("and the next read inside 5 s is served from the cache (no store read)", storePipelines === again);
      resetHaltCache();
    }
    {
      /* A read in flight must not overwrite a halt written meanwhile, whatever time the halt was
         stamped with: the watchdog stamps it with its run's START, older than the read. */
      world.readDelayMs = 50;
      const inFlight = haltStatus(); // the store still says "not halted"
      await new Promise((r) => setTimeout(r, 5));
      await setHalt("testnet", "auto-halt during a read", Date.now() - 10_000);
      await inFlight;
      world.readDelayMs = 0;
      check("a halt written while a read was in flight survives that read's answer", await isHalted());
      await clearHalt("testnet");
      resetHaltCache();
      world.readHangs = true;
      // Node's AbortSignal.timeout timer does not hold the event loop open (a Worker request does).
      const keepAlive = setTimeout(() => {}, 10_000);
      const t0 = Date.now();
      const hung = await haltStatus();
      const took = Date.now() - t0;
      clearTimeout(keepAlive);
      world.readHangs = false;
      check("a read that never answers fails OPEN after about 2 s instead of holding every request", !hung.halted && took >= 1_500 && took < 4_000, `${took} ms`);
      resetHaltCache();
    }
    check("setHalt writes the key and the stamped reason", (await setHalt("testnet", "rehearsal")) && halted() && /rehearsal$/.test(kv.get(haltReasonKey("testnet")) ?? ""));
    check("and the verdict is halted at once (cache updated)", await isHalted());
    check("storeHaltIsSet reads the key past the cache", (await storeHaltIsSet("testnet")) === true && (await storeHaltIsSet("mainnet")) === false);
    check("clearHalt removes both and resumes", (await clearHalt("testnet")) && !halted() && !kv.has(haltReasonKey("testnet")) && !(await isHalted()));
    kv.set(haltKey("mainnet"), "1");
    await clearHalt("testnet");
    check("clearHalt never touches another network's key", kv.get(haltKey("mainnet")) === "1");
    kv.delete(haltKey("mainnet"));
    resetHaltCache();
    check(
      "setHalt halts the network it is GIVEN, whatever the environment says",
      (await setHalt("mainnet", "explicit")) && kv.get(haltKey("mainnet")) === "1" && !halted() && !(await isHalted()) && (await isHalted(Date.now(), "mainnet")),
    );
    await clearHalt("mainnet");
    resetHaltCache();
    world.down.add("kv");
    check("a store error fails OPEN (decided and disclosed): not halted", !(await isHalted()));
    check("and storeHaltIsSet says it cannot tell", (await storeHaltIsSet("testnet")) === null);
    world.down.delete("kv");
    delete process.env.KV_REST_API_URL;
    resetHaltCache();
    check("setHalt with no store returns false (the page is then the only answer)", (await setHalt("testnet", "x")) === false);
    process.env.KV_REST_API_URL = "https://fake-kv.test";
  }

  console.log("[15] the auto-halt scope is exactly two titles");
  {
    check("the forbidden-op tripwire halts", isAutoHaltTripwire(TRIPWIRE_FORBIDDEN_OP));
    check("the wasm tripwire halts", isAutoHaltTripwire(TRIPWIRE_WASM_CHANGED));
    for (const t of [
      "Sponsor float below the floor",
      "Sponsor onboarding capacity below the floor",
      "Sponsor account unreadable",
      "Escrow contract state expiry approaching",
      "Escrow contract instance not found",
      "Escrow governance event: paused",
      "Watchdog check failed: sponsor account",
      "Sponsor fee budget nearly spent",
      "Watchdog cannot deliver alerts",
      FORBIDDEN_OP_OLD_TITLE,
      OPS_SCAN_BEHIND_TITLE,
      WASM_UNCONFIRMED_TITLE,
      AUTO_HALT_FAILED_TITLE,
      AUTO_HALT_SKIPPED_TITLE,
    ]) {
      check(`'${t}' never halts`, !isAutoHaltTripwire(t));
    }
  }

  console.log("[16] the heartbeat age rule the dead-man workflow applies");
  {
    const now = Date.UTC(2026, 9, 7, 12, 0, 0);
    check("no stamp is null", watchdogAge(null, now) === null);
    check("a stamp from this instant is 0 s", watchdogAge(new Date(now).toISOString(), now) === 0);
    check("a stamp from 45 minutes ago is 2700 s", watchdogAge(new Date(now - 45 * 60_000).toISOString(), now) === 2700);
    check("garbage is null, never 0", watchdogAge("yesterday-ish", now) === null);
    check("a stamp 10 minutes in the FUTURE is -600 s, not a fresh 0", watchdogAge(new Date(now + 10 * 60_000).toISOString(), now) === -600);
  }

  console.log("[17] the escrow instance is missing: a page, never a halt");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.instanceMissing = true;
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("pages 'Escrow contract instance not found'", has(r.alerts, "Escrow contract instance not found"));
    check("the page names the contract", detail(r.alerts, "Escrow contract instance not found").includes(CONTRACT));
    check("does NOT halt (an archived instance or a wrong id is not a theft)", !r.autoHalted && !halted() && !has(r.alerts, TRIPWIRE_WASM_CHANGED));
    check("and no check reported itself broken over it", !titles(r.alerts).some((t) => t.startsWith("Watchdog check failed")));
  }

  console.log("[18] Horizon answers the sponsor account without a native balance: a page, never a halt, not a full run");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.accountUnreadable = true;
  world.ops = [op("payment", SPONSOR, 5)];
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("pages 'Sponsor account unreadable'", has(r.alerts, "Sponsor account unreadable"));
    check("does NOT halt", !r.autoHalted && !halted());
    check("the forbidden-operation scan did not run", opsRequests.length === 0 && !has(r.alerts, TRIPWIRE_FORBIDDEN_OP));
    check("so the run is not a full run", !r.checked.includes("sponsor-account") && r.lastFullRun === null && !kv.has(lastFullRunKey("testnet")));
    check("while the heartbeat itself is written", !!r.lastRun && kv.get(lastRunKey("testnet")) === r.lastRun);
  }

  console.log("[19] a wasm halt, resumed WITHOUT re-pinning: the next run halts again, and that new halt is mailed at once");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.runningWasm = OTHER_WASM;
  mailOn();
  {
    const t0 = Date.now();
    const r1 = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 });
    check("run 1 halts and mails the halt", r1.autoHalted && halted() && resend.length === 1 && /AUTO-HALTED/.test(resend[0]!.text));
    check("the mail names the hash to pin", resend[0]!.text.includes(`LUMENDROP_WASM_HASH = "${OTHER_WASM}"`));
    await clearHalt("testnet"); // the operator resumes as the page used to say, without the re-pin
    const r2 = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 + 15 * 60_000 });
    check("run 2, fifteen minutes later, halts again: the pin still names the old hash", r2.autoHalted && halted());
    check("and that NEW halt is mailed although its titles are inside the cooldown", resend.length === 2 && /AUTO-HALTED/.test(resend[1]!.text));
    const r3 = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 + 30 * 60_000 });
    check("run 3, with the halt still in place, keeps it without a third mail", r3.autoHalted && halted() && resend.length === 2);
    process.env.LUMENDROP_WASM_HASH = OTHER_WASM; // pinned and deployed first...
    await clearHalt("testnet"); // ...then resumed
    const r4 = await runWatchdog(config, SPONSOR, { ...WORKER, now: t0 + 45 * 60_000 });
    check("pinned first, then resumed: the next run neither pages the wasm nor halts", !has(r4.alerts, TRIPWIRE_WASM_CHANGED) && !r4.autoHalted && !halted());
  }

  console.log("[20] the config says testnet, the shell says mainnet: everything the run writes follows the CONFIG");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  process.env.STELLAR_NETWORK = "mainnet";
  world.ops = [op("set_options", SPONSOR, 6)];
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("the halt is written to sponsor:halt:testnet", r.autoHalted && halted());
    check("and NOT to sponsor:halt:mainnet", !kv.has(haltKey("mainnet")) && !kv.has(haltReasonKey("mainnet")));
    const page = detail(r.alerts, AUTO_HALT_TITLE);
    check("the page names the key that was written, and only that one", page.includes("del/sponsor:halt:testnet") && !page.includes("sponsor:halt:mainnet"));
    check("the heartbeat lands under watchdog:testnet:lastrun", kv.has(lastRunKey("testnet")) && !kv.has(lastRunKey("mainnet")));
    check("a Worker serving mainnet does not read itself halted", (resetHaltCache(), !(await isHalted())));
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.ops = [op("account_merge", SPONSOR, 7)];
  {
    const r = await runWatchdog(mainnetConfig, SPONSOR, WORKER);
    check("and the other way round: a mainnet config in a testnet shell halts mainnet only", r.autoHalted && kv.get(haltKey("mainnet")) === "1" && !halted());
    check("with its page and heartbeat under mainnet", detail(r.alerts, AUTO_HALT_TITLE).includes("del/sponsor:halt:mainnet") && kv.has(lastRunKey("mainnet")) && !kv.has(lastRunKey("testnet")));
  }

  console.log("[21] halting and writing are opt-in: a run without autoHalt and heartbeat changes nothing");
  const bothTripwires = () => {
    quiet();
    process.env.LUMENDROP_WASM_HASH = WASM;
    world.runningWasm = OTHER_WASM;
    world.ops = [op("payment", SPONSOR, 8)];
    world.events = [{ topic: [topic("paused")], ledger: 999_990, txHash: "ab".repeat(32) }];
    mailOn();
  };
  bothTripwires();
  {
    const r = await runWatchdog(config, SPONSOR, { confirmDelayMs: 5 });
    check("both tripwires still page", has(r.alerts, TRIPWIRE_FORBIDDEN_OP) && has(r.alerts, TRIPWIRE_WASM_CHANGED));
    check("but nothing halts", !r.autoHalted && !halted() && !kv.has(haltReasonKey("testnet")));
    check("and the report says the halt was not attempted", has(r.alerts, AUTO_HALT_SKIPPED_TITLE));
    check("no heartbeat: none written, none reported", r.lastRun === null && r.lastFullRun === null);
    check("no mail", resend.length === 0);
    check("nothing at all was written to the store (no stamp, cursor, cooldown)", kv.size === 0, [...kv.keys()].join(","));
  }
  quiet();
  {
    await runWatchdog(config, SPONSOR, { confirmDelayMs: 5 });
    check("with no pin, a read-only run records no wasm baseline either", kv.size === 0, [...kv.keys()].join(","));
  }
  bothTripwires();
  {
    const r = await runWatchdog(config, SPONSOR, { heartbeat: true, confirmDelayMs: 5 });
    check("heartbeat alone: the stamps are written and the run mails, but nothing halts", !!r.lastRun && kv.has(lastRunKey("testnet")) && resend.length === 1 && !r.autoHalted && !halted());
  }
  bothTripwires();
  {
    const r = await runWatchdog(config, SPONSOR, { autoHalt: true, confirmDelayMs: 5 });
    check("autoHalt alone: halted, but no stamp and no mail", r.autoHalted && halted() && r.lastRun === null && !kv.has(lastRunKey("testnet")) && resend.length === 0);
  }

  console.log("[22] a cold start (no cursor): the newest operations, and nothing older than a day halts");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.ops = [op("set_options", SPONSOR, 10, 3 * DAY), op("create_account", SPONSOR, 11, 2 * DAY)];
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    const url = opsRequests[0] ?? "";
    check(
      `the scan reads the newest ${OPS_PAGE_SIZE} (order=desc, no cursor), not the oldest`,
      opsRequests.length === 1 && url.includes("order=desc") && url.includes(`limit=${OPS_PAGE_SIZE}`) && !url.includes("cursor="),
      url,
    );
    check("a forbidden operation three days old pages without halting", has(r.alerts, FORBIDDEN_OP_OLD_TITLE) && !has(r.alerts, TRIPWIRE_FORBIDDEN_OP) && !r.autoHalted && !halted());
    check("the cursor is set to the newest operation", kv.get(OPS_CURSOR) === "11");
    opsRequests.length = 0;
    const next = await runWatchdog(config, SPONSOR, WORKER);
    check("from then on the scan walks forward from it", (opsRequests[0] ?? "").includes("order=asc") && (opsRequests[0] ?? "").includes("cursor=11") && !has(next.alerts, FORBIDDEN_OP_OLD_TITLE));
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.ops = [op("create_account", SPONSOR, 20, 3 * DAY), op("set_options", SPONSOR, 21, HOUR)];
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("one from the last hour still halts on a cold start", has(r.alerts, TRIPWIRE_FORBIDDEN_OP) && r.autoHalted && halted());
  }
  /* The leniency is for a cold start ONLY. A forward scan halts on what it reaches however late:
     an operation buried under incoming traffic, or one whose halt write kept failing, must not be
     downgraded once it is a day old (the review buried one under ~97,000 payments and it only paged). */
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  kv.set(OPS_CURSOR, "30");
  world.ops = [op("create_account", SPONSOR, 30, 3 * DAY), op("set_options", SPONSOR, 31, 2 * DAY)];
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check(
      "WITH a cursor, a forbidden operation reached two days late still halts (never downgraded on a forward scan)",
      has(r.alerts, TRIPWIRE_FORBIDDEN_OP) && !has(r.alerts, FORBIDDEN_OP_OLD_TITLE) && r.autoHalted && halted(),
    );
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  delete process.env.KV_REST_API_URL;
  world.ops = Array.from({ length: 150 }, (_, i) => op("create_account", SPONSOR, i + 1));
  {
    await runWatchdog(config, SPONSOR, WORKER);
    await runWatchdog(config, SPONSOR, WORKER);
    check(
      "with no store at all every run reads the newest page, never the account's oldest",
      opsRequests.length === 2 && opsRequests.every((u) => u.includes("order=desc") && !u.includes("cursor=")),
      opsRequests.join(" | "),
    );
  }
  process.env.KV_REST_API_URL = "https://fake-kv.test";

  console.log("[22b] a cursor the store cannot read is not a missing cursor: the scan is skipped, never restarted");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  kv.set(OPS_CURSOR, "40");
  world.ops = [op("create_account", SPONSOR, 40, 2 * DAY), op("create_account", SPONSOR, 41, HOUR), op("create_account", SPONSOR, 42, 60_000)];
  world.getFails = /^watchdog:ops:/;
  opsRequests.length = 0;
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check(
      "an unreadable ops cursor pages 'Watchdog check failed: sponsor account' at once (a store error is no busy source), naming the cursor",
      titles(r.alerts, "page").includes("Watchdog check failed: sponsor account") &&
        /cursor could not be read/.test(detail(r.alerts, "Watchdog check failed: sponsor account")),
      detail(r.alerts, "Watchdog check failed: sponsor account"),
    );
    check("no operations page was read (not restarted from the newest page)", opsRequests.length === 0, opsRequests.join(" | "));
    check("the cursor is untouched (no jump written down)", kv.get(OPS_CURSOR) === "40", kv.get(OPS_CURSOR));
    check("and it is not a full run: the heartbeat is stamped, the full-run stamp is not", r.lastRun !== null && r.lastFullRun === null);
    world.getFails = null;
    opsRequests.length = 0;
    await runWatchdog(config, SPONSOR, WORKER);
    check("the next run with a readable store walks forward from the same cursor", (opsRequests[0] ?? "").includes("cursor=40") && kv.get(OPS_CURSOR) === "42", opsRequests[0]);
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  kv.set(`watchdog:ledger:${CONTRACT}`, String(world.latest - 5000));
  world.getFails = /^watchdog:ledger:/;
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check(
      "an unreadable ledger cursor pages 'Watchdog check failed: escrow governance', and the cursor stays",
      titles(r.alerts, "page").includes("Watchdog check failed: escrow governance") && kv.get(`watchdog:ledger:${CONTRACT}`) === String(world.latest - 5000) && r.lastFullRun === null,
      kv.get(`watchdog:ledger:${CONTRACT}`),
    );
    world.getFails = null;
  }
  quiet();
  delete process.env.LUMENDROP_WASM_HASH;
  kv.set(`watchdog:wasm:${CONTRACT}`, WASM);
  world.runningWasm = OTHER_WASM;
  world.getFails = /^watchdog:wasm:/;
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check(
      "an unreadable store pin is not 'no pin yet': no re-pin to the running wasm, a check-failed page instead",
      kv.get(`watchdog:wasm:${CONTRACT}`) === WASM && titles(r.alerts, "page").includes("Watchdog check failed: escrow wasm hash"),
      kv.get(`watchdog:wasm:${CONTRACT}`),
    );
    world.getFails = null;
    resetHaltCache();
    const next = await runWatchdog(config, SPONSOR, WORKER);
    check("and the next readable run still sees the mismatch against the old pin", has(next.alerts, TRIPWIRE_WASM_CHANGED));
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;

  console.log("[23] a tripwire whose halt write fails: the cursor stays short of it, and the next run retries");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  mailOn();
  kv.set(OPS_CURSOR, "100");
  world.ops = [op("create_account", SPONSOR, 100), op("payment", SPONSOR, 101)];
  world.pipelineSetFails = true;
  {
    const r1 = await runWatchdog(config, SPONSOR, WORKER);
    check(
      "the tripwire fired, the write failed: a FAILED page, never an AUTO-HALTED one",
      has(r1.alerts, TRIPWIRE_FORBIDDEN_OP) && has(r1.alerts, AUTO_HALT_FAILED_TITLE) && !has(r1.alerts, AUTO_HALT_TITLE) && !r1.autoHalted && !halted(),
    );
    check("the page names the store error and how to halt by hand", /READONLY/.test(detail(r1.alerts, AUTO_HALT_FAILED_TITLE)) && /SPONSOR_HALT=1/.test(detail(r1.alerts, AUTO_HALT_FAILED_TITLE)));
    check("the scan cursor did NOT move past the operation", kv.get(OPS_CURSOR) === "100");
    check("the failure was mailed", resend.length === 1 && /auto-halt FAILED/.test(resend[0]!.text));
    world.pipelineSetFails = false;
    const r2 = await runWatchdog(config, SPONSOR, WORKER);
    check("the next run finds the same operation again and halts", has(r2.alerts, TRIPWIRE_FORBIDDEN_OP) && r2.autoHalted && halted());
    check("only now does the cursor move past it", kv.get(OPS_CURSOR) === "101");
    check("and the halt that finally landed is mailed at once", resend.length === 2 && /AUTO-HALTED/.test(resend[1]!.text));
  }

  console.log("[24] a backlog of operations: read page after page, and a page when the scan is still behind");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  kv.set(OPS_CURSOR, "0");
  world.ops = [...Array.from({ length: 250 }, (_, i) => op("payment", stranger.publicKey(), i + 1)), op("set_options", SPONSOR, 251)];
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("251 operations are read in one run, three pages", opsRequests.length === 3, `${opsRequests.length} pages`);
    check("so a forbidden operation behind 250 incoming payments is found and halts", has(r.alerts, TRIPWIRE_FORBIDDEN_OP) && r.autoHalted);
    check("and the cursor reaches the newest", kv.get(OPS_CURSOR) === "251");
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  kv.set(OPS_CURSOR, "0");
  world.ops = [...Array.from({ length: 1200 }, (_, i) => op("payment", stranger.publicKey(), i + 1)), op("account_merge", SPONSOR, 1201)];
  {
    const r1 = await runWatchdog(config, SPONSOR, WORKER);
    check(`one run reads at most ${OPS_MAX_PAGES} pages`, opsRequests.length === OPS_MAX_PAGES, `${opsRequests.length} pages`);
    check("and says the scan is behind, without halting", has(r1.alerts, OPS_SCAN_BEHIND_TITLE) && !r1.autoHalted && !halted());
    check("having moved the cursor on by what it read", kv.get(OPS_CURSOR) === String(OPS_MAX_PAGES * OPS_PAGE_SIZE));
    opsRequests.length = 0;
    const r2 = await runWatchdog(config, SPONSOR, WORKER);
    check("the next run catches up and halts on the buried operation", has(r2.alerts, TRIPWIRE_FORBIDDEN_OP) && r2.autoHalted && !has(r2.alerts, OPS_SCAN_BEHIND_TITLE));
  }

  console.log("[25] a wasm mismatch the confirming read does not repeat: a page, never a halt");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.wasmReads = [OTHER_WASM, WASM]; // a lagging node, then the truth
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("pages 'not confirmed' and not the tripwire", has(r.alerts, WASM_UNCONFIRMED_TITLE) && !has(r.alerts, TRIPWIRE_WASM_CHANGED));
    check("does NOT halt", !r.autoHalted && !halted());
    check("after exactly two reads", instanceReads.length === 2, `${instanceReads.length} reads`);
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.wasmReads = [OTHER_WASM, null]; // the confirming read finds no instance
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check("a confirming read that returns nothing does not halt either", has(r.alerts, WASM_UNCONFIRMED_TITLE) && !r.autoHalted && !halted());
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.runningWasm = OTHER_WASM;
  {
    const r = await runWatchdog(config, SPONSOR, { autoHalt: true, heartbeat: true }); // the Worker's own pause
    const gap = (instanceReads[1] ?? 0) - (instanceReads[0] ?? 0);
    check(`by default the confirming read comes ${WASM_CONFIRM_DELAY_MS / 1000} s after the first`, WASM_CONFIRM_DELAY_MS === 2_000 && gap >= 1_900, `${gap} ms`);
    check("and a mismatch both reads agree on halts", r.autoHalted && has(r.alerts, TRIPWIRE_WASM_CHANGED));
  }

  console.log("[26] a full getEvents page: the ledger cursor stops at its last event, so the next run sees the rest");
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  {
    const base = world.latest - 600; // inside the cold-start lookback of 720 ledgers
    world.events = Array.from({ length: 250 }, (_, i) => ({ topic: [topic("claimed")], ledger: base + i, txHash: "cd".repeat(32) }));
    world.events[230] = { topic: [topic("paused")], ledger: base + 230, txHash: "f0".repeat(32) };
    const r1 = await runWatchdog(config, SPONSOR, WORKER);
    check(`a full page of ${EVENTS_PAGE_SIZE} does not reach the 231st event`, !titles(r1.alerts).some((t) => t.startsWith("Escrow governance event")));
    check("so the cursor stops at the last event returned, not at the latest ledger", kv.get(`watchdog:ledger:${CONTRACT}`) === String(base + EVENTS_PAGE_SIZE - 1), kv.get(`watchdog:ledger:${CONTRACT}`));
    const r2 = await runWatchdog(config, SPONSOR, WORKER);
    check("and the next run reads on from there and pages the governance event", has(r2.alerts, "Escrow governance event: paused"));
    check("then the cursor reaches the latest ledger", kv.get(`watchdog:ledger:${CONTRACT}`) === String(world.latest));
  }

  console.log("[27] the Worker's scheduled handler scans the sponsor ACCOUNT, not the signer key, and stamps the heartbeat");
  quiet();
  {
    const signer = Keypair.random();
    const account = Keypair.random().publicKey();
    const env: Record<string, string> = {
      STELLAR_NETWORK: "testnet",
      SPONSOR_SECRET: signer.secret(),
      SPONSOR_ACCOUNT_ID: account,
      USDC_ISSUER: USDC_ISSUERS.testnet,
      HORIZON_URL: "https://horizon.fake",
      SOROBAN_RPC_URL: "https://rpc.fake",
      LUMENDROP_CONTRACT: CONTRACT,
      LUMENDROP_WASM_HASH: WASM,
      KV_REST_API_URL: "https://fake-kv.test",
      KV_REST_API_TOKEN: "t",
    };
    Object.assign(process.env, env); // the handler copies its env once per isolate; this run may not be the first
    /* A key-compromise signature in the world: the ACCOUNT sourced a set_options an hour ago. The
       production halt rests on the literal `autoHalt: true` in scheduled(); without it this run
       would page and never halt, so the halt is asserted here, not only the stamps. */
    world.ops = [op("set_options", account, 500, HOUR)];
    const pending: Array<Promise<unknown>> = [];
    await worker.scheduled({}, env, { waitUntil: (p) => void pending.push(p) });
    await Promise.all(pending);
    check("the scheduled run HALTS on the account's own forbidden operation (it must pass autoHalt: true)", kv.get(haltKey("testnet")) === "1");
    check("and its scan moved past the operation once the halt landed", kv.get(`watchdog:ops:${account}`) === "500");
    check("it read the sponsor ACCOUNT on Horizon", horizonRequests.some((u) => u.includes(`/accounts/${account}`)), horizonRequests[0]);
    check("and its operations", horizonRequests.some((u) => u.includes(`/accounts/${account}/operations`)));
    check("never the signer's own address", !horizonRequests.some((u) => u.includes(signer.publicKey())));
    check(
      "the scheduled run wrote both heartbeat stamps (it must call runWatchdog with heartbeat: true)",
      !!kv.get(lastRunKey("testnet")) && !!kv.get(lastFullRunKey("testnet")),
    );
  }

  /* On the Workers Free plan a cron run gets 10 ms of CPU and 50 subrequests, and the run that finds
     a theft is the long one. The halt used to be written after every check, so a run cut off after
     its tripwire wrote nothing; it is now written the moment the tripwire is raised. */
  console.log("[28] a tripwire halts at once, before the run's remaining reads (a run cut off later keeps its halt)");
  const haltWrites = () => trace.map((t, i) => (t.startsWith("kv:pipeline") && t.includes(`SET ${haltKey("testnet")}`) ? i : -1)).filter((i) => i >= 0);
  const indexesOf = (label: string) => trace.map((t, i) => (t === label ? i : -1)).filter((i) => i >= 0);
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  kv.set(OPS_CURSOR, "0");
  world.ops = [op("set_options", SPONSOR, 1), ...Array.from({ length: 299 }, (_, i) => op("payment", stranger.publicKey(), i + 2))];
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    const writes = haltWrites();
    const pages = indexesOf("horizon:ops");
    const firstRpc = trace.findIndex((t) => t.startsWith("rpc:"));
    check("a forbidden operation on the first of several full pages halts the run", r.autoHalted && halted() && pages.length >= 3, `${pages.length} pages`);
    check(
      "the halt is written right after the page that raised it, BEFORE the next page is read",
      writes.length === 1 && writes[0]! > pages[0]! && writes[0]! < pages[1]!,
      `halt at ${writes.join(",")}, pages at ${pages.join(",")}`,
    );
    check("and before any other check reads anything: the halt was in the store when the first RPC read left", writes[0]! < firstRpc && haltedAtFirstRpc === true, `rpc at ${firstRpc}`);
    check("the scan still read on to the newest page and moved its cursor past the operation", kv.get(OPS_CURSOR) === "300", kv.get(OPS_CURSOR));
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  world.runningWasm = OTHER_WASM;
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    const writes = haltWrites();
    const instance = indexesOf("rpc:getLedgerEntries:instance");
    const code = trace.indexOf("rpc:getLedgerEntries:code");
    const fee = trace.findIndex((t) => t.startsWith("kv:get caps:testnet:fees:"));
    check(
      "a confirmed wasm change halts right after its confirming read, before the expiry check's code read and the fee read",
      r.autoHalted && writes.length === 1 && instance.length === 2 && writes[0]! > instance[1]! && writes[0]! < code && writes[0]! < fee,
      `halt at ${writes.join(",")}, instance ${instance.join(",")}, code ${code}, fee ${fee}`,
    );
  }
  bothTripwires();
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check(
      "two tripwires in one run: halted at the first, then the halt's reason rewritten to name both",
      r.autoHalted &&
        haltReasons.length === 2 &&
        /watchdog auto-halt: Sponsor SOURCED a forbidden operation$/.test(haltReasons[0]!) &&
        haltReasons[1]!.includes(TRIPWIRE_FORBIDDEN_OP) &&
        haltReasons[1]!.includes(TRIPWIRE_WASM_CHANGED),
      haltReasons.join(" | "),
    );
    check("the stored reason and the page name both", (kv.get(haltReasonKey("testnet")) ?? "").includes(TRIPWIRE_WASM_CHANGED) && detail(r.alerts, AUTO_HALT_TITLE).includes(TRIPWIRE_WASM_CHANGED));
  }
  quiet();
  process.env.LUMENDROP_WASM_HASH = WASM;
  mailOn();
  kv.set(OPS_CURSOR, "0");
  world.ops = [op("set_options", SPONSOR, 1), op("payment", SPONSOR, 2), ...Array.from({ length: 298 }, (_, i) => op("payment", stranger.publicKey(), i + 3))];
  world.pipelineSetFails = true;
  {
    const r = await runWatchdog(config, SPONSOR, WORKER);
    check(
      "a store that refuses the halt is asked ONCE per run, not again on every page (the next run retries)",
      haltWrites().length === 1 && !r.autoHalted && has(r.alerts, AUTO_HALT_FAILED_TITLE) && kv.get(OPS_CURSOR) === "0",
      `${haltWrites().length} writes, cursor ${kv.get(OPS_CURSOR)}`,
    );
  }

  console.log("\n============================================================");
  console.log(fail === 0 ? ` WATCHDOG OFFLINE TESTS PASS (${pass}/${pass})` : ` FAIL: ${fail} FAILURES (${pass} passed)`);
  console.log("============================================================");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("CRASH:", e);
  process.exit(1);
});
