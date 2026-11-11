/**
 * The NEAR rail's relayer (NEAR HACKATHON 2026, testnet): POST /near/relay, GET /near/health and
 * GET /near/policy on the sponsor Worker. A port of external/lumenia-near/relayer/src/relay.ts onto
 * this service's store, limiter, kill switch and subrequest meter; the pure parts (the allowlist,
 * the cap vocabulary, the client) live in the workspace package `@lumenia/near`.
 *
 * WHAT IT DOES. A person who claimed a Lumenia link on NEAR owns a fresh account with USDC and
 * about 0.01 NEAR: enough to receive, not enough to pay gas. They sign a NEP-366 DelegateAction
 * (the instruction) with their own full-access key; this relayer checks it, wraps it in ONE
 * transaction signed by `lumenia-relayer.testnet` and pays the gas and the 1 yoctoNEAR the token
 * contract demands. The network checks the sender's signature again and runs the call AS the
 * sender. The relayer never holds a user key and never signs on a user's behalf: a dishonest
 * relayer could at worst refuse to pay.
 *
 * WHAT IT PAYS FOR, and nothing else (lib `@lumenia/near/relayer/policy`, GET /near/policy):
 *   1. creating a link: `ft_transfer_call` on the USDC contract whose args.receiver_id is the
 *      Lumenia escrow, exactly 1 yoctoNEAR, at most 100 Tgas, a msg in the single or batch shape;
 *   2. a funder's `reclaim` on the escrow with no deposit.
 * Any other receiver, method, deposit, gas, action type, a second action, a nested delegate, an
 * expired or too-distant max_block_height and a signature that does not verify are refused with a
 * reason and a code (403).
 *
 * THE ORDER, and why. Everything offline comes first, so a request that is going to be refused
 * costs no store call and no RPC call:
 *   decode (canonical borsh, 400) -> the delegate's own signature (403, offline) -> the Worker's
 *   rate limiter (per IP, and per signing KEY rather than per sender id: a forger can mint keys
 *   but cannot spend a victim's bucket) -> block height (one RPC read, cached 2 s) -> the policy
 *   (403) -> the caps, READ ONLY (429) -> the RPC pre-check (does the sender own that key, is the
 *   nonce fresh, is a function-call key asked to carry a deposit; 403) -> the caps, RECORDED
 *   atomically -> sign, send with wait_until FINAL, poll if the RPC gave up -> the outcome.
 * The caps are recorded only after the pre-check, so a delegate naming a stranger's sender_id
 * (its signature verifies against its own key, but the key is not on that account) burns none of
 * the stranger's daily allowance and sets no cooldown on them.
 *
 * CAPS. 20 relays per sender per UTC day, 500 per day, one relay per sender every 10 s
 * (NEAR_RELAY_PER_SENDER_PER_DAY, NEAR_RELAY_PER_DAY, NEAR_RELAY_COOLDOWN_S). They live in the
 * same Upstash store as every other counter of this service, through the same deadline
 * (lib/store-fetch.ts). The record step is one pipeline (SET NX EX for the cooldown, INCR for the
 * two day counters), and a count that overshot the cap in the gap between the read and the write
 * is given back and refused, so two relays of one sender in the same instant cannot both pass.
 * FAIL CLOSED: a store that errors, stalls or answers nonsense refuses the relay (503,
 * store_unavailable) rather than relaying unmetered; this is the mainnet posture (CAPS_FAIL_CLOSED)
 * applied to a rail where the relayer's NEAR is the only thing a cap protects. The in-memory store
 * is used ONLY when no store is configured at all (local dev, the suites), never as a fallback.
 *
 * WHAT IS NOT HERE. The relayer key is a hot key held as a Worker secret (NEAR_RELAYER_PRIVATE_KEY);
 * nothing in this file reads it except to build the signer, and nothing logs it. No fee or reward
 * model: the relayer pays out of its own balance, which is fine for a capped testnet pilot and not
 * for an open service. Testnet only: NEAR_NETWORK=mainnet is refused as "not configured", and the
 * Worker refuses the routes off its own Stellar testnet environment too.
 */
import {
  JsonRpcProvider,
  KeyPairSigner,
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  type DelegateAction,
  type KeyPairString,
  type Signature,
  type SignedTransaction,
} from "near-api-js";
import {
  decodeSignedDelegate,
  describePolicy,
  evaluate,
  isValidAccountId,
  toPublicKey,
  verifyDelegateSignature,
  type Allowed,
  type DecodedSignedDelegate,
  type PolicyDescription,
  type RelayKind,
} from "@lumenia/near/relayer/policy";
import { DEFAULT_CAPS, dayKey, secondsToDayEnd, type CapCode, type CapLimits } from "@lumenia/near/relayer/caps";
import { DEFAULTS as NEAR_DEFAULTS } from "@lumenia/near/relayer/config";
import { kvConfigFromEnv } from "./rate-limit.js";
import { storeFetch } from "./store-fetch.js";
import { subrequestsLeft } from "./subrequests.js";

/* ------------------------------------ configuration ------------------------------------ */

export interface NearRelayerConfig {
  network: "testnet";
  rpcUrl: string;
  relayerAccountId: string;
  escrowId: string;
  usdcId: string;
  caps: CapLimits;
  /** The watchdog's floor for the relayer's NEAR balance (NEAR_RELAYER_MIN_NEAR, default 1). */
  minNear: number;
}

/**
 * The NEAR rail is configured when its variables are all present and sane; the secret is reported
 * separately so /near/health can say "configured, no key" and /near/relay can answer 503 for it.
 */
export type NearConfigState =
  | { configured: true; config: NearRelayerConfig; secret: string | null }
  | { configured: false; reason: string };

const ENV_NAMES = {
  network: "NEAR_NETWORK",
  rpcUrl: "NEAR_RPC_URL",
  escrowId: "NEAR_ESCROW_ID",
  usdcId: "NEAR_USDC_ID",
  relayerAccountId: "NEAR_RELAYER_ACCOUNT_ID",
  secret: "NEAR_RELAYER_PRIVATE_KEY",
  perSenderPerDay: "NEAR_RELAY_PER_SENDER_PER_DAY",
  perDay: "NEAR_RELAY_PER_DAY",
  cooldownS: "NEAR_RELAY_COOLDOWN_S",
  minNear: "NEAR_RELAYER_MIN_NEAR",
} as const;

/** The default NEAR_RELAYER_MIN_NEAR: page when the relayer holds less than this many NEAR. */
export const DEFAULT_MIN_NEAR = 1;

function readInt(env: Record<string, string | undefined>, name: string, fallback: number): number | string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return `${name} must be a non-negative integer, got "${raw}"`;
  return n;
}

/**
 * Read the NEAR rail's configuration from the environment (the Worker's vars, hydrated into
 * process.env by worker.ts). Missing or malformed configuration is a STATE, not a throw: the routes
 * answer 503 {error: "near_not_configured", reason} and nothing else on the Worker is affected.
 */
export function nearConfigFromEnv(env: Record<string, string | undefined> = process.env): NearConfigState {
  const missing = [ENV_NAMES.network, ENV_NAMES.escrowId, ENV_NAMES.usdcId, ENV_NAMES.relayerAccountId].filter(
    (name) => !env[name] || env[name]!.trim() === "",
  );
  if (missing.length > 0) return { configured: false, reason: `${missing.join(", ")} not set` };
  const network = env[ENV_NAMES.network]!.trim();
  if (network !== "testnet") return { configured: false, reason: `${ENV_NAMES.network}=${network} is refused: the NEAR relayer runs on testnet only` };
  const rpcUrl = (env[ENV_NAMES.rpcUrl] ?? NEAR_DEFAULTS.NEAR_RPC_URL).trim();
  if (!/^https?:\/\//.test(rpcUrl)) return { configured: false, reason: `${ENV_NAMES.rpcUrl} must be an http(s) URL` };
  const escrowId = env[ENV_NAMES.escrowId]!.trim();
  const usdcId = env[ENV_NAMES.usdcId]!.trim();
  const relayerAccountId = env[ENV_NAMES.relayerAccountId]!.trim();
  for (const [name, value] of [
    [ENV_NAMES.escrowId, escrowId],
    [ENV_NAMES.usdcId, usdcId],
    [ENV_NAMES.relayerAccountId, relayerAccountId],
  ] as const) {
    if (!isValidAccountId(value)) return { configured: false, reason: `${name} is not a valid NEAR account id` };
  }
  if (escrowId === usdcId) return { configured: false, reason: `${ENV_NAMES.escrowId} and ${ENV_NAMES.usdcId} must differ` };
  const ints = {
    perSenderPerDay: readInt(env, ENV_NAMES.perSenderPerDay, DEFAULT_CAPS.perSenderPerDay),
    globalPerDay: readInt(env, ENV_NAMES.perDay, DEFAULT_CAPS.globalPerDay),
    senderCooldownS: readInt(env, ENV_NAMES.cooldownS, DEFAULT_CAPS.senderCooldownS),
  };
  for (const v of Object.values(ints)) if (typeof v === "string") return { configured: false, reason: v };
  const minRaw = env[ENV_NAMES.minNear];
  const minNear = minRaw === undefined || minRaw.trim() === "" ? DEFAULT_MIN_NEAR : Number(minRaw);
  if (!Number.isFinite(minNear) || minNear < 0) return { configured: false, reason: `${ENV_NAMES.minNear} must be a non-negative number` };
  const secret = env[ENV_NAMES.secret]?.trim();
  return {
    configured: true,
    config: {
      network: "testnet",
      rpcUrl,
      relayerAccountId,
      escrowId,
      usdcId,
      caps: ints as CapLimits,
      minNear,
    },
    secret: secret ? secret : null,
  };
}

/** The allowlist in plain words and as JSON (GET /near/policy). */
export function describeNearPolicy(config: NearRelayerConfig): PolicyDescription {
  return describePolicy({ escrowId: config.escrowId, usdcId: config.usdcId });
}

/* ------------------------------------ the NEAR RPC ------------------------------------ */

/**
 * The five RPC calls the relayer makes, as an interface, so the suites drive the Worker route with
 * a fake chain (test-near-relay.ts) and the live code wraps near-api-js's JsonRpcProvider.
 */
export interface NearRpc {
  readonly url: string;
  viewBlock(): Promise<{ height: number; hash: string }>;
  viewAccessKey(accountId: string, publicKey: string): Promise<{ nonce: bigint; permission: unknown }>;
  viewAccount(accountId: string): Promise<{ amountYocto: bigint }>;
  /** `send_tx` with wait_until FINAL. */
  sendUntilFinal(signed: SignedTransaction): Promise<unknown>;
  /** `tx` with wait_until FINAL: the fallback when the send timed out while the transaction was in flight. */
  txStatus(txHash: string, accountId: string): Promise<unknown>;
}

/**
 * near-api-js retries a failed request 12 times by default, and inside a Worker every attempt is a
 * subrequest (lib/subrequests.ts): a dead RPC would spend the whole budget on one call. Three
 * attempts, a short wait.
 */
const RPC_RETRIES = 2;
const RPC_RETRY_WAIT_MS = 300;

export function jsonRpcNearRpc(url: string): NearRpc {
  const provider = new JsonRpcProvider({ url }, { retries: RPC_RETRIES, wait: RPC_RETRY_WAIT_MS, backoff: 2 });
  return {
    url,
    async viewBlock() {
      const block = await provider.viewBlock({ finality: "final" });
      return { height: Number(block.header.height), hash: String(block.header.hash) };
    },
    async viewAccessKey(accountId, publicKey) {
      const key = await provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: "final" } });
      return { nonce: BigInt(String(key.nonce)), permission: key.permission };
    },
    async viewAccount(accountId) {
      const view = await provider.viewAccount({ accountId, blockQuery: { finality: "final" } });
      return { amountYocto: BigInt(String(view.amount)) };
    },
    sendUntilFinal: (signed) => provider.sendTransactionUntil(signed, "FINAL"),
    txStatus: (txHash, accountId) => provider.viewTransactionStatus({ txHash, accountId, waitUntil: "FINAL" }),
  };
}

let rpcFactoryForTests: ((url: string) => NearRpc) | null = null;

/** Tests only: every NearRpc the Worker builds comes from this factory until it is reset with null. */
export function setNearRpcForTests(factory: ((url: string) => NearRpc) | null): void {
  rpcFactoryForTests = factory;
  heightCache.clear();
}

/** The RPC for a URL: the test factory when one is set, near-api-js otherwise. */
export function nearRpc(url: string): NearRpc {
  return rpcFactoryForTests ? rpcFactoryForTests(url) : jsonRpcNearRpc(url);
}

/* ----------------------------------- the cap store ----------------------------------- */

/**
 * The store the caps live in: one `pipeline` of Redis commands, answered in order. Upstash over REST
 * with the service's deadline when a store is configured (KV_REST_API_URL / UPSTASH_REDIS_REST_URL),
 * an in-process map otherwise. The map is for local dev and the suites: it is never a fallback for a
 * configured store that failed (see the header: fail closed).
 */
export interface NearCapStore {
  readonly kind: "upstash" | "memory";
  pipeline(commands: string[][]): Promise<unknown[]>;
}

/** The store errored, stalled or answered something that is not a pipeline reply. */
export class NearStoreError extends Error {
  override name = "NearStoreError";
}

function upstashCapStore(kv: { url: string; token: string }): NearCapStore {
  return {
    kind: "upstash",
    async pipeline(commands) {
      let res: Response;
      try {
        res = await storeFetch(`${kv.url}/pipeline`, {
          method: "POST",
          headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
          body: JSON.stringify(commands),
        });
      } catch (e) {
        throw new NearStoreError(`the cap store could not be reached: ${(e as Error).message}`);
      }
      if (!res.ok) throw new NearStoreError(`the cap store answered ${res.status}`);
      let rows: unknown;
      try {
        rows = await res.json();
      } catch {
        throw new NearStoreError("the cap store answered something that is not JSON");
      }
      if (!Array.isArray(rows) || rows.length !== commands.length) throw new NearStoreError("the cap store answered the wrong number of rows");
      return (rows as Array<{ result?: unknown; error?: string }>).map((r) => {
        if (r && typeof r === "object" && typeof r.error === "string") throw new NearStoreError(`the cap store refused a command: ${r.error}`);
        return r?.result ?? null;
      });
    },
  };
}

/**
 * The in-process store: the subset of Redis the caps use (GET, SET [NX] [EX], INCR, DECRBY, EXPIRE,
 * DEL), with expiry. Anything else throws, so a new command in this file fails loudly in a test
 * instead of answering wrong.
 */
class MemoryCapStore implements NearCapStore {
  readonly kind = "memory" as const;
  private readonly items = new Map<string, { value: string; expiresAt: number | null }>();

  private live(key: string, now: number): { value: string; expiresAt: number | null } | undefined {
    const item = this.items.get(key);
    if (item && item.expiresAt !== null && item.expiresAt <= now) {
      this.items.delete(key);
      return undefined;
    }
    return item;
  }

  async pipeline(commands: string[][]): Promise<unknown[]> {
    const now = Date.now();
    return commands.map((cmd) => {
      const [op0, key = "", ...args] = cmd;
      const op = String(op0 ?? "").toUpperCase();
      switch (op) {
        case "GET":
          return this.live(key, now)?.value ?? null;
        case "SET": {
          const value = String(args[0] ?? "");
          let nx = false;
          let ttlMs: number | null = null;
          for (let i = 1; i < args.length; i++) {
            const flag = String(args[i]).toUpperCase();
            if (flag === "NX") nx = true;
            else if (flag === "EX") ttlMs = Number(args[++i]) * 1000;
            else throw new NearStoreError(`memory cap store: unsupported SET flag ${flag}`);
          }
          if (nx && this.live(key, now) !== undefined) return null;
          this.items.set(key, { value, expiresAt: ttlMs === null ? null : now + ttlMs });
          return "OK";
        }
        case "INCR":
        case "DECRBY": {
          const delta = op === "INCR" ? 1n : -BigInt(String(args[0] ?? "0"));
          const current = this.live(key, now);
          const next = (current ? BigInt(current.value) : 0n) + delta;
          this.items.set(key, { value: next.toString(), expiresAt: current?.expiresAt ?? null });
          return Number(next);
        }
        case "EXPIRE": {
          const current = this.live(key, now);
          if (!current) return 0;
          current.expiresAt = now + Number(args[0]) * 1000;
          return 1;
        }
        case "DEL": {
          const had = this.live(key, now) !== undefined;
          this.items.delete(key);
          return had ? 1 : 0;
        }
        default:
          throw new NearStoreError(`memory cap store: unsupported command ${op}`);
      }
    });
  }

  clear(): void {
    this.items.clear();
  }
}

const memoryStore = new MemoryCapStore();

/** Tests only: empty the in-process store. */
export function resetNearMemoryStoreForTests(): void {
  memoryStore.clear();
}

/** The cap store this process uses: Upstash when the service has a store, the in-process map when it has none. */
export function nearCapStoreFromEnv(): NearCapStore {
  const kv = kvConfigFromEnv();
  return kv ? upstashCapStore(kv) : memoryStore;
}

/* --------------------------------------- caps --------------------------------------- */

export type NearCapDecision = { ok: true } | { ok: false; code: CapCode; reason: string; retryAfterS: number };

/** Namespaced by rail and network, like every counter in lib/caps.ts, so the two Workers never share a day. */
function capKeys(network: string, senderId: string, nowMs: number): { cool: string; sender: string; global: string } {
  const day = dayKey(nowMs);
  return {
    cool: `near:${network}:cool:${senderId}`,
    sender: `near:${network}:day:${day}:sender:${senderId}`,
    global: `near:${network}:day:${day}:global`,
  };
}

function toCount(v: unknown): number {
  const n = v === null || v === undefined ? 0 : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function cooldownRefusal(limits: CapLimits, waitS: number): NearCapDecision {
  const wait = Math.max(1, Math.ceil(waitS));
  return { ok: false, code: "cooldown", reason: `one relay per sender every ${limits.senderCooldownS} s: try again in ${wait} s`, retryAfterS: wait };
}

function dayRefusal(code: "sender_daily" | "global_daily", limits: CapLimits, senderId: string, nowMs: number): NearCapDecision {
  return {
    ok: false,
    code,
    reason:
      code === "sender_daily"
        ? `daily cap reached for ${senderId}: ${limits.perSenderPerDay} relays per sender per day (UTC)`
        : `the relayer's daily cap of ${limits.globalPerDay} relays is used up for today (UTC)`,
    retryAfterS: secondsToDayEnd(nowMs),
  };
}

/** Read-only: would a relay for this sender pass right now? One pipeline, three GETs. Throws NearStoreError. */
export async function checkNearCaps(store: NearCapStore, limits: CapLimits, network: string, senderId: string, nowMs: number): Promise<NearCapDecision> {
  const k = capKeys(network, senderId, nowMs);
  const [cool, sender, global] = await store.pipeline([
    ["GET", k.cool],
    ["GET", k.sender],
    ["GET", k.global],
  ]);
  if (cool !== null && cool !== undefined && limits.senderCooldownS > 0) {
    const elapsedS = (nowMs - Number(cool)) / 1000;
    if (elapsedS >= 0 && elapsedS < limits.senderCooldownS) return cooldownRefusal(limits, limits.senderCooldownS - elapsedS);
  }
  if (toCount(sender) >= limits.perSenderPerDay) return dayRefusal("sender_daily", limits, senderId, nowMs);
  if (toCount(global) >= limits.globalPerDay) return dayRefusal("global_daily", limits, senderId, nowMs);
  return { ok: true };
}

/**
 * Count one relay for the sender, atomically: the cooldown is a SET NX (a second relay of the same
 * sender landing between the read and this write finds it taken), the day counters are INCRs. A
 * count that overshot its cap is given back in a second pipeline and refused, so the cap holds under
 * concurrency without a lock. Called after the pre-check and before the send, so a send that fails
 * still counts (the transaction may be on the network). Throws NearStoreError.
 */
export async function recordNearCap(store: NearCapStore, limits: CapLimits, network: string, senderId: string, nowMs: number): Promise<NearCapDecision> {
  const k = capKeys(network, senderId, nowMs);
  const dayTtl = secondsToDayEnd(nowMs) + 60;
  const withCooldown = limits.senderCooldownS > 0;
  const rows = await store.pipeline([
    ["GET", k.cool],
    ...(withCooldown ? [["SET", k.cool, String(nowMs), "NX", "EX", String(limits.senderCooldownS)]] : []),
    ["INCR", k.sender],
    ["EXPIRE", k.sender, String(dayTtl)],
    ["INCR", k.global],
    ["EXPIRE", k.global, String(dayTtl)],
  ]);
  const previousCool = rows[0];
  let setOk = withCooldown ? rows[1] === "OK" : true;
  const senderCount = toCount(rows[withCooldown ? 2 : 1]);
  const globalCount = toCount(rows[withCooldown ? 4 : 3]);
  const elapsedS = previousCool === null || previousCool === undefined ? Number.NaN : (nowMs - Number(previousCool)) / 1000;
  if (!setOk && Number.isFinite(elapsedS) && (elapsedS >= limits.senderCooldownS || elapsedS < 0)) {
    /* A stamp the read-only check already treats as spent (older than the window, or from a clock
       ahead of this one) whose key is still present: its TTL is the window, so this is the expiry
       boundary itself, or a store that outlived it. Replaced outright, so record agrees with check.
       Two relays of one sender meeting exactly there can both pass; the day counters still bind. */
    await store.pipeline([["SET", k.cool, String(nowMs), "EX", String(limits.senderCooldownS)]]);
    setOk = true;
  }
  let refusal: NearCapDecision | null = null;
  if (!setOk) {
    refusal = cooldownRefusal(limits, Math.max(1, limits.senderCooldownS - Math.max(0, elapsedS)));
  } else if (senderCount > limits.perSenderPerDay) {
    refusal = dayRefusal("sender_daily", limits, senderId, nowMs);
  } else if (globalCount > limits.globalPerDay) {
    refusal = dayRefusal("global_daily", limits, senderId, nowMs);
  }
  if (refusal) {
    // Give back what this call took; the cooldown only if this call set it.
    await store.pipeline([
      ["DECRBY", k.sender, "1"],
      ["DECRBY", k.global, "1"],
      ...(withCooldown && setOk ? [["DEL", k.cool]] : []),
    ]);
    return refusal;
  }
  return { ok: true };
}

export interface NearCapSnapshot {
  day: string;
  globalToday: number;
  limits: CapLimits;
  resetsInS: number;
}

/** Today's global count and the limits (GET /near/health). Throws NearStoreError. */
export async function nearCapSnapshot(store: NearCapStore, limits: CapLimits, network: string, nowMs: number): Promise<NearCapSnapshot> {
  const k = capKeys(network, "-", nowMs);
  const [global] = await store.pipeline([["GET", k.global]]);
  return { day: dayKey(nowMs), globalToday: toCount(global), limits, resetsInS: secondsToDayEnd(nowMs) };
}

/* --------------------------------------- relay --------------------------------------- */

/** A refusal with the HTTP status to answer. The Worker maps it to {reason, code[, retryAfterS]}. */
export class NearRelayRefusal extends Error {
  override name = "NearRelayRefusal";
  constructor(
    readonly status: 400 | 403 | 429 | 502 | 503,
    readonly code: string,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

export interface NearRelayOutcome {
  status: "success" | "failure";
  kind: RelayKind;
  /** Plain words: what happened on chain. */
  summary: string;
  /** The transaction's final execution status as the RPC reported it. */
  finalStatus: unknown;
  /** True when the escrow accepted the USDC and opened the link(s). */
  linkCreated?: boolean;
  /** USDC units the escrow kept (the ft_transfer_call return value). */
  usedAmount?: string;
  /** True when the escrow sent the USDC back to the funder. */
  reclaimed?: boolean;
  /** Every failed receipt, as readable text: an escrow refusal is surfaced here, not hidden in logs. */
  failures: string[];
  /** NEP-297 events emitted along the way. */
  events: unknown[];
  logs: string[];
}

export interface NearRelayResult {
  txHash: string;
  explorerUrl: string;
  outcome: NearRelayOutcome;
}

/** A SignedDelegate that decoded and whose signature verifies against its own key: what the Worker rate-limits on. */
export interface DecodedForRelay {
  sd: DecodedSignedDelegate;
  /** The signing key, "ed25519:..." (the per-key limiter bucket). */
  publicKey: string;
  senderId: string;
}

export interface NearRelayDeps {
  config: NearRelayerConfig;
  /** The relayer's secret key ("ed25519:<base58 of 64 bytes>"), the Worker secret. Never logged. */
  secret: string;
  rpc: NearRpc;
  store: NearCapStore;
  now?: () => number;
  log?: (line: string) => void;
  /** The polling after a send the RPC gave up waiting on; the suites shorten both. */
  pollMs?: number;
  maxPolls?: number;
}

export function explorerTxUrl(network: string, txHash: string): string {
  return network === "mainnet" ? `https://nearblocks.io/txns/${txHash}` : `https://testnet.nearblocks.io/txns/${txHash}`;
}

/** The one log line per decision: JSON, with the fields that are set, never the delegate bytes or a key. */
function decisionLine(now: number, fields: Record<string, unknown>): string {
  const clean: Record<string, unknown> = { at: new Date(now).toISOString(), route: "near/relay" };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = v;
  return JSON.stringify(clean);
}

/**
 * The offline half: canonical borsh (400 undecodable) and the delegate's own signature (403
 * signature). No store, no RPC. The Worker runs this BEFORE its rate limiter so the per-key bucket
 * is spent only by delegates the key really signed.
 */
export function decodeForRelay(signedDelegateBase64: string, log?: (line: string) => void, now = Date.now()): DecodedForRelay {
  const emit = log ?? ((line: string) => console.log(line));
  let sd: DecodedSignedDelegate;
  try {
    sd = decodeSignedDelegate(signedDelegateBase64);
  } catch (e) {
    const reason = (e as Error).message;
    emit(decisionLine(now, { decision: "refused", code: "undecodable", reason }));
    throw new NearRelayRefusal(400, "undecodable", reason);
  }
  const senderId = String(sd.delegateAction?.senderId ?? "");
  let publicKey = "";
  let verified = false;
  try {
    publicKey = toPublicKey(sd.delegateAction.publicKey).toString();
    verified = verifyDelegateSignature(sd);
  } catch {
    verified = false;
  }
  if (!verified) {
    const reason = "the delegate signature does not verify against its public_key";
    emit(decisionLine(now, { decision: "refused", sender: senderId, code: "signature", reason }));
    throw new NearRelayRefusal(403, "signature", reason);
  }
  return { sd, publicKey, senderId };
}

/** The block height, cached 2 s per RPC URL: a burst of refusals costs one read. */
const HEIGHT_CACHE_MS = 2_000;
const heightCache = new Map<string, { height: number; at: number }>();

async function blockHeight(rpc: NearRpc, now: number, fresh = false): Promise<number> {
  const hit = heightCache.get(rpc.url);
  if (!fresh && hit && now - hit.at >= 0 && now - hit.at < HEIGHT_CACHE_MS) return hit.height;
  const { height } = await rpc.viewBlock();
  heightCache.set(rpc.url, { height, at: now });
  return height;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) {
    const type = (e as { type?: unknown }).type;
    return typeof type === "string" && !e.message.includes(type) ? `${e.message} (${type})` : e.message;
  }
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * One RPC read so the relayer never pays for a delegate the protocol would reject: the sender must
 * own the key, the nonce must be above the key's, and a function-call key may not carry a deposit
 * (NEP-366 refuses that) nor call outside its own receiver and method list.
 */
async function preCheck(rpc: NearRpc, verdict: Allowed): Promise<void> {
  let key: { nonce: bigint; permission: unknown };
  try {
    key = await rpc.viewAccessKey(verdict.senderId, verdict.publicKey);
  } catch (e) {
    if (/does not exist|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|AccessKeyDoesNotExist|AccountDoesNotExist/i.test(messageOf(e))) {
      throw new NearRelayRefusal(403, "key", `${verdict.senderId} does not have the key ${verdict.publicKey} (or the account does not exist)`);
    }
    throw new NearRelayRefusal(502, "rpc", `could not read the sender's key: ${messageOf(e)}`);
  }
  if (verdict.nonce <= key.nonce) {
    throw new NearRelayRefusal(403, "nonce", `nonce ${verdict.nonce} is not above the key's current nonce ${key.nonce}: sign a fresh delegate`);
  }
  if (key.permission !== "FullAccess") {
    if (verdict.deposit > 0n) {
      throw new NearRelayRefusal(403, "key", "a function-call access key cannot delegate an action that attaches a deposit; sign with a full-access key");
    }
    const perm = (key.permission as { FunctionCall?: { receiver_id?: string; method_names?: string[] } } | null)?.FunctionCall;
    if (!perm) throw new NearRelayRefusal(403, "key", "the signing key has an unsupported permission type");
    if (perm.receiver_id !== verdict.receiverId) {
      throw new NearRelayRefusal(403, "key", `the function-call key is limited to ${perm.receiver_id}, not ${verdict.receiverId}`);
    }
    if (perm.method_names && perm.method_names.length > 0 && !perm.method_names.includes(verdict.method)) {
      throw new NearRelayRefusal(403, "key", `the function-call key may not call ${verdict.method}`);
    }
  }
}

/** The default polling after a send the RPC stopped waiting on: 12 x 2.5 s, as the reference relayer. */
const POLL_MS = 2_500;
const MAX_POLLS = 12;
let pollMsForTests: number | null = null;

/** Tests only: the pause between status polls when the caller sets none (the Worker never does). */
export function setNearPollMsForTests(ms: number | null): void {
  pollMsForTests = ms;
}
/** Subrequests kept free under each poll for what follows it (nothing today; one as headroom). */
const POLL_RESERVE = 1;

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: unknown; type?: unknown } | null)?.name;
  const type = (e as { type?: unknown } | null)?.type;
  return /timeout|timed out/i.test(messageOf(e)) || /timeout/i.test(String(name ?? "")) || /timeout/i.test(String(type ?? ""));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Build, sign and send the relayer's transaction: one `signedDelegate` action addressed to the
 * delegate's sender, from the relayer's own key and nonce. An InvalidNonce (two isolates relaying
 * at once) is retried twice with a fresh nonce. The delegate bytes go out exactly as they came in
 * (decodeSignedDelegate insisted on the canonical encoding).
 */
async function signAndSend(deps: NearRelayDeps, sd: DecodedSignedDelegate): Promise<{ txHash: string; response: unknown }> {
  const signer = KeyPairSigner.fromSecretKey(deps.secret as KeyPairString);
  const publicKey = await signer.getPublicKey();
  const action = actions.signedDelegate({
    delegateAction: sd.delegateAction as unknown as DelegateAction,
    signature: sd.signature as unknown as Signature,
  });
  const receiverId = sd.delegateAction.senderId;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const [accessKey, block] = await Promise.all([deps.rpc.viewAccessKey(deps.config.relayerAccountId, publicKey.toString()), deps.rpc.viewBlock()]);
    const nonce = accessKey.nonce + 1n;
    const tx = createTransaction(deps.config.relayerAccountId, publicKey, receiverId, nonce, [action], baseDecode(block.hash));
    const { txHash: hashBytes, signedTransaction } = await signer.signTransaction(tx);
    const txHash = baseEncode(hashBytes);
    try {
      const response = await sendFinal(deps, signedTransaction, txHash);
      return { txHash, response };
    } catch (e) {
      lastError = e;
      if (/InvalidNonce|nonce/i.test(messageOf(e)) && attempt < 2) continue;
      throw new Error(`${messageOf(e)} (tx ${txHash})`);
    }
  }
  throw new Error(messageOf(lastError));
}

async function sendFinal(deps: NearRelayDeps, signed: SignedTransaction, txHash: string): Promise<unknown> {
  try {
    return await deps.rpc.sendUntilFinal(signed);
  } catch (e) {
    if (!isTimeout(e)) throw e;
  }
  // The RPC gave up waiting but the transaction is in flight: poll its status, within the
  // subrequest budget of this request (lib/subrequests.ts).
  const pollMs = deps.pollMs ?? pollMsForTests ?? POLL_MS;
  const maxPolls = deps.maxPolls ?? MAX_POLLS;
  for (let i = 0; i < maxPolls && subrequestsLeft() > POLL_RESERVE; i++) {
    await sleep(pollMs);
    try {
      const status = await deps.rpc.txStatus(txHash, deps.config.relayerAccountId);
      if ((status as { final_execution_status?: string } | null)?.final_execution_status === "FINAL") return status;
    } catch {
      // keep polling
    }
  }
  throw new Error(`transaction ${txHash} was sent but its final status could not be read in time`);
}

/**
 * The whole pipeline past the offline half (decodeForRelay) and the Worker's limiter. Throws
 * NearRelayRefusal with the HTTP status to answer; anything else is an unexpected error.
 */
export async function relayNearHandler(decoded: DecodedForRelay, deps: NearRelayDeps): Promise<NearRelayResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const started = now();
  const { config, rpc, store } = deps;
  const sd = decoded.sd;

  let currentBlockHeight: number;
  try {
    currentBlockHeight = await blockHeight(rpc, started);
  } catch (e) {
    const reason = `the NEAR RPC could not be reached: ${messageOf(e)}`;
    log(decisionLine(now(), { decision: "refused", sender: decoded.senderId, code: "rpc", reason }));
    throw new NearRelayRefusal(502, "rpc", reason);
  }
  const verdict = evaluate(sd, { escrowId: config.escrowId, usdcId: config.usdcId, currentBlockHeight });
  const who = { sender: verdict.senderId, receiver: verdict.receiverId, method: verdict.method };
  if (!verdict.allow) {
    log(decisionLine(now(), { decision: "refused", ...who, code: verdict.code, reason: verdict.reason }));
    throw new NearRelayRefusal(403, verdict.code, verdict.reason);
  }

  const refuseStore = (e: unknown): never => {
    const reason = `the relayer's cap store did not answer, so nothing was relayed (${messageOf(e)})`;
    log(decisionLine(now(), { decision: "refused", ...who, code: "store_unavailable", reason }));
    throw new NearRelayRefusal(503, "store_unavailable", reason);
  };

  let cap: NearCapDecision;
  try {
    cap = await checkNearCaps(store, config.caps, config.network, verdict.senderId, now());
  } catch (e) {
    return refuseStore(e);
  }
  if (!cap.ok) {
    log(decisionLine(now(), { decision: "refused", ...who, code: cap.code, reason: cap.reason }));
    throw new NearRelayRefusal(429, cap.code, cap.reason, cap.retryAfterS);
  }

  try {
    await preCheck(rpc, verdict);
  } catch (e) {
    const err = e instanceof NearRelayRefusal ? e : new NearRelayRefusal(502, "rpc", `pre-check failed: ${messageOf(e)}`);
    log(decisionLine(now(), { decision: "refused", ...who, code: err.code, reason: err.message }));
    throw err;
  }

  let recorded: NearCapDecision;
  try {
    recorded = await recordNearCap(store, config.caps, config.network, verdict.senderId, now());
  } catch (e) {
    return refuseStore(e);
  }
  if (!recorded.ok) {
    log(decisionLine(now(), { decision: "refused", ...who, code: recorded.code, reason: recorded.reason }));
    throw new NearRelayRefusal(429, recorded.code, recorded.reason, recorded.retryAfterS);
  }

  let txHash = "";
  let response: unknown;
  try {
    ({ txHash, response } = await signAndSend(deps, sd));
  } catch (e) {
    const reason = `the relayer could not submit the transaction: ${messageOf(e)}`;
    log(decisionLine(now(), { decision: "allowed", ...who, kind: verdict.kind, status: "not_sent", reason }));
    throw new NearRelayRefusal(502, "submit_failed", reason);
  }
  const outcome = parseNearOutcome(response, verdict);
  if (!txHash) txHash = hashOf(response) ?? "";
  log(
    decisionLine(now(), {
      decision: "allowed",
      ...who,
      kind: verdict.kind,
      txHash,
      status: outcome.status,
      reason: outcome.status === "success" ? undefined : outcome.summary,
      ms: now() - started,
    }),
  );
  return { txHash, explorerUrl: explorerTxUrl(config.network, txHash), outcome };
}

/* -------------------------------------- health -------------------------------------- */

export interface NearHealthReport {
  ok: boolean;
  network: string;
  rpcUrl: string;
  blockHeight: number | null;
  relayer: {
    accountId: string;
    publicKey: string | null;
    balanceYocto: string | null;
    balanceNear: string | null;
    signerConfigured: boolean;
  };
  escrowId: string;
  usdcId: string;
  storage: "upstash" | "memory";
  caps: NearCapSnapshot | null;
  policy: string[];
  warnings: string[];
}

const YOCTO_PER_NEAR = 10n ** 24n;

/** A yoctoNEAR amount as a NEAR string with `decimals` places (truncated, never rounded up). */
export function formatNear(yocto: bigint, decimals = 4): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = yocto % YOCTO_PER_NEAR;
  if (decimals <= 0) return whole.toString();
  const digits = frac.toString().padStart(24, "0").slice(0, decimals).replace(/0+$/, "");
  return digits ? `${whole}.${digits}` : whole.toString();
}

/** The floor in yoctoNEAR for a NEAR_RELAYER_MIN_NEAR that may be fractional (up to 6 places). */
export function minNearYocto(minNear: number): bigint {
  return BigInt(Math.round(minNear * 1_000_000)) * 10n ** 18n;
}

/**
 * GET /near/health: live readings, no caching here (the Worker caches the report per isolate). `ok`
 * is false when anything a relay needs is missing or unreadable, and the Worker answers 503 then.
 */
export async function nearHealth(deps: Omit<NearRelayDeps, "secret"> & { secret: string | null }): Promise<NearHealthReport> {
  const now = deps.now ?? Date.now;
  const { config, rpc, store } = deps;
  const warnings: string[] = [];
  let height: number | null = null;
  try {
    height = await blockHeight(rpc, now(), true);
  } catch (e) {
    warnings.push(`RPC ${config.rpcUrl} is not answering: ${messageOf(e)}`);
  }
  let balanceYocto: string | null = null;
  let balanceNear: string | null = null;
  try {
    const { amountYocto } = await rpc.viewAccount(config.relayerAccountId);
    balanceYocto = amountYocto.toString();
    balanceNear = formatNear(amountYocto);
    if (amountYocto < minNearYocto(config.minNear)) warnings.push(`relayer balance ${balanceNear} NEAR is below the ${config.minNear} NEAR floor (NEAR_RELAYER_MIN_NEAR)`);
  } catch (e) {
    warnings.push(`relayer account ${config.relayerAccountId} could not be read: ${messageOf(e)}`);
  }
  let publicKey: string | null = null;
  if (deps.secret) {
    try {
      publicKey = (await KeyPairSigner.fromSecretKey(deps.secret as KeyPairString).getPublicKey()).toString();
    } catch {
      warnings.push("NEAR_RELAYER_PRIVATE_KEY is not a usable ed25519 secret key: /near/relay answers 503");
    }
  } else {
    warnings.push("no signing key configured (NEAR_RELAYER_PRIVATE_KEY): /near/relay answers 503");
  }
  let caps: NearCapSnapshot | null = null;
  try {
    caps = await nearCapSnapshot(store, config.caps, config.network, now());
  } catch (e) {
    warnings.push(`the cap store could not be read (${messageOf(e)}): /near/relay refuses while this lasts`);
  }
  return {
    ok: warnings.length === 0,
    network: config.network,
    rpcUrl: config.rpcUrl,
    blockHeight: height,
    relayer: { accountId: config.relayerAccountId, publicKey, balanceYocto, balanceNear, signerConfigured: Boolean(deps.secret) },
    escrowId: config.escrowId,
    usdcId: config.usdcId,
    storage: store.kind,
    caps,
    policy: describeNearPolicy(config).words,
    warnings,
  };
}

/* ---------------------------------- outcome parsing ---------------------------------- */

interface OutcomeLike {
  transaction?: { hash?: string };
  status?: unknown;
  final_execution_status?: string;
  transaction_outcome?: { id?: string; outcome?: { logs?: unknown; status?: unknown } };
  receipts_outcome?: Array<{ id?: string; outcome?: { logs?: unknown; status?: unknown; executor_id?: string } }>;
}

function hashOf(response: unknown): string | null {
  const h = (response as OutcomeLike | undefined)?.transaction?.hash;
  return typeof h === "string" ? h : null;
}

/**
 * What happened on chain, from the final execution outcome. The transaction itself can succeed
 * while the escrow refuses the transfer (the token contract then refunds the USDC); that is a
 * failure here, with the receipt's reason, so the client never reads a refund as a link.
 */
export function parseNearOutcome(response: unknown, verdict: Allowed): NearRelayOutcome {
  const r = (response ?? {}) as OutcomeLike;
  const logs: string[] = [];
  const failures: string[] = [];
  const collect = (label: string, o: { logs?: unknown; status?: unknown } | undefined) => {
    if (!o) return;
    if (Array.isArray(o.logs)) for (const l of o.logs) if (typeof l === "string") logs.push(l);
    const failure = failureText(o.status);
    if (failure) failures.push(`${label}: ${failure}`);
  };
  collect("transaction", r.transaction_outcome?.outcome);
  for (const ro of r.receipts_outcome ?? []) collect(`receipt ${ro.id ?? "?"} on ${ro.outcome?.executor_id ?? "?"}`, ro.outcome);
  const topFailure = failureText(r.status);
  if (topFailure && !failures.some((f) => f.endsWith(topFailure))) failures.push(`final: ${topFailure}`);

  const events: unknown[] = [];
  for (const l of logs) {
    if (l.startsWith("EVENT_JSON:")) {
      try {
        events.push(JSON.parse(l.slice("EVENT_JSON:".length)));
      } catch {
        // not JSON, kept as a log line only
      }
    }
  }
  const eventNames = events.map((e) => (e as { event?: string } | null)?.event).filter((n): n is string => typeof n === "string");
  const successText = successValueText(r.status);

  const base = { kind: verdict.kind, finalStatus: r.status ?? null, failures, events, logs };
  if (verdict.kind === "create_link") {
    let usedAmount: string | undefined;
    if (successText !== null) {
      try {
        const v: unknown = JSON.parse(successText);
        if (typeof v === "string") usedAmount = v;
      } catch {
        usedAmount = undefined;
      }
    }
    const linkCreated = failures.length === 0 && (usedAmount === verdict.amountUnits || eventNames.includes("drop_created"));
    const summary = linkCreated
      ? `link created: ${verdict.amountUnits} USDC units escrowed for ${verdict.linkPublicKeys.length} key(s)`
      : failures.length > 0
        ? `the escrow did not open the link (USDC refunded by the token contract if it moved): ${failures[0]}`
        : `the transaction ended without the escrow confirming the link (used amount ${usedAmount ?? "unknown"})`;
    return { ...base, status: linkCreated ? "success" : "failure", summary, linkCreated, usedAmount };
  }
  const reclaimed = failures.length === 0 && (successText === "true" || eventNames.includes("drop_reclaimed"));
  const summary = reclaimed
    ? `link ${verdict.linkPublicKeys[0] ?? ""} reclaimed: USDC returned to ${verdict.senderId}`
    : failures.length > 0
      ? `reclaim failed: ${failures[0]}`
      : "the transaction ended without the escrow confirming the reclaim";
  return { ...base, status: reclaimed ? "success" : "failure", summary, reclaimed };
}

function failureText(status: unknown): string | null {
  if (!status || typeof status !== "object" || !("Failure" in status)) return null;
  const failure = (status as { Failure: unknown }).Failure;
  const exec = (failure as { ActionError?: { kind?: { FunctionCallError?: { ExecutionError?: string } } } } | null)?.ActionError?.kind
    ?.FunctionCallError?.ExecutionError;
  if (typeof exec === "string") return exec;
  try {
    return JSON.stringify(failure);
  } catch {
    return String(failure);
  }
}

function successValueText(status: unknown): string | null {
  if (!status || typeof status !== "object" || !("SuccessValue" in status)) return null;
  const v = (status as { SuccessValue: unknown }).SuccessValue;
  if (typeof v !== "string") return null;
  try {
    return Buffer.from(v, "base64").toString("utf8");
  } catch {
    return null;
  }
}
