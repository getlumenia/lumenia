/**
 * ============================================================================
 *  TEST: the NEAR rail's relayer (/near/relay, /near/health, /near/policy) and its practice
 *  links (/near/practice-link), offline
 * ============================================================================
 *
 *  Everything runs through `worker.fetch` with a fake Upstash store (an in-process pipeline
 *  interpreter behind a replaced global fetch, the shape every offline suite here uses) and a fake
 *  NEAR RPC behind the module's test seam (setNearRpcForTests). Delegates are built and signed with
 *  random keys by the same near-api-js the web client uses, so the bytes on the wire are real
 *  NEP-366 SignedDelegates. No network, no live keys. What it pins:
 *    - the three routes answer 503 near_not_configured without the NEAR variables or the secret,
 *      and off the testnet Worker;
 *    - the policy and health shapes;
 *    - every refusal class is a 403 with its code, logged once, with nothing sent and no cap touched;
 *    - a forged sender id (a key that is not on that account) burns none of that sender's caps;
 *    - the caps: cooldown, per-sender day, global day, each a 429 with retryAfterS and Retry-After,
 *      and the atomic record step under a lost race;
 *    - the allowed shapes relay as ONE signedDelegate action from the relayer's key and report the
 *      escrow's outcome, a refund included;
 *    - the kill switch halts /near/relay; a store that is down or slow refuses (fail closed); the
 *      in-process store serves only when no store is configured;
 *    - /near/practice-link: unconfigured, off-network, switched-off and keyless 503s; every body
 *      rule (400) refused offline with no store or RPC call; the one transaction it signs (the
 *      relayer's ft_transfer_call into the escrow, 1 yocto, 100 Tgas, the msg built from the
 *      public key only); the caps per caller address (cooldown, day, IPv6 /64) and in total, in
 *      their own namespace; an empty practice balance refused before any cap is spent; the store
 *      down (fail closed), the kill switch, a failed send; no log line carries the caller address.
 *
 *  RUN: pnpm --filter @lumenia/sponsor test:near-relay
 * ============================================================================
 */
import { readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import {
  KeyPair,
  KeyPairSigner,
  actions,
  base64Encode,
  buildDelegateAction,
  encodeSignedDelegate,
  teraToGas,
  type Action,
  type SignedDelegate,
  type SignedTransaction,
} from "near-api-js";
import { secondsToDayEnd } from "@lumenia/near/relayer/caps";
import { resetHaltCache } from "./lib/kill-switch.js";
import {
  DEFAULT_PRACTICE_CAPS,
  PRACTICE_MAX_MEMO_BYTES,
  parsePracticeRequest,
  armReturnTgas,
  practiceConfigFromEnv,
  practiceMsg,
} from "./lib/near-practice.js";
import {
  checkNearCaps,
  formatNear,
  minNearYocto,
  nearCapStoreFromEnv,
  nearConfigFromEnv,
  recordNearCap,
  resetNearMemoryStoreForTests,
  setNearPollMsForTests,
  setNearRpcForTests,
  type NearRpc,
} from "./lib/near-relay.js";
import { PRACTICE_SWEEP_CRON, SWEEP_MAX_KEYS, expiredOpenDrops, outcomeSucceeded, returnGroups, sweepExpiredLinks, sweepReturnTgas } from "./lib/near-practice-sweep.js";
import { resetServiceCache } from "./lib/service.js";
import { NEAR_RELAYER_LOW_TITLE, checkNearRelayer, type Alert } from "./lib/watchdog.js";
import worker, { resetNearHealthCache } from "./worker.js";

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${d ? `  (${d})` : ""}`);
  ok ? pass++ : fail++;
};

/* ------------------------------- the fixtures ------------------------------- */

const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const ESCROW = "lumenia-near.testnet";
const RELAYER = "lumenia-relayer.testnet";
const SENDER = "alice.testnet";
const HEIGHT = 277_000_000;
const RPC_URL = "https://near-rpc.fake";
const relayerKey = KeyPair.fromRandom("ed25519");

const linkKey = () => KeyPair.fromRandom("ed25519").getPublicKey().toString();
const linkMsg = (overrides: Record<string, unknown> = {}) => JSON.stringify({ public_key: linkKey(), expires_in_s: 86_400, memo: "coffee", ...overrides });

function ftTransferCall(o: { receiverId?: string; amount?: unknown; msg?: unknown; gasTgas?: number; deposit?: bigint; extra?: Record<string, unknown> } = {}): Action {
  const args = { receiver_id: o.receiverId ?? ESCROW, amount: o.amount ?? "100000", msg: o.msg ?? linkMsg(), ...(o.extra ?? {}) };
  return actions.functionCall("ft_transfer_call", args, teraToGas(o.gasTgas ?? 100), o.deposit ?? 1n);
}

function reclaimCall(o: { publicKey?: string; gasTgas?: number; deposit?: bigint; method?: string } = {}): Action {
  return actions.functionCall(o.method ?? "reclaim", { public_key: o.publicKey ?? linkKey() }, teraToGas(o.gasTgas ?? 100), o.deposit ?? 0n);
}

interface SignOpts {
  senderId?: string;
  receiverId?: string;
  actions?: Action[];
  nonce?: bigint;
  maxBlockHeight?: bigint;
  keyPair?: KeyPair;
}

/** A properly signed delegate (the signature verifies) with the given overrides. */
async function signDelegate(o: SignOpts = {}): Promise<{ signed: SignedDelegate; bytes: Uint8Array; base64: string; keyPair: KeyPair }> {
  const keyPair = o.keyPair ?? KeyPair.fromRandom("ed25519");
  const delegateAction = buildDelegateAction({
    senderId: o.senderId ?? SENDER,
    receiverId: o.receiverId ?? USDC,
    actions: o.actions ?? [ftTransferCall()],
    nonce: o.nonce ?? BigInt(HEIGHT) * 1_000_000n - 5n,
    maxBlockHeight: o.maxBlockHeight ?? BigInt(HEIGHT + 300),
    publicKey: keyPair.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(keyPair).signDelegateAction(delegateAction);
  const bytes = encodeSignedDelegate(signedDelegate);
  return { signed: signedDelegate, bytes, base64: base64Encode(bytes), keyPair };
}
const b64 = async (o: SignOpts = {}) => (await signDelegate(o)).base64;

/** A FINAL execution outcome as the RPC returns it: the escrow's receipt succeeds or fails as asked. */
function successResponse(o: { hash?: string; successValue?: string; logs?: string[]; receiptFailure?: string } = {}): unknown {
  const sv = o.successValue === undefined ? '"100000"' : o.successValue;
  return {
    final_execution_status: "FINAL",
    status: { SuccessValue: Buffer.from(sv).toString("base64") },
    transaction: { hash: o.hash ?? "7xdZ6gQd9XGVfqgXwW1nX4z3Jm9mUoCwZ5q5h6gZJd2a" },
    transaction_outcome: { id: "tx", outcome: { logs: [], status: { SuccessReceiptId: "r1" } } },
    receipts_outcome: [
      { id: "r1", outcome: { executor_id: SENDER, logs: [], status: { SuccessReceiptId: "r2" } } },
      {
        id: "r2",
        outcome: {
          executor_id: ESCROW,
          logs: o.logs ?? [],
          status: o.receiptFailure ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: o.receiptFailure } } } } } : { SuccessValue: "" },
        },
      },
    ],
  };
}

/* ------------------------------- the fake store ------------------------------- */

const kv = new Map<string, { value: string; expiresAt: number | null }>();
let storeMode: "ok" | "http500" | "throw" = "ok";
/** Every pipeline the Worker sent, for the suite to see what a request touched. */
const pipelines: string[][][] = [];

function kvLive(key: string): { value: string; expiresAt: number | null } | undefined {
  const item = kv.get(key);
  if (item && item.expiresAt !== null && item.expiresAt <= Date.now()) {
    kv.delete(key);
    return undefined;
  }
  return item;
}
const kvGet = (key: string): string | null => kvLive(key)?.value ?? null;
const kvSet = (key: string, value: string, ttlMs: number | null = null) => kv.set(key, { value, expiresAt: ttlMs === null ? null : Date.now() + ttlMs });

function runCmd(cmd: string[]): { result: unknown } | { error: string } {
  const [op0, key = "", ...args] = cmd;
  const op = String(op0).toUpperCase();
  switch (op) {
    case "GET":
      return { result: kvGet(key) };
    case "SET": {
      const value = String(args[0] ?? "");
      let nx = false;
      let ttlMs: number | null = null;
      for (let i = 1; i < args.length; i++) {
        const flag = String(args[i]).toUpperCase();
        if (flag === "NX") nx = true;
        else if (flag === "EX") ttlMs = Number(args[++i]) * 1000;
        else if (flag === "PX") ttlMs = Number(args[++i]);
        else return { error: `UNSUPPORTED SET flag ${flag}` };
      }
      if (nx && kvLive(key) !== undefined) return { result: null };
      kvSet(key, value, ttlMs);
      return { result: "OK" };
    }
    case "INCR":
    case "INCRBY":
    case "DECRBY": {
      const delta = op === "INCR" ? 1n : op === "INCRBY" ? BigInt(String(args[0])) : -BigInt(String(args[0]));
      const current = kvLive(key);
      const next = (current ? BigInt(current.value) : 0n) + delta;
      kv.set(key, { value: next.toString(), expiresAt: current?.expiresAt ?? null });
      return { result: Number(next) };
    }
    case "EXPIRE":
    case "PEXPIRE": {
      const current = kvLive(key);
      if (!current) return { result: 0 };
      current.expiresAt = Date.now() + Number(args[0]) * (op === "EXPIRE" ? 1000 : 1);
      return { result: 1 };
    }
    case "DEL": {
      const had = kvLive(key) !== undefined;
      kv.delete(key);
      return { result: had ? 1 : 0 };
    }
    default:
      return { error: `UNSUPPORTED ${op}` };
  }
}

/* -------------------------------- the fake RPC -------------------------------- */

type SendMode = "ok" | "timeout" | "invalid-nonce" | "throw";
interface Plan {
  height: number;
  blockError?: string;
  senderKey: { nonce: bigint; permission: unknown } | { error: string };
  relayerNonce: bigint;
  relayerAccount: bigint | { error: string };
  /** The relayer's USDC (the practice balance), in units. */
  relayerUsdc: bigint | { error: string };
  send: SendMode[];
  response: unknown;
  txStatus: unknown[];
  /** How the arm of a return timer (send until INCLUDED_FINAL) answers. */
  include: "ok" | "throw";
}
const plan: Plan = {
  height: HEIGHT,
  senderKey: { nonce: 41n, permission: "FullAccess" },
  relayerNonce: 7n,
  relayerAccount: 10n * 10n ** 24n,
  relayerUsdc: 100_000_000n,
  send: [],
  response: successResponse(),
  txStatus: [],
  include: "ok",
};
const rpcCalls: string[] = [];
const sent: SignedTransaction[] = [];
let rpcUrlSeen = "";

function fakeRpc(url: string): NearRpc {
  rpcUrlSeen = url;
  return {
    url,
    async viewBlock() {
      rpcCalls.push("block");
      if (plan.blockError) throw new Error(plan.blockError);
      return { height: plan.height, hash: "11111111111111111111111111111111" };
    },
    async viewAccessKey(accountId) {
      rpcCalls.push(`key:${accountId}`);
      if (accountId === RELAYER) return { nonce: plan.relayerNonce, permission: "FullAccess" };
      if ("error" in plan.senderKey) throw new Error(plan.senderKey.error);
      return plan.senderKey;
    },
    async viewAccount(accountId) {
      rpcCalls.push(`account:${accountId}`);
      if (typeof plan.relayerAccount === "object") throw new Error(plan.relayerAccount.error);
      return { amountYocto: plan.relayerAccount };
    },
    async sendUntilFinal(signed) {
      rpcCalls.push("send");
      sent.push(signed);
      const mode = plan.send.shift() ?? "ok";
      if (mode === "timeout") throw new Error("Timeout error: the transaction was not finalized in time");
      if (mode === "invalid-nonce") throw new Error("InvalidNonce: Transaction nonce 8 must be larger than nonce of the used access key 8");
      if (mode === "throw") throw new Error("RPC unreachable (fetch failed)");
      return plan.response;
    },
    async txStatus() {
      rpcCalls.push("status");
      if (plan.txStatus.length === 0) throw new Error("tx not found yet");
      return plan.txStatus.shift();
    },
    async sendUntilIncluded(signed) {
      rpcCalls.push("include");
      sent.push(signed);
      if (plan.include === "throw") throw new Error("RPC unreachable (fetch failed)");
      return { final_execution_status: "INCLUDED_FINAL" };
    },
    async viewFtBalance(tokenId, accountId) {
      rpcCalls.push(`ftbalance:${tokenId === USDC ? "usdc" : tokenId}:${accountId}`);
      if (typeof plan.relayerUsdc === "object") throw new Error(plan.relayerUsdc.error);
      return plan.relayerUsdc;
    },
  };
}

/* ------------------------------- the fake fetch ------------------------------- */

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith("https://fake-kv.test/")) {
    if (storeMode === "throw") throw new TypeError("fetch failed: ECONNREFUSED");
    if (storeMode === "http500") return new Response("upstream error", { status: 500 });
    const path = new URL(url).pathname;
    if (path !== "/pipeline") return new Response(JSON.stringify({ error: `fake kv: unexpected path ${path}` }), { status: 404 });
    const cmds = JSON.parse(String(init?.body ?? "[]")) as string[][];
    pipelines.push(cmds);
    return new Response(JSON.stringify(cmds.map((c) => runCmd(c.map(String)))), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url === RPC_URL) {
    // The watchdog's own JSON-RPC read (lib/watchdog.ts rpcCall), used by the [watchdog] section.
    const req = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: { account_id?: string } };
    if (req.method !== "query") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: `unknown method ${req.method}` } }), { status: 200 });
    if (typeof plan.relayerAccount === "object") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", message: plan.relayerAccount.error } }), { status: 200 });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { amount: plan.relayerAccount.toString(), locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182 } }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

/* ------------------------------- the log capture ------------------------------- */

const decisions: Array<Record<string, unknown>> = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.startsWith("{")) {
    try {
      const parsed = JSON.parse(first) as Record<string, unknown>;
      if (parsed.route === "near/relay" || parsed.route === "near/practice-link") {
        decisions.push(parsed);
        return;
      }
    } catch {
      /* not one of ours */
    }
  }
  realLog(...args);
};
const lastDecision = () => decisions[decisions.length - 1] ?? {};

/* ------------------------------- the Worker env ------------------------------- */

const ENV: Record<string, string> = {
  STELLAR_NETWORK: "testnet",
  SPONSOR_SECRET: Keypair.random().secret(),
  USDC_ISSUER: Keypair.random().publicKey(),
  ALLOWED_ORIGIN: "https://getlumenia.com",
  KV_REST_API_URL: "https://fake-kv.test",
  KV_REST_API_TOKEN: "t",
  // Generous limiter windows: this suite makes far more than 30 relay attempts from one address.
  RATE_CAP: "1000",
  ACCOUNT_RATE_CAP: "1000",
  NEAR_NETWORK: "testnet",
  NEAR_RPC_URL: RPC_URL,
  NEAR_ESCROW_ID: ESCROW,
  NEAR_USDC_ID: USDC,
  NEAR_RELAYER_ACCOUNT_ID: RELAYER,
  NEAR_RELAYER_PRIVATE_KEY: relayerKey.toString(),
  NEAR_RELAY_PER_SENDER_PER_DAY: "20",
  NEAR_RELAY_PER_DAY: "500",
  NEAR_RELAY_COOLDOWN_S: "10",
  NEAR_RELAYER_MIN_NEAR: "1",
};
for (const [k, v] of Object.entries(ENV)) process.env[k] = v;

const call = async (path: string, init: { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) => {
  const method = init.method ?? (init.body !== undefined || init.rawBody !== undefined ? "POST" : "GET");
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  const res = await worker.fetch(
    new Request(`https://sponsor.test${path}`, { method, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, ...(body !== undefined ? { body } : {}) }),
    ENV,
  );
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json, headers: res.headers };
};
const relay = (signedDelegate: string, headers?: Record<string, string>) => call("/near/relay", { body: { signedDelegate }, headers });

/** Fresh fakes for a section: store empty, RPC plan at its defaults, caches forgotten. */
function fresh(): void {
  kv.clear();
  pipelines.length = 0;
  rpcCalls.length = 0;
  sent.length = 0;
  decisions.length = 0;
  storeMode = "ok";
  plan.height = HEIGHT;
  plan.blockError = undefined;
  plan.senderKey = { nonce: 41n, permission: "FullAccess" };
  plan.relayerNonce = 7n;
  plan.relayerAccount = 10n * 10n ** 24n;
  plan.relayerUsdc = 100_000_000n;
  plan.send = [];
  plan.response = successResponse();
  plan.txStatus = [];
  plan.include = "ok";
  resetHaltCache();
  resetNearHealthCache();
  setNearRpcForTests(fakeRpc);
}

const nearKeys = () => [...kv.keys()].filter((k) => k.startsWith("near:"));

/* =============================================================================== */

async function main(): Promise<void> {
  setNearPollMsForTests(1);
  setNearRpcForTests(fakeRpc);
  // The Worker hydrates process.env from its env object on its FIRST request and never again; every
  // section below edits process.env by hand, so that first request happens here.
  await call("/near/policy");

  console.log("[config] nearConfigFromEnv");
  {
    const empty = nearConfigFromEnv({});
    check("no NEAR variables: not configured, and the reason names them", !empty.configured && /NEAR_NETWORK.*NEAR_ESCROW_ID.*NEAR_USDC_ID.*NEAR_RELAYER_ACCOUNT_ID/.test(empty.configured ? "" : empty.reason), empty.configured ? "" : empty.reason);
    const main = nearConfigFromEnv({ ...ENV, NEAR_NETWORK: "mainnet" });
    check("NEAR_NETWORK=mainnet is refused: testnet only", !main.configured && /testnet only/.test(main.configured ? "" : main.reason));
    const defaults = nearConfigFromEnv({ NEAR_NETWORK: "testnet", NEAR_ESCROW_ID: ESCROW, NEAR_USDC_ID: USDC, NEAR_RELAYER_ACCOUNT_ID: RELAYER });
    check(
      "defaults: fastnear testnet RPC, caps 20/500/10, floor 1 NEAR, no secret",
      defaults.configured &&
        defaults.config.rpcUrl === "https://test.rpc.fastnear.com" &&
        defaults.config.caps.perSenderPerDay === 20 &&
        defaults.config.caps.globalPerDay === 500 &&
        defaults.config.caps.senderCooldownS === 10 &&
        defaults.config.minNear === 1 &&
        defaults.secret === null,
    );
    const full = nearConfigFromEnv(ENV);
    check("the suite's env: configured with the secret and the caps it names", full.configured && full.secret === relayerKey.toString() && full.config.caps.senderCooldownS === 10 && full.config.rpcUrl === RPC_URL);
    const badInt = nearConfigFromEnv({ ...ENV, NEAR_RELAY_PER_DAY: "many" });
    check("a cap that is not an integer is a configuration error, not a default", !badInt.configured && /NEAR_RELAY_PER_DAY/.test(badInt.configured ? "" : badInt.reason));
    const same = nearConfigFromEnv({ ...ENV, NEAR_USDC_ID: ESCROW });
    check("escrow == usdc is refused", !same.configured && /must differ/.test(same.configured ? "" : same.reason));
    const badId = nearConfigFromEnv({ ...ENV, NEAR_RELAYER_ACCOUNT_ID: "Not..Valid" });
    check("an invalid account id is refused", !badId.configured && /NEAR_RELAYER_ACCOUNT_ID/.test(badId.configured ? "" : badId.reason));
    check("formatNear: whole, truncated to four places, dust", formatNear(10n * 10n ** 24n) === "10" && formatNear(9_999_719_046_291_544_099_999_999n) === "9.9997" && formatNear(1n) === "0");
    check("minNearYocto: 1 NEAR and half a NEAR", minNearYocto(1) === 10n ** 24n && minNearYocto(0.5) === 5n * 10n ** 23n);
  }

  console.log("\n[unconfigured] the three routes without the NEAR rail");
  {
    fresh();
    const saved = process.env.NEAR_ESCROW_ID;
    delete process.env.NEAR_ESCROW_ID;
    const [h, p, r] = await Promise.all([call("/near/health"), call("/near/policy"), relay("QUJD")]);
    check("GET /near/health is 503 near_not_configured", h.status === 503 && h.json.error === "near_not_configured" && /NEAR_ESCROW_ID/.test(String(h.json.reason)), JSON.stringify(h.json));
    check("GET /near/policy is 503 near_not_configured", p.status === 503 && p.json.error === "near_not_configured");
    check("POST /near/relay is 503 near_not_configured", r.status === 503 && r.json.error === "near_not_configured");
    check("...and nothing reached the RPC or the store", rpcCalls.length === 0 && nearKeys().length === 0);
    process.env.NEAR_ESCROW_ID = saved;
    // The secret alone missing: health says so, relay refuses, policy still answers.
    const savedKey = process.env.NEAR_RELAYER_PRIVATE_KEY;
    delete process.env.NEAR_RELAYER_PRIVATE_KEY;
    resetNearHealthCache();
    const noKey = await relay(await b64());
    check("without the secret, /near/relay is 503 near_not_configured naming NEAR_RELAYER_PRIVATE_KEY", noKey.status === 503 && noKey.json.error === "near_not_configured" && /NEAR_RELAYER_PRIVATE_KEY/.test(String(noKey.json.reason)));
    const hk = await call("/near/health");
    const relayer = hk.json.relayer as Record<string, unknown>;
    check("...and /near/health is 503 ok:false, signerConfigured:false, with the warning", hk.status === 503 && hk.json.ok === false && relayer.signerConfigured === false && relayer.publicKey === null && (hk.json.warnings as string[]).some((w) => /NEAR_RELAYER_PRIVATE_KEY/.test(w)), JSON.stringify(hk.json.warnings));
    check("...while /near/policy still answers 200", (await call("/near/policy")).status === 200);
    process.env.NEAR_RELAYER_PRIVATE_KEY = savedKey;
    // Off the testnet Worker the routes refuse whatever the NEAR variables say.
    process.env.STELLAR_NETWORK = "mainnet";
    resetServiceCache();
    const onMainnet = await call("/near/policy");
    check("on the mainnet Worker, /near/* is 503 near_not_configured even with the NEAR variables set", onMainnet.status === 503 && /testnet Worker only/.test(String(onMainnet.json.reason)), JSON.stringify(onMainnet.json));
    process.env.STELLAR_NETWORK = "testnet";
    resetServiceCache();
  }

  console.log("\n[policy] GET /near/policy");
  {
    fresh();
    const p = await call("/near/policy");
    const rules = p.json.rules as { allowed: Array<{ name: string; receiver_id: string; method: string; deposit_yocto: string; max_gas_tgas: number; args: Record<string, string> }>; delegate: Record<string, unknown> };
    const words = (p.json.words as string[]).join(" ");
    check("200 with the words and the rules", p.status === 200 && Array.isArray(p.json.words) && rules.allowed.length === 2);
    check("allowed 1: ft_transfer_call on the USDC contract, 1 yocto, 100 Tgas, args.receiver_id the escrow", rules.allowed[0]?.receiver_id === USDC && rules.allowed[0]?.method === "ft_transfer_call" && rules.allowed[0]?.deposit_yocto === "1" && rules.allowed[0]?.max_gas_tgas === 100 && rules.allowed[0]?.args.receiver_id === ESCROW);
    check("allowed 2: reclaim on the escrow, no deposit", rules.allowed[1]?.receiver_id === ESCROW && rules.allowed[1]?.method === "reclaim" && rules.allowed[1]?.deposit_yocto === "0");
    check("the words name the escrow, the USDC contract, 1 yoctoNEAR and reclaim", words.includes(ESCROW) && words.includes(USDC) && words.includes("1 yoctoNEAR") && words.includes("reclaim"));
    check("one action, no nesting, 600 blocks, signature checked offline", rules.delegate.max_actions === 1 && rules.delegate.nested_delegate === false && rules.delegate.max_block_height_window_blocks === 600 && rules.delegate.signature_checked_offline === true);
    check("POST /near/policy is 405", (await call("/near/policy", { method: "POST", body: {} })).status === 405);
    check("GET /near/relay is 405", (await call("/near/relay")).status === 405);
    const pre = await worker.fetch(new Request("https://sponsor.test/near/relay", { method: "OPTIONS" }), ENV);
    check("OPTIONS /near/relay is the Worker's CORS preflight (204, allow-origin set)", pre.status === 204 && pre.headers.get("access-control-allow-origin") === "https://getlumenia.com");
  }

  console.log("\n[health] GET /near/health");
  {
    fresh();
    kvSet(`near:testnet:day:${new Date().toISOString().slice(0, 10)}:global`, "3");
    const h = await call("/near/health");
    const relayer = h.json.relayer as Record<string, unknown>;
    const caps = h.json.caps as Record<string, unknown>;
    check("200 ok:true on a healthy rail", h.status === 200 && h.json.ok === true, JSON.stringify(h.json.warnings));
    check("network, rpcUrl, block height", h.json.network === "testnet" && h.json.rpcUrl === RPC_URL && h.json.blockHeight === HEIGHT);
    check("the relayer: account id, the key derived from the secret, the live balance", relayer.accountId === RELAYER && relayer.publicKey === relayerKey.getPublicKey().toString() && relayer.balanceNear === "10" && relayer.balanceYocto === (10n * 10n ** 24n).toString() && relayer.signerConfigured === true);
    check("the secret itself appears nowhere in the report", !JSON.stringify(h.json).includes(relayerKey.toString()));
    check("escrow, usdc, storage upstash", h.json.escrowId === ESCROW && h.json.usdcId === USDC && h.json.storage === "upstash");
    check("caps: today's count, the limits, the reset", caps.globalToday === 3 && JSON.stringify(caps.limits) === JSON.stringify({ perSenderPerDay: 20, globalPerDay: 500, senderCooldownS: 10 }) && Number(caps.resetsInS) > 0 && Number(caps.resetsInS) <= 86_400);
    check("the policy words and the sponsor's halt verdict ride along", Array.isArray(h.json.policy) && (h.json.halt as Record<string, unknown>).halted === false);
    const rpcBefore = rpcCalls.length;
    await call("/near/health");
    check("a second read inside 5 s is served from the isolate's cache: no RPC call", rpcCalls.length === rpcBefore);
    resetNearHealthCache();
    plan.relayerAccount = 5n * 10n ** 23n;
    const low = await call("/near/health");
    check("a balance under NEAR_RELAYER_MIN_NEAR is a warning and 503", low.status === 503 && low.json.ok === false && (low.json.warnings as string[]).some((w) => /below the 1 NEAR floor/.test(w)), JSON.stringify(low.json.warnings));
    resetNearHealthCache();
    plan.relayerAccount = 10n * 10n ** 24n;
    plan.blockError = "fetch failed";
    const noRpc = await call("/near/health");
    check("an RPC that does not answer is a warning naming it, with the balance it could not read", noRpc.status === 503 && noRpc.json.blockHeight === null && (noRpc.json.warnings as string[]).some((w) => w.includes(RPC_URL)));
    resetNearHealthCache();
    plan.blockError = undefined;
    storeMode = "http500";
    const noStore = await call("/near/health");
    check("a store that is down is a warning, caps null, 503", noStore.status === 503 && noStore.json.caps === null && (noStore.json.warnings as string[]).some((w) => /cap store/.test(w)));
    storeMode = "ok";
  }

  console.log("\n[400] bodies that are not a relay request");
  {
    fresh();
    check("a body that is not JSON is 400", (await call("/near/relay", { rawBody: "{not json" })).status === 400);
    check("a JSON body without signedDelegate is 400 bad_request", (await call("/near/relay", { body: { nope: 1 } })).json.code === "bad_request");
    check("an empty signedDelegate is 400", (await relay("")).status === 400);
    const garbage = await relay("QUJD");
    check("bytes that are not a borsh SignedDelegate are 400 undecodable", garbage.status === 400 && garbage.json.code === "undecodable", JSON.stringify(garbage.json));
    const { bytes } = await signDelegate();
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    const trailing = await relay(base64Encode(longer));
    check("a delegate with a trailing byte is 400 undecodable (canonical borsh only)", trailing.status === 400 && trailing.json.code === "undecodable");
    check("a signed_delegate spelling is accepted too (it reaches the policy, not 400)", (await call("/near/relay", { body: { signed_delegate: (await signDelegate({ receiverId: "other.testnet" })).base64 } })).status === 403);
    check("none of those reached the RPC or wrote a cap", !rpcCalls.includes("send") && nearKeys().length === 0);
    check("each refusal was logged once, as a decision", decisions.filter((d) => d.decision === "refused").length >= 3 && decisions.every((d) => d.route === "near/relay"));
  }

  console.log("\n[403] every refusal class, through the route: a code, one log line, nothing sent, no cap");
  {
    fresh();
    const cases: Array<{ name: string; code: string; body: () => Promise<string>; reason?: RegExp }> = [
      { name: "wrong receiver", code: "receiver", body: () => b64({ receiverId: "other-token.testnet" }), reason: /neither/ },
      { name: "wrong method on the USDC contract (ft_transfer)", code: "method", body: () => b64({ actions: [actions.functionCall("ft_transfer", { receiver_id: "bob.testnet", amount: "1" }, teraToGas(10), 1n)] }), reason: /ft_transfer_call/ },
      { name: "deposit 2 yocto", code: "deposit", body: () => b64({ actions: [ftTransferCall({ deposit: 2n })] }), reason: /exactly 1 yoctoNEAR, got 2/ },
      { name: "gas 150 Tgas", code: "gas", body: () => b64({ actions: [ftTransferCall({ gasTgas: 150 })] }), reason: /150 Tgas/ },
      { name: "two actions", code: "actions", body: () => b64({ actions: [ftTransferCall(), ftTransferCall()] }), reason: /got 2/ },
      { name: "args.receiver_id elsewhere", code: "receiver", body: () => b64({ actions: [ftTransferCall({ receiverId: "mallory.testnet" })] }), reason: /receiver_id must be the escrow/ },
      { name: "unparseable msg", code: "msg", body: () => b64({ actions: [ftTransferCall({ msg: "{not json" })] }), reason: /not JSON/ },
      { name: "msg with an unknown field", code: "msg", body: () => b64({ actions: [ftTransferCall({ msg: linkMsg({ to: "x" }) })] }), reason: /unknown fields/ },
      { name: "reclaim with a deposit", code: "deposit", body: () => b64({ receiverId: ESCROW, actions: [reclaimCall({ deposit: 1n })] }), reason: /no deposit/ },
      { name: "another escrow method (claim)", code: "method", body: () => b64({ receiverId: ESCROW, actions: [reclaimCall({ method: "claim" })] }), reason: /only reclaim/ },
      { name: "expired max_block_height", code: "expiry", body: () => b64({ maxBlockHeight: BigInt(HEIGHT) }), reason: /expired/ },
      { name: "max_block_height more than 600 blocks ahead", code: "expiry", body: () => b64({ maxBlockHeight: BigInt(HEIGHT + 601) }), reason: /more than 600 blocks/ },
      { name: "a Transfer action", code: "action_type", body: () => b64({ actions: [actions.transfer(1n)] }), reason: /only FunctionCall/ },
      { name: "an invalid sender id", code: "sender", body: () => b64({ senderId: "Alice..testnet" }) },
      { name: "a zero amount", code: "args", body: () => b64({ actions: [ftTransferCall({ amount: "0" })] }), reason: /positive integer/ },
    ];
    for (const c of cases) {
      const before = decisions.length;
      const r = await relay(await c.body());
      const d = lastDecision();
      check(
        `${c.name}: 403 ${c.code}`,
        r.status === 403 && r.json.code === c.code && typeof r.json.reason === "string" && (c.reason ? c.reason.test(String(r.json.reason)) : true) && r.json.error === r.json.reason,
        `${r.status} ${JSON.stringify(r.json)}`,
      );
      check(`${c.name}: one refused log line with the code`, decisions.length === before + 1 && d.decision === "refused" && d.code === c.code, JSON.stringify(d));
    }
    // Tampered after signing: the sender id changed, the signature no longer matches.
    const tampered = await signDelegate();
    tampered.signed.delegateAction.senderId = "mallory.testnet";
    const sig = await relay(base64Encode(encodeSignedDelegate(tampered.signed)));
    check("a tampered delegate (sender changed after signing): 403 signature", sig.status === 403 && sig.json.code === "signature");
    const other = await signDelegate();
    const swapped = await signDelegate();
    swapped.signed.signature = other.signed.signature;
    const swap = await relay(base64Encode(encodeSignedDelegate(swapped.signed)));
    check("a signature made by another key: 403 signature", swap.status === 403 && swap.json.code === "signature");
    check("the signature refusals happened offline, before any store or RPC call of their own", !rpcCalls.includes("send") && !rpcCalls.some((c) => c.startsWith("key:")));
    check("nothing was sent and no cap key was written by any refusal", sent.length === 0 && nearKeys().length === 0);
    check("no log line carries a delegate's bytes or the relayer's secret", decisions.every((d) => !JSON.stringify(d).includes(relayerKey.toString()) && !JSON.stringify(d).includes(tampered.base64)));
  }

  console.log("\n[pre-check] the one RPC read before the relayer pays");
  {
    fresh();
    plan.senderKey = { error: "access key ed25519:x does not exist while viewing" };
    const forged = await relay(await b64({ senderId: "victim.testnet" }));
    check("a key that is not on the sender's account: 403 key", forged.status === 403 && forged.json.code === "key" && /victim\.testnet/.test(String(forged.json.reason)));
    check("FORGED SENDER: no cap was recorded and no cooldown set for victim.testnet", nearKeys().length === 0, nearKeys().join(","));
    check("...and the caps were read before the pre-check (the order the header promises)", pipelines.some((p) => p.some((c) => c[0] === "GET" && String(c[1]).startsWith("near:testnet:cool:victim.testnet"))));
    plan.senderKey = { nonce: BigInt(HEIGHT) * 1_000_000n, permission: "FullAccess" };
    const stale = await relay(await b64());
    check("a nonce at or below the key's current nonce: 403 nonce", stale.status === 403 && stale.json.code === "nonce" && /sign a fresh delegate/.test(String(stale.json.reason)));
    plan.senderKey = { nonce: 41n, permission: { FunctionCall: { receiver_id: USDC, method_names: ["ft_transfer_call"], allowance: null } } };
    const fck = await relay(await b64());
    check("a function-call key asked to carry a deposit: 403 key", fck.status === 403 && fck.json.code === "key" && /full-access key/.test(String(fck.json.reason)));
    plan.senderKey = { nonce: 41n, permission: { FunctionCall: { receiver_id: ESCROW, method_names: ["claim"], allowance: null } } };
    const wrongList = await relay(await b64({ receiverId: ESCROW, actions: [reclaimCall()] }));
    check("a function-call key whose method list lacks reclaim: 403 key", wrongList.status === 403 && wrongList.json.code === "key" && /may not call reclaim/.test(String(wrongList.json.reason)));
    plan.senderKey = { nonce: 41n, permission: { FunctionCall: { receiver_id: ESCROW, method_names: ["reclaim"], allowance: null } } };
    plan.response = successResponse({ successValue: "true" });
    const okList = await relay(await b64({ receiverId: ESCROW, actions: [reclaimCall()] }));
    check("a function-call key limited to the escrow's reclaim is accepted (no deposit)", okList.status === 200 && (okList.json.outcome as Record<string, unknown>).kind === "reclaim", JSON.stringify(okList.json));
    plan.senderKey = { error: "fetch failed" };
    const rpcDown = await relay(await b64({ senderId: "rory.testnet" }));
    check("an RPC that fails the pre-check: 502 rpc, nothing sent", rpcDown.status === 502 && rpcDown.json.code === "rpc" && sent.length === 1, JSON.stringify(rpcDown.json));
    plan.senderKey = { nonce: 41n, permission: "FullAccess" };
    plan.blockError = "connect ECONNREFUSED";
    setNearRpcForTests(fakeRpc); // forget the cached height
    const noHeight = await relay(await b64());
    check("an RPC that cannot give the block height: 502 rpc before the policy", noHeight.status === 502 && noHeight.json.code === "rpc" && /could not be reached/.test(String(noHeight.json.reason)));
  }

  console.log("\n[200] the allowed shapes relay as one signedDelegate action from the relayer's key");
  {
    fresh();
    plan.response = successResponse({ logs: ['EVENT_JSON:{"standard":"lumenia_drop","version":"1.0.0","event":"drop_created","data":[{"amount":"100000"}]}'] });
    const { base64, keyPair } = await signDelegate();
    const r = await relay(base64);
    const outcome = r.json.outcome as Record<string, unknown>;
    check("200 with txHash, explorerUrl and the outcome", r.status === 200 && typeof r.json.txHash === "string" && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(String(r.json.txHash)) && r.json.explorerUrl === `https://testnet.nearblocks.io/txns/${r.json.txHash}`, JSON.stringify(r.json));
    check("outcome: success, create_link, the link created, the amount the escrow kept, the event", outcome.status === "success" && outcome.kind === "create_link" && outcome.linkCreated === true && outcome.usedAmount === "100000" && (outcome.events as unknown[]).length === 1);
    const tx = sent[0]?.transaction;
    check("ONE transaction, signed by the relayer's key, addressed to the delegate's sender", sent.length === 1 && tx?.signerId === RELAYER && tx?.receiverId === SENDER && tx?.publicKey.toString() === relayerKey.getPublicKey().toString());
    check("with exactly one action, a signedDelegate, and the relayer's next nonce", tx?.actions.length === 1 && Boolean(tx?.actions[0]?.signedDelegate) && BigInt(String(tx?.nonce)) === 8n);
    check("the delegate inside is byte for byte what the sender signed", Buffer.from(encodeSignedDelegate(tx!.actions[0]!.signedDelegate as unknown as SignedDelegate)).equals(Buffer.from(encodeSignedDelegate((await signDelegate({ keyPair })).signed))) === false && Buffer.from(encodeSignedDelegate(tx!.actions[0]!.signedDelegate as unknown as SignedDelegate)).toString("base64") === base64);
    const day = new Date().toISOString().slice(0, 10);
    check("the caps were recorded: sender 1, global 1, cooldown stamped", kvGet(`near:testnet:day:${day}:sender:${SENDER}`) === "1" && kvGet(`near:testnet:day:${day}:global`) === "1" && kvGet(`near:testnet:cool:${SENDER}`) !== null);
    const d = lastDecision();
    check("one allowed log line with sender, method, receiver, kind, txHash, status and ms", d.decision === "allowed" && d.sender === SENDER && d.method === "ft_transfer_call" && d.receiver === USDC && d.kind === "create_link" && d.txHash === r.json.txHash && d.status === "success" && typeof d.ms === "number", JSON.stringify(d));
    check("the RPC was asked in order: height, the sender's key, the relayer's key and block, the send", rpcCalls.join(",") === `block,key:${SENDER},key:${RELAYER},block,send`, rpcCalls.join(","));

    // The escrow refuses the transfer: the token contract refunds, and the client must not read a link.
    plan.response = successResponse({ successValue: '"0"', receiptFailure: "Smart contract panicked: invalid msg: expected a link message" });
    const refund = await relay(await b64({ senderId: "bob.testnet" }));
    const ro = refund.json.outcome as Record<string, unknown>;
    check("an escrow refusal is 200 with outcome.status failure, the receipt's reason surfaced, the hash kept", refund.status === 200 && ro.status === "failure" && ro.linkCreated === false && ro.usedAmount === "0" && String((ro.failures as string[])[0]).includes("invalid msg") && typeof refund.json.txHash === "string");
    check("...and its log line says failure with the summary", lastDecision().status === "failure" && /escrow/.test(String(lastDecision().reason)));

    // A reclaim by a funder with no NEAR.
    plan.response = successResponse({ successValue: "true" });
    const key = linkKey();
    const back = await relay(await b64({ senderId: "funder.testnet", receiverId: ESCROW, actions: [reclaimCall({ publicKey: key })] }));
    const bo = back.json.outcome as Record<string, unknown>;
    check("a reclaim relays and reports reclaimed, naming the link key", back.status === 200 && bo.kind === "reclaim" && bo.reclaimed === true && String(bo.summary).includes(key));

    // The batch shape passes the policy and relays too.
    const msg = JSON.stringify({ drops: [linkKey(), { public_key: linkKey(), amount: "50000" }], expires_in_s: 3600 });
    plan.response = successResponse({ successValue: '"150000"' });
    const batch = await relay(await b64({ senderId: "carol.testnet", actions: [ftTransferCall({ amount: "150000", msg })] }));
    check("the batch msg shape relays (two keys)", batch.status === 200 && /2 key\(s\)/.test(String((batch.json.outcome as Record<string, unknown>).summary)), JSON.stringify(batch.json.outcome));
  }

  console.log("\n[429] the caps and the limiter");
  {
    fresh();
    const keyPair = KeyPair.fromRandom("ed25519");
    const first = await relay(await b64({ keyPair, nonce: 42n }));
    check("the first relay of a sender passes", first.status === 200);
    const second = await relay(await b64({ keyPair, nonce: 43n }));
    check("a second one inside 10 s: 429 cooldown with retryAfterS and Retry-After", second.status === 429 && second.json.code === "cooldown" && Number(second.json.retryAfterS) >= 1 && Number(second.json.retryAfterS) <= 10 && second.headers.get("retry-after") === String(second.json.retryAfterS), JSON.stringify(second.json));
    check("...logged as refused cooldown, nothing sent", lastDecision().code === "cooldown" && sent.length === 1);
    const otherSender = await relay(await b64({ senderId: "bob.testnet" }));
    check("another sender passes meanwhile", otherSender.status === 200);
    kvSet(`near:testnet:cool:${SENDER}`, String(Date.now() - 11_000), 60_000);
    const later = await relay(await b64({ keyPair, nonce: 44n }));
    check("11 s later the same sender passes again", later.status === 200, JSON.stringify(later.json));
    const day = new Date().toISOString().slice(0, 10);
    kvSet(`near:testnet:day:${day}:sender:carol.testnet`, "20");
    const daily = await relay(await b64({ senderId: "carol.testnet" }));
    const toDayEnd = secondsToDayEnd(Date.now());
    check("20 relays today: 429 sender_daily, retryAfterS to UTC midnight", daily.status === 429 && daily.json.code === "sender_daily" && Math.abs(Number(daily.json.retryAfterS) - toDayEnd) <= 2, JSON.stringify(daily.json));
    check("...and the count did not move", kvGet(`near:testnet:day:${day}:sender:carol.testnet`) === "20");
    kvSet(`near:testnet:day:${day}:global`, "500");
    const global = await relay(await b64({ senderId: "dave.testnet" }));
    check("500 relays today in total: 429 global_daily", global.status === 429 && global.json.code === "global_daily" && /500 relays/.test(String(global.json.reason)));
    kv.delete(`near:testnet:day:${day}:global`);
    // The Worker's own limiter, per signing key, in its own bucket, before any RPC call.
    process.env.ACCOUNT_RATE_CAP = "1";
    const k2 = KeyPair.fromRandom("ed25519");
    rpcCalls.length = 0;
    await relay(await b64({ senderId: "erin.testnet", keyPair: k2, nonce: 42n }));
    const limited = await relay(await b64({ senderId: "erin.testnet", keyPair: k2, nonce: 43n }));
    check("the per-key limiter: 429 rate_limited on the second request of one key, before any RPC call of its own", limited.status === 429 && limited.json.code === "rate_limited" && rpcCalls.filter((c) => c === "block").length <= 1, JSON.stringify(limited.json));
    process.env.ACCOUNT_RATE_CAP = "1000";
  }

  console.log("\n[caps] the record step is atomic: a lost race is given back and refused");
  {
    const savedUrl = process.env.KV_REST_API_URL;
    const savedToken = process.env.KV_REST_API_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    resetNearMemoryStoreForTests();
    const store = nearCapStoreFromEnv();
    const limits = { perSenderPerDay: 1, globalPerDay: 10, senderCooldownS: 0 };
    const now = Date.now();
    check("the in-process store answers when no store is configured", store.kind === "memory");
    check("check: a fresh sender passes", (await checkNearCaps(store, limits, "testnet", "x.testnet", now)).ok);
    check("record: the first passes", (await recordNearCap(store, limits, "testnet", "x.testnet", now)).ok);
    const second = await recordNearCap(store, limits, "testnet", "x.testnet", now);
    check("record: the second (the race the read-only check could not see) is refused sender_daily", !second.ok && second.code === "sender_daily");
    const [sender, global] = await store.pipeline([["GET", `near:testnet:day:${new Date(now).toISOString().slice(0, 10)}:sender:x.testnet`], ["GET", `near:testnet:day:${new Date(now).toISOString().slice(0, 10)}:global`]]);
    check("...and both counts were given back (sender 1, global 1)", sender === "1" && global === "1", `${sender} ${global}`);
    const cool = { perSenderPerDay: 10, globalPerDay: 10, senderCooldownS: 10 };
    check("record with a cooldown: the first sets it", (await recordNearCap(store, cool, "testnet", "y.testnet", now)).ok);
    const raced = await recordNearCap(store, cool, "testnet", "y.testnet", now);
    check("a second record in the same instant loses the SET NX and is refused cooldown", !raced.ok && raced.code === "cooldown" && raced.retryAfterS >= 1);
    const [ySender] = await store.pipeline([["GET", `near:testnet:day:${new Date(now).toISOString().slice(0, 10)}:sender:y.testnet`]]);
    check("...with its count given back and the first's cooldown kept", ySender === "1" && (await store.pipeline([["GET", "near:testnet:cool:y.testnet"]]))[0] === String(now));
    const g = { perSenderPerDay: 10, globalPerDay: 2, senderCooldownS: 0 };
    await recordNearCap(store, g, "testnet", "p.testnet", now);
    await recordNearCap(store, g, "testnet", "q.testnet", now);
    const third = await recordNearCap(store, g, "testnet", "r.testnet", now);
    check("the global cap holds under the same rule", !third.ok && third.code === "global_daily");
    process.env.KV_REST_API_URL = savedUrl;
    process.env.KV_REST_API_TOKEN = savedToken;
  }

  console.log("\n[halt] the kill switch");
  {
    fresh();
    kvSet("sponsor:halt:testnet", "1");
    resetHaltCache();
    const halted = await relay(await b64());
    check("under the sponsor halt, /near/relay is 503 'sponsor temporarily halted'", halted.status === 503 && halted.json.error === "sponsor temporarily halted" && sent.length === 0);
    const h = await call("/near/health");
    check("/near/health stays up and shows the halt", h.status === 200 && (h.json.halt as Record<string, unknown>).halted === true);
    kv.delete("sponsor:halt:testnet");
    resetHaltCache();
    check("cleared, the relay passes again", (await relay(await b64())).status === 200);
  }

  console.log("\n[store down] fail closed");
  {
    fresh();
    storeMode = "http500";
    const r = await relay(await b64());
    check("a store answering 500: 503 store_unavailable, nothing relayed", r.status === 503 && r.json.code === "store_unavailable" && sent.length === 0, JSON.stringify(r.json));
    check("...logged as refused store_unavailable", lastDecision().code === "store_unavailable");
    storeMode = "throw";
    const t = await relay(await b64());
    check("a store that cannot be reached: the same 503, nothing relayed", t.status === 503 && t.json.code === "store_unavailable" && sent.length === 0);
    storeMode = "ok";
    check("the store back: the relay passes", (await relay(await b64())).status === 200);
  }

  console.log("\n[memory] the in-process store serves only when no store is configured");
  {
    fresh();
    const savedUrl = process.env.KV_REST_API_URL;
    const savedToken = process.env.KV_REST_API_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    resetNearMemoryStoreForTests();
    const h = await call("/near/health");
    check("/near/health says storage memory", h.status === 200 && h.json.storage === "memory", JSON.stringify(h.json));
    const keyPair = KeyPair.fromRandom("ed25519");
    check("a relay passes on it", (await relay(await b64({ keyPair, nonce: 42n }))).status === 200);
    const again = await relay(await b64({ keyPair, nonce: 43n }));
    check("and the cooldown holds in it", again.status === 429 && again.json.code === "cooldown");
    check("no pipeline went to the (unconfigured) store", pipelines.length === 0);
    process.env.KV_REST_API_URL = savedUrl;
    process.env.KV_REST_API_TOKEN = savedToken;
  }

  console.log("\n[submit] the send: timeout then polling, a nonce collision retried, a failed send counted");
  {
    fresh();
    plan.send = ["timeout"];
    plan.txStatus = [{ final_execution_status: "EXECUTED_OPTIMISTIC" }, successResponse()];
    const polled = await relay(await b64({ senderId: "polly.testnet" }));
    check("a send the RPC stopped waiting on is polled to FINAL and answers 200", polled.status === 200 && (polled.json.outcome as Record<string, unknown>).status === "success" && rpcCalls.filter((c) => c === "status").length === 2, JSON.stringify(polled.json));
    rpcCalls.length = 0;
    plan.send = ["invalid-nonce", "ok"];
    const retried = await relay(await b64({ senderId: "nina.testnet" }));
    check("an InvalidNonce is retried with a fresh nonce: two sends, one 200", retried.status === 200 && rpcCalls.filter((c) => c === "send").length === 2);
    const keyPair = KeyPair.fromRandom("ed25519");
    plan.send = ["throw"];
    const failed = await relay(await b64({ senderId: "sam.testnet", keyPair, nonce: 42n }));
    check("a send that fails outright: 502 submit_failed", failed.status === 502 && failed.json.code === "submit_failed", JSON.stringify(failed.json));
    check("...logged as allowed / not_sent", lastDecision().decision === "allowed" && lastDecision().status === "not_sent");
    const after = await relay(await b64({ senderId: "sam.testnet", keyPair, nonce: 43n }));
    check("...and it still counted: the retry inside 10 s is 429 cooldown (the transaction may be on the network)", after.status === 429 && after.json.code === "cooldown");
  }

  console.log("\n[watchdog] the NEAR relayer balance page");
  {
    fresh();
    process.env.WATCHDOG_RETRY_BASE_MS = "1";
    const alerts: Alert[] = [];
    const saved = process.env.NEAR_ESCROW_ID;
    delete process.env.NEAR_ESCROW_ID;
    check("unconfigured: the check completes with nothing to say", (await checkNearRelayer(alerts)) === true && alerts.length === 0);
    process.env.NEAR_ESCROW_ID = saved;
    const fine: Alert[] = [];
    check("10 NEAR against a floor of 1: an info line, no page", (await checkNearRelayer(fine)) === true && fine.length === 1 && fine[0]?.severity === "info" && /10 NEAR/.test(fine[0]?.detail ?? ""));
    plan.relayerAccount = 5n * 10n ** 23n;
    const low: Alert[] = [];
    check("0.5 NEAR against a floor of 1: a page with the title, naming the account and the floor", (await checkNearRelayer(low)) === true && low[0]?.severity === "page" && low[0]?.title === NEAR_RELAYER_LOW_TITLE && low[0]?.detail.includes(RELAYER) && /0\.5 NEAR/.test(low[0]?.detail ?? ""), JSON.stringify(low));
    process.env.NEAR_RELAYER_MIN_NEAR = "0.25";
    const lower: Alert[] = [];
    check("the floor is NEAR_RELAYER_MIN_NEAR (0.25): the same balance no longer pages", (await checkNearRelayer(lower)) === true && lower[0]?.severity === "info");
    process.env.NEAR_RELAYER_MIN_NEAR = "1";
    plan.relayerAccount = { error: "account lumenia-relayer.testnet does not exist while viewing" };
    let thrown = "";
    try {
      await checkNearRelayer([]);
    } catch (e) {
      thrown = (e as Error).message;
    }
    check("an RPC error about the account throws (the run pages 'check failed'), unretried", /does not exist/.test(thrown), thrown);
    delete process.env.WATCHDOG_RETRY_BASE_MS;
  }


  /* ============================ /near/practice-link ============================ */

  const practice = (body: unknown, ip = "203.0.113.7", extra: { rawBody?: string; method?: string } = {}) =>
    call("/near/practice-link", {
      ...(extra.rawBody !== undefined ? { rawBody: extra.rawBody } : { body }),
      ...(extra.method ? { method: extra.method } : {}),
      headers: { "cf-connecting-ip": ip },
    });
  const goodBody = (o: Record<string, unknown> = {}) => ({ publicKey: linkKey(), amountUsdc: "1.00", expiresInS: 3600, memo: "coffee", ...o });
  const practiceKeys = () => [...kv.keys()].filter((k) => k.startsWith("near:testnet:practice:"));
  const relayKeys = () => nearKeys().filter((k) => !k.startsWith("near:testnet:practice:"));
  const today = () => new Date().toISOString().slice(0, 10);
  /** The FunctionCall the fake RPC saw, decoded. */
  const sentCall = (i = 0) => {
    const tx = sent[i]?.transaction;
    const fc = tx?.actions[0]?.functionCall;
    return {
      tx,
      fc,
      args: fc ? (JSON.parse(Buffer.from(fc.args).toString("utf8")) as { receiver_id?: string; amount?: string; msg?: string; public_keys?: string[] }) : null,
    };
  };

  console.log("\n[practice: config] practiceConfigFromEnv");
  {
    const d = practiceConfigFromEnv({});
    check("defaults: 10 per caller per day, 300 per day, 30 s cooldown", d.ok && JSON.stringify(d.limits) === JSON.stringify({ perSenderPerDay: 10, globalPerDay: 300, senderCooldownS: 30 }) && JSON.stringify(DEFAULT_PRACTICE_CAPS) === JSON.stringify(d.limits));
    const set = practiceConfigFromEnv({ NEAR_PRACTICE_PER_IP_PER_DAY: "3", NEAR_PRACTICE_PER_DAY: "40", NEAR_PRACTICE_COOLDOWN_S: "5" });
    check("the three variables override them", set.ok && set.limits.perSenderPerDay === 3 && set.limits.globalPerDay === 40 && set.limits.senderCooldownS === 5);
    const bad = practiceConfigFromEnv({ NEAR_PRACTICE_PER_DAY: "lots" });
    check("a cap that is not a non-negative integer is a configuration error naming it", !bad.ok && bad.code === "near_not_configured" && /NEAR_PRACTICE_PER_DAY/.test(bad.reason));
    const off = practiceConfigFromEnv({ NEAR_PRACTICE_PER_DAY: "0" });
    check("NEAR_PRACTICE_PER_DAY=0 switches the route off", !off.ok && off.code === "practice_off");
  }

  console.log("\n[practice: parse] the body rules, offline");
  {
    const key = linkKey();
    const okReq = parsePracticeRequest({ publicKey: key, amountUsdc: "0.5", expiresInS: 600, memo: "  hi  " });
    check("a good body parses: units, the amount normalised, the memo trimmed", okReq.ok && okReq.request.amountUnits === "500000" && okReq.request.amountUsdc === "0.50" && okReq.request.memo === "hi" && okReq.request.publicKey === key);
    check("the msg is the escrow's single-link shape, built from the public key only", okReq.ok && practiceMsg(okReq.request) === JSON.stringify({ public_key: key, expires_in_s: 600, memo: "hi" }));
    const noMemo = parsePracticeRequest({ publicKey: key, amountUsdc: "0.10", expiresInS: 28_800, memo: "   " });
    check("a blank memo is dropped; 0.10 and 8 hours are the edges, accepted", noMemo.ok && noMemo.request.memo === undefined && practiceMsg(noMemo.request) === JSON.stringify({ public_key: key, expires_in_s: 28_800 }));
    check("1.00 and 6 decimals inside the range are accepted", parsePracticeRequest({ publicKey: key, amountUsdc: "1", expiresInS: 600 }).ok && parsePracticeRequest({ publicKey: key, amountUsdc: "0.123456", expiresInS: 600 }).ok);
    check("2 minutes is the shortest life, long enough to watch the money come home", parsePracticeRequest({ publicKey: key, amountUsdc: "0.5", expiresInS: 120 }).ok && !parsePracticeRequest({ publicKey: key, amountUsdc: "0.5", expiresInS: 119 }).ok);
    check(`a memo of exactly ${PRACTICE_MAX_MEMO_BYTES} bytes is accepted`, parsePracticeRequest({ publicKey: key, amountUsdc: "1", expiresInS: 600, memo: "m".repeat(PRACTICE_MAX_MEMO_BYTES) }).ok);
  }

  console.log("\n[practice: unconfigured] the 503s, before the store or the RPC");
  {
    fresh();
    const saved = process.env.NEAR_ESCROW_ID;
    delete process.env.NEAR_ESCROW_ID;
    const r = await practice(goodBody());
    check("without the NEAR variables: 503 near_not_configured", r.status === 503 && r.json.error === "near_not_configured", JSON.stringify(r.json));
    process.env.NEAR_ESCROW_ID = saved;
    const savedKey = process.env.NEAR_RELAYER_PRIVATE_KEY;
    delete process.env.NEAR_RELAYER_PRIVATE_KEY;
    const noKey = await practice(goodBody());
    check("without the relayer key: 503 near_not_configured naming NEAR_RELAYER_PRIVATE_KEY", noKey.status === 503 && noKey.json.code === "near_not_configured" && /NEAR_RELAYER_PRIVATE_KEY/.test(String(noKey.json.reason)));
    process.env.NEAR_RELAYER_PRIVATE_KEY = savedKey;
    process.env.NEAR_PRACTICE_PER_DAY = "0";
    const off = await practice(goodBody());
    check("switched off (NEAR_PRACTICE_PER_DAY=0): 503 practice_off", off.status === 503 && off.json.code === "practice_off", JSON.stringify(off.json));
    process.env.NEAR_PRACTICE_PER_DAY = "many";
    const badCap = await practice(goodBody());
    check("a malformed cap: 503 near_not_configured naming the variable", badCap.status === 503 && badCap.json.code === "near_not_configured" && /NEAR_PRACTICE_PER_DAY/.test(String(badCap.json.reason)));
    delete process.env.NEAR_PRACTICE_PER_DAY;
    process.env.STELLAR_NETWORK = "mainnet";
    resetServiceCache();
    const onMainnet = await practice(goodBody());
    check("on the mainnet Worker: 503 near_not_configured, even with the NEAR variables set", onMainnet.status === 503 && /testnet Worker only/.test(String(onMainnet.json.reason)), JSON.stringify(onMainnet.json));
    process.env.STELLAR_NETWORK = "testnet";
    resetServiceCache();
    check("...and none of those reached the RPC, the store's caps or the network", rpcCalls.length === 0 && nearKeys().length === 0 && sent.length === 0);
    check("GET /near/practice-link is 405", (await call("/near/practice-link")).status === 405);
  }

  console.log("\n[practice: 400] every body rule, refused offline with a code and one log line");
  {
    fresh();
    const secretInstead = KeyPair.fromRandom("ed25519").toString();
    const cases: Array<{ name: string; code: string; body?: unknown; raw?: string }> = [
      { name: "a body that is not JSON", code: "bad_request", raw: "{not json" },
      { name: "an empty body", code: "bad_request", raw: "" },
      { name: "a JSON array", code: "bad_request", body: [goodBody()] },
      { name: "an unknown field", code: "bad_request", body: goodBody({ receiver: "mallory.testnet" }) },
      { name: "no publicKey", code: "public_key", body: goodBody({ publicKey: undefined }) },
      { name: "a link SECRET where the public key belongs", code: "public_key", body: goodBody({ publicKey: secretInstead }) },
      { name: "a secp256k1 key", code: "public_key", body: goodBody({ publicKey: "secp256k1:" + "1".repeat(88) }) },
      { name: "an amount as a JSON number", code: "amount", body: goodBody({ amountUsdc: 1 }) },
      { name: "an amount below 0.10", code: "amount", body: goodBody({ amountUsdc: "0.09" }) },
      { name: "an amount above 1.00", code: "amount", body: goodBody({ amountUsdc: "1.01" }) },
      { name: "an amount with 7 decimals", code: "amount", body: goodBody({ amountUsdc: "1.0000001" }) },
      { name: "an amount in words", code: "amount", body: goodBody({ amountUsdc: "one" }) },
      { name: "a negative amount", code: "amount", body: goodBody({ amountUsdc: "-1.00" }) },
      { name: "a life of 119 s", code: "expiry", body: goodBody({ expiresInS: 119 }) },
      { name: "a life of 8 hours and 1 s", code: "expiry", body: goodBody({ expiresInS: 28_801 }) },
      { name: "a fractional life", code: "expiry", body: goodBody({ expiresInS: 3600.5 }) },
      { name: "a life as a string", code: "expiry", body: goodBody({ expiresInS: "3600" }) },
      { name: `a memo over ${PRACTICE_MAX_MEMO_BYTES} bytes`, code: "memo", body: goodBody({ memo: "\u00e7".repeat(33) }) },
      { name: "a memo with a control character", code: "memo", body: goodBody({ memo: "line\nbreak" }) },
      { name: "a memo that is not a string", code: "memo", body: goodBody({ memo: 7 }) },
    ];
    for (const c of cases) {
      const before = decisions.length;
      const r = c.raw !== undefined ? await practice(undefined, "203.0.113.7", { rawBody: c.raw }) : await practice(c.body);
      check(`${c.name}: 400 ${c.code}`, r.status === 400 && r.json.code === c.code && typeof r.json.reason === "string" && r.json.error === r.json.reason, `${r.status} ${JSON.stringify(r.json)}`);
      check(`${c.name}: one refused log line`, decisions.length === before + 1 && lastDecision().decision === "refused" && lastDecision().code === c.code && lastDecision().route === "near/practice-link", JSON.stringify(lastDecision()));
    }
    // The one store read a value route always makes is the Worker's kill-switch verdict (cached 5 s); no cap key is read.
    const capReads = pipelines.filter((p) => p.some((c) => String(c[1] ?? "").startsWith("near:")));
    check("not one of them read a cap or reached the RPC", capReads.length === 0 && rpcCalls.length === 0 && sent.length === 0, `${JSON.stringify(capReads)} ${rpcCalls.join(",")}`);
    check("...the only store read was the kill switch's", pipelines.every((p) => p.every((c) => String(c[1] ?? "").startsWith("sponsor:halt"))), JSON.stringify(pipelines));
    check("the secret sent by mistake appears in no log line and no answer", decisions.every((d) => !JSON.stringify(d).includes(secretInstead)));
    check("no log line carries the caller's address", decisions.every((d) => !JSON.stringify(d).includes("203.0.113.7")));
  }

  console.log("\n[practice: 200] the one transaction it signs");
  {
    fresh();
    plan.response = successResponse({ successValue: '"1000000"', logs: ['EVENT_JSON:{"standard":"lumenia_drop","version":"1.0.0","event":"drop_created","data":[{"amount":"1000000"}]}'] });
    const body = goodBody();
    const r = await practice(body);
    const outcome = r.json.outcome as Record<string, unknown>;
    check("200 with txHash, explorerUrl, the funder (the relayer) and the outcome", r.status === 200 && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(String(r.json.txHash)) && r.json.explorerUrl === `https://testnet.nearblocks.io/txns/${r.json.txHash}` && r.json.funderId === RELAYER, JSON.stringify(r.json));
    check("outcome: success, create_link, the link created, the amount the escrow kept", outcome.status === "success" && outcome.kind === "create_link" && outcome.linkCreated === true && outcome.usedAmount === "1000000");
    const { tx, fc, args } = sentCall();
    check("the link's transaction first, from the relayer's own key, to the USDC contract", sent.length === 2 && tx?.signerId === RELAYER && tx?.receiverId === USDC && tx?.publicKey.toString() === relayerKey.getPublicKey().toString() && tx?.actions.length === 1);
    check("one ft_transfer_call with exactly 1 yoctoNEAR and 100 Tgas", fc?.methodName === "ft_transfer_call" && BigInt(String(fc?.deposit)) === 1n && BigInt(String(fc?.gas)) === 100n * 10n ** 12n);
    check("into the escrow, for the amount asked, with the msg built from the PUBLIC key", args?.receiver_id === ESCROW && args?.amount === "1000000" && args?.msg === JSON.stringify({ public_key: body.publicKey, expires_in_s: 3600, memo: "coffee" }), JSON.stringify(args));
    const arm = sentCall(1);
    check(
      "then the return timer: arm_return([that public key]) on the escrow, no deposit, gas for the link's life",
      arm.tx?.signerId === RELAYER && arm.tx?.receiverId === ESCROW && arm.tx?.actions.length === 1 && arm.fc?.methodName === "arm_return" && BigInt(String(arm.fc?.deposit)) === 0n && BigInt(String(arm.fc?.gas)) === BigInt(armReturnTgas(3600)) * 10n ** 12n && JSON.stringify(arm.args?.public_keys) === JSON.stringify([body.publicKey]),
      JSON.stringify(arm.args),
    );
    check("the practice balance was read first, then the link was sent until FINAL, then the timer only until INCLUDED_FINAL", rpcCalls.join(",") === `ftbalance:usdc:${RELAYER},key:${RELAYER},block,send,key:${RELAYER},block,include`, rpcCalls.join(","));
    const timer = r.json.returnTimer as Record<string, unknown>;
    check("the answer carries the armed timer's transaction and gas", timer?.armed === true && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(String(timer.txHash)) && timer.explorerUrl === `https://testnet.nearblocks.io/txns/${timer.txHash}` && timer.gasTgas === armReturnTgas(3600), JSON.stringify(timer));
    const day = today();
    check("the caps were recorded in the practice namespace: cooldown, the caller's day, the day's total", kvGet(`near:testnet:practice:cool:203.0.113.7`) !== null && kvGet(`near:testnet:practice:day:${day}:sender:203.0.113.7`) === "1" && kvGet(`near:testnet:practice:day:${day}:global`) === "1");
    check("...and nothing in the relay's own counters", relayKeys().length === 0, relayKeys().join(","));
    const d = lastDecision();
    check("one allowed log line with the link key, amount, life, txHash, status, the timer's tx and ms", d.decision === "allowed" && d.route === "near/practice-link" && d.publicKey === body.publicKey && d.amount === "1.00" && d.expiresInS === 3600 && d.txHash === r.json.txHash && d.status === "success" && d.returnTimer === timer.txHash && typeof d.ms === "number", JSON.stringify(d));
    check("no log line or answer carries the caller's address or the relayer's secret", !JSON.stringify(decisions).includes("203.0.113.7") && !JSON.stringify(decisions).includes(relayerKey.toString()) && !JSON.stringify(r.json).includes(relayerKey.toString()));

    plan.response = successResponse({ successValue: '"0"', receiptFailure: "Smart contract panicked: drop refused: the escrow is paused" });
    sent.length = 0;
    const refused = await practice(goodBody(), "203.0.113.8");
    const ro = refused.json.outcome as Record<string, unknown>;
    check("an escrow refusal is 200 with outcome failure, its reason surfaced and the hash kept (the USDC was refunded)", refused.status === 200 && ro.status === "failure" && ro.linkCreated === false && String((ro.failures as string[])[0]).includes("paused") && typeof refused.json.txHash === "string", JSON.stringify(refused.json));
    check("...logged as allowed with status failure and the summary", lastDecision().status === "failure" && /escrow/.test(String(lastDecision().reason)));
    check("...and no timer is armed for a link that does not exist", sent.length === 1 && refused.json.returnTimer === undefined);

    plan.response = successResponse({ successValue: '"1000000"' });
    plan.include = "throw";
    const unarmed = await practice(goodBody(), "203.0.113.9");
    const ut = unarmed.json.returnTimer as Record<string, unknown>;
    check("a timer that cannot be armed leaves the link standing: 200, success, the reason given", unarmed.status === 200 && (unarmed.json.outcome as Record<string, unknown>).status === "success" && ut?.armed === false && /could not be armed/.test(String(ut.reason)), JSON.stringify(unarmed.json));
    plan.include = "ok";

    check(
      "the timer's gas: two wake-ups past the life, a 45 Tgas floor, 1 PGas at most, and the longest practice life fits",
      armReturnTgas(120) === 45 + (2 + 2) * 3 && armReturnTgas(3600) === 45 + (36 + 2) * 3 && armReturnTgas(28_800) === 45 + (288 + 2) * 3 && armReturnTgas(28_800) < 1000 && armReturnTgas(604_800) === 1000,
    );
  }

  console.log("\n[practice: 429] one every 30 s per caller, 10 a day per caller, 300 a day in total");
  {
    fresh();
    check("the first link of a caller passes", (await practice(goodBody(), "198.51.100.1")).status === 200);
    const second = await practice(goodBody(), "198.51.100.1");
    check("a second one inside 30 s: 429 cooldown with retryAfterS and Retry-After", second.status === 429 && second.json.code === "cooldown" && Number(second.json.retryAfterS) >= 1 && Number(second.json.retryAfterS) <= 30 && second.headers.get("retry-after") === String(second.json.retryAfterS) && /every 30 s/.test(String(second.json.reason)), JSON.stringify(second.json));
    check("...logged as refused cooldown, nothing more sent", lastDecision().code === "cooldown" && sent.length === 1);
    check("...and its reason does not echo the caller's address", !JSON.stringify(second.json).includes("198.51.100.1"));
    check("another caller passes meanwhile", (await practice(goodBody(), "198.51.100.2")).status === 200);
    const v6a = await practice(goodBody(), "2001:db8:aa:1::1");
    const v6b = await practice(goodBody(), "2001:db8:aa:1:ffff::2");
    check("two addresses in one IPv6 /64 are one caller: the second is 429 cooldown", v6a.status === 200 && v6b.status === 429 && v6b.json.code === "cooldown");
    kvSet(`near:testnet:practice:cool:198.51.100.1`, String(Date.now() - 31_000), 60_000);
    check("31 s later the first caller passes again", (await practice(goodBody(), "198.51.100.1")).status === 200);
    const day = today();
    kvSet(`near:testnet:practice:day:${day}:sender:198.51.100.3`, "10");
    const daily = await practice(goodBody(), "198.51.100.3");
    check("10 links today from one caller: 429 ip_daily, retryAfterS to UTC midnight", daily.status === 429 && daily.json.code === "ip_daily" && Math.abs(Number(daily.json.retryAfterS) - secondsToDayEnd(Date.now())) <= 2 && /10 practice links/.test(String(daily.json.reason)), JSON.stringify(daily.json));
    check("...and the count did not move", kvGet(`near:testnet:practice:day:${day}:sender:198.51.100.3`) === "10");
    kvSet(`near:testnet:practice:day:${day}:global`, "300");
    const global = await practice(goodBody(), "198.51.100.4");
    check("300 links today in total: 429 global_daily", global.status === 429 && global.json.code === "global_daily" && /300 links/.test(String(global.json.reason)), JSON.stringify(global.json));
    check("none of the refusals sent anything", sent.length === 4, String(sent.length));
    kv.delete(`near:testnet:practice:day:${day}:global`);
    // A lost race at the record step (the read said yes, another request took the slot first).
    const keyNow = `near:testnet:practice:cool:198.51.100.5`;
    const raced = await Promise.all([practice(goodBody(), "198.51.100.5"), practice(goodBody(), "198.51.100.5")]);
    const statuses = raced.map((x) => x.status).sort();
    check("two links of one caller in the same instant: one 200, one 429 cooldown", statuses[0] === 200 && statuses[1] === 429 && raced.some((x) => x.json.code === "cooldown"), statuses.join(","));
    check("...and the caller's day count is 1, not 2 (the loser gave its count back)", kvGet(`near:testnet:practice:day:${day}:sender:198.51.100.5`) === "1" && kvGet(keyNow) !== null);
  }

  console.log("\n[practice: balance] an empty practice balance is refused before any cap is spent");
  {
    fresh();
    plan.relayerUsdc = 999_999n;
    const empty = await practice(goodBody());
    check("a balance under the amount: 503 practice_empty, saying what it holds", empty.status === 503 && empty.json.code === "practice_empty" && /0\.999999 USDC/.test(String(empty.json.reason)), JSON.stringify(empty.json));
    check("...nothing recorded, nothing sent", practiceKeys().length === 0 && sent.length === 0);
    plan.relayerUsdc = { error: "fetch failed" };
    const unread = await practice(goodBody());
    check("a balance that cannot be read: 502 rpc, nothing recorded, nothing sent", unread.status === 502 && unread.json.code === "rpc" && practiceKeys().length === 0 && sent.length === 0, JSON.stringify(unread.json));
    plan.relayerUsdc = 1_000_000n;
    check("exactly enough passes", (await practice(goodBody())).status === 200);
  }

  console.log("\n[practice: fail closed] the store down, the kill switch, a failed send");
  {
    fresh();
    storeMode = "http500";
    const down = await practice(goodBody());
    check("a store answering 500: 503 store_unavailable, nothing sent", down.status === 503 && down.json.code === "store_unavailable" && sent.length === 0 && rpcCalls.length === 0, JSON.stringify(down.json));
    check("...logged as refused store_unavailable", lastDecision().code === "store_unavailable" && lastDecision().route === "near/practice-link");
    storeMode = "throw";
    const gone = await practice(goodBody());
    check("a store that cannot be reached: the same 503", gone.status === 503 && gone.json.code === "store_unavailable" && sent.length === 0);
    storeMode = "ok";
    kvSet("sponsor:halt:testnet", "1");
    resetHaltCache();
    const halted = await practice(goodBody());
    check("under the sponsor halt: 503 'sponsor temporarily halted', nothing sent", halted.status === 503 && halted.json.error === "sponsor temporarily halted" && sent.length === 0);
    kv.delete("sponsor:halt:testnet");
    resetHaltCache();
    plan.send = ["throw"];
    const failed = await practice(goodBody(), "192.0.2.9");
    check("a send that fails outright: 502 submit_failed, logged allowed / not_sent", failed.status === 502 && failed.json.code === "submit_failed" && lastDecision().decision === "allowed" && lastDecision().status === "not_sent", JSON.stringify(failed.json));
    const retry = await practice(goodBody(), "192.0.2.9");
    check("...and it still counted: a retry inside 30 s is 429 cooldown (the transaction may be on the network)", retry.status === 429 && retry.json.code === "cooldown");
    plan.send = ["invalid-nonce", "ok"];
    rpcCalls.length = 0;
    const nonce = await practice(goodBody(), "192.0.2.10");
    check("an InvalidNonce is retried with a fresh nonce: two sends, one 200", nonce.status === 200 && rpcCalls.filter((c) => c === "send").length === 2);
  }

  console.log("\n[practice: memory] the in-process store serves only when no store is configured");
  {
    fresh();
    const savedUrl = process.env.KV_REST_API_URL;
    const savedToken = process.env.KV_REST_API_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    resetNearMemoryStoreForTests();
    check("a practice link passes on it", (await practice(goodBody(), "192.0.2.20")).status === 200);
    const again = await practice(goodBody(), "192.0.2.20");
    check("and the cooldown holds in it", again.status === 429 && again.json.code === "cooldown");
    check("no pipeline went to the (unconfigured) store", pipelines.length === 0);
    process.env.KV_REST_API_URL = savedUrl;
    process.env.KV_REST_API_TOKEN = savedToken;
  }

  console.log("\n[sweep] every expired, unclaimed link goes home to its funder (return_expired)");
  {
    const nowMs = Date.UTC(2026, 10, 12, 12, 0, 0);
    const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
    const row = (status: string, expiresMs: number, o: { funder?: string; amount?: string } = {}) => ({ public_key: linkKey(), status, funder: o.funder ?? RELAYER, amount: o.amount ?? "1000000", expires_at_ns: ns(expiresMs) });
    const older = row("Open", nowMs - 120_000, { amount: "200000" });
    const old = row("Open", nowMs - 60_000);
    const future = row("Open", nowMs + 60_000);
    const claimed = row("Claimed", nowMs - 3_600_000);
    const claiming = row("Claiming", nowMs - 3_600_000);
    const foreign = row("Open", nowMs - 60_000, { funder: "someone.testnet" });
    const ledger = [old, future, claimed, claiming, foreign, older];
    const picked = expiredOpenDrops(ledger, nowMs);
    check("every funder's expired Open links are picked, oldest expiry first", picked.map((d) => d.public_key).join() === [older, old, foreign].map((d) => d.public_key).join());
    check("an expiry exactly now counts as expired", expiredOpenDrops([row("Open", nowMs)], nowMs).length === 1);
    const groups = returnGroups(picked);
    check("one call per funder", groups.length === 2 && groups[0]!.map((d) => d.public_key).join() === [older, old].map((d) => d.public_key).join() && groups[1]![0]!.public_key === foreign.public_key);
    const many = Array.from({ length: 31 }, () => row("Open", nowMs - 1_000));
    check(`at most ${SWEEP_MAX_KEYS} links in one call (the escrow's limit)`, returnGroups(many).map((g) => g.length).join() === "30,1");
    check("the gas: 60 Tgas plus 2 per link", sweepReturnTgas(1) === 62 && sweepReturnTgas(30) === 120);
    check(
      "a failed receipt or a failed transaction is a failed return",
      !outcomeSucceeded({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: {} } } }] }) &&
        outcomeSucceeded({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] }) &&
        !outcomeSucceeded({ status: { Failure: {} } }) &&
        !outcomeSucceeded(null),
    );

    const sweepSent: SignedTransaction[] = [];
    const views: Record<string, unknown>[] = [];
    let sendMode: "ok" | "fail" | "throw" = "ok";
    const sweepRpc: NearRpc = {
      url: RPC_URL,
      async viewBlock() {
        return { height: HEIGHT, hash: "11111111111111111111111111111111" };
      },
      async viewAccessKey() {
        return { nonce: 41n, permission: "FullAccess" };
      },
      async viewAccount() {
        return { amountYocto: 10n ** 24n };
      },
      async sendUntilFinal(signed) {
        sweepSent.push(signed);
        if (sendMode === "throw") throw new Error("RPC unreachable (fetch failed)");
        return sendMode === "fail"
          ? { status: { Failure: { ActionError: {} } }, receipts_outcome: [] }
          : { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "dHJ1ZQ==" } } }] };
      },
      async txStatus() {
        throw new Error("not used by the sweep");
      },
      async viewFunction(contractId, method, args) {
        views.push({ contractId, method, ...args });
        return Number(args.from_index ?? 0) === 0 ? ledger : [];
      },
    };
    const sweepConfig = { network: "testnet" as const, rpcUrl: RPC_URL, relayerAccountId: RELAYER, escrowId: ESCROW, usdcId: USDC, caps: { perSenderPerDay: 20, globalPerDay: 500, senderCooldownS: 10 }, minNear: 1 };
    const sweepDeps = { config: sweepConfig, secret: relayerKey.toString(), rpc: sweepRpc, pollMs: 0, maxPolls: 1 };
    const lines: string[] = [];
    const r = await sweepExpiredLinks(sweepDeps, { now: () => nowMs, max: 3, log: (l) => lines.push(l) });
    check("one ledger read: the escrow's get_drops, every funder", views.length === 1 && views[0]!.contractId === ESCROW && views[0]!.method === "get_drops" && views[0]!.funder === undefined);
    const calls = sweepSent.map((s) => {
      const fc = s.transaction.actions[0]?.functionCall;
      return {
        receiver: s.transaction.receiverId,
        signer: s.transaction.signerId,
        method: fc?.methodName,
        args: fc ? (JSON.parse(Buffer.from(fc.args).toString("utf8")) as { public_keys?: string[] }) : {},
        gas: fc ? BigInt(String(fc.gas)) : 0n,
        deposit: fc ? BigInt(String(fc.deposit)) : -1n,
        actions: s.transaction.actions.length,
      };
    });
    check("two returns, one transaction per funder, signed by the relayer, to the escrow", calls.length === 2 && calls.every((c) => c.receiver === ESCROW && c.signer === RELAYER && c.actions === 1));
    check(
      "each is return_expired(public_keys) with gas for its links and no deposit",
      calls.every((c) => c.method === "return_expired" && c.deposit === 0n && c.gas === BigInt(sweepReturnTgas(c.args.public_keys?.length ?? 0)) * 10n ** 12n) &&
        (calls[0]!.args.public_keys ?? []).join() === [older.public_key, old.public_key].join() &&
        (calls[1]!.args.public_keys ?? []).join() === foreign.public_key,
    );
    const touched = calls.flatMap((c) => c.args.public_keys ?? []);
    check("the Claiming link, the claimed one and the unexpired one are never touched", ![claiming, claimed, future].some((d) => touched.includes(d.public_key)));
    check("the result counts what it did and what it left alone", r.checked === 6 && r.expired === 3 && r.returned.length === 3 && r.skippedClaiming === 1 && r.error === undefined, JSON.stringify(r));
    check("one JSON line per return and a summary, with no key in any", lines.length === 3 && lines.every((l) => !l.includes(relayerKey.toString())) && JSON.parse(lines[2]!).decision === "done");

    sweepSent.length = 0;
    const one = await sweepExpiredLinks(sweepDeps, { now: () => nowMs, max: 1, log: () => undefined });
    check("the per-run maximum holds", sweepSent.length === 1 && one.returned.length === 2);

    sweepSent.length = 0;
    sendMode = "fail";
    const failedRun = await sweepExpiredLinks(sweepDeps, { now: () => nowMs, log: () => undefined });
    check("a failed return stops the run and says so", sweepSent.length === 1 && failedRun.returned.length === 0 && /ended in a failure/.test(failedRun.error ?? ""));

    sweepSent.length = 0;
    sendMode = "throw";
    const thrown = await sweepExpiredLinks(sweepDeps, { now: () => nowMs, log: () => undefined });
    check("an RPC that cannot send stops the run without throwing", thrown.returned.length === 0 && /could not be sent/.test(thrown.error ?? ""));

    const noView = await sweepExpiredLinks({ ...sweepDeps, rpc: { ...sweepRpc, viewFunction: undefined } }, { now: () => nowMs, log: () => undefined });
    check("an RPC without contract views skips the run", noView.checked === 0 && /no contract views/.test(noView.error ?? ""));

    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const [testnetPart, mainnetPart] = toml.split("\n[env.mainnet]\n");
    check("the sweep's cron is on the testnet Worker and not on the mainnet one", (testnetPart ?? "").includes(`"${PRACTICE_SWEEP_CRON}"`) && !(mainnetPart ?? "").includes(PRACTICE_SWEEP_CRON));
  }

  globalThis.fetch = realFetch;
  console.log = realLog;
  setNearRpcForTests(null);
  setNearPollMsForTests(null);
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} NEAR RELAY ${pass}/${pass + fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.log = realLog;
  console.error(e);
  process.exit(1);
});
