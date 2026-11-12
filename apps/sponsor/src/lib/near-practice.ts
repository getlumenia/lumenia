/**
 * Practice links on the NEAR rail (NEAR HACKATHON 2026, testnet): POST /near/practice-link on the
 * sponsor Worker.
 *
 * WHY THIS EXISTS. /try/send lets anyone make a money link from a shared practice balance. Until this
 * route, the browser held that balance's FULL-ACCESS key (it was inlined into the public bundle as a
 * NEXT_PUBLIC_ value), so anyone could read it and drain or delete the account. Now the Worker makes
 * the link itself, from the relayer account's own USDC, and the browser sends only what a link needs
 * to exist: the PUBLIC half of a key pair it generated. The link's secret never leaves the browser,
 * so this route can open a link but can never claim one.
 *
 * WHAT IT SIGNS, and nothing else: USDC.ft_transfer_call(receiver_id = the escrow, amount, msg
 * {"public_key","expires_in_s"[,"memo"]}) from the relayer account (NEAR_RELAYER_ACCOUNT_ID, key
 * NEAR_RELAYER_PRIVATE_KEY), with 1 yoctoNEAR and 100 Tgas, waited on until FINAL. The receiver, the
 * method, the deposit and the gas are constants here: a request chooses only the link's public key,
 * the amount (0.10 to 1.00 USDC), the life (600 s to 1 day) and an optional memo (64 bytes).
 *
 * THE ORDER, cheapest refusal first, as in lib/near-relay.ts:
 *   the body, offline (400) -> the caps, READ ONLY (429) -> the practice balance, one view (503
 *   practice_empty when it cannot cover the amount, 502 rpc when it cannot be read) -> the caps,
 *   RECORDED atomically (429 on a lost race) -> sign, send, wait FINAL (502 submit_failed) -> the
 *   escrow's outcome (200 with outcome.status success, or failure with the escrow's reason: the
 *   token contract has refunded the USDC then).
 * The balance is read before anything is recorded, so an empty pool burns nobody's allowance.
 *
 * CAPS, keyed by the caller's address collapsed the way the rate limiter does it (lib/rate-limit.ts
 * ipBucket: an IPv6 /64 is one caller): one practice link every 30 s, 10 per caller per UTC day,
 * 300 per UTC day in total (NEAR_PRACTICE_COOLDOWN_S, NEAR_PRACTICE_PER_IP_PER_DAY,
 * NEAR_PRACTICE_PER_DAY; NEAR_PRACTICE_PER_DAY=0 switches the route off). They live in the same
 * Upstash store as every other counter, through the relay's own check/record pair in its own
 * namespace (near:<network>:practice:...), with the same atomic record step and the same FAIL
 * CLOSED posture: a store that errors, stalls or answers nonsense refuses (503 store_unavailable).
 * The caller's address is a store key only: it is never logged and never echoed in an answer.
 *
 * WHAT IS NOT HERE. A practice link's funder on chain is the relayer account, so only the relayer's
 * key can take back one that expired unclaimed: the Worker's scheduled run does that
 * (lib/near-practice-sweep.ts), not a route. Testnet only, like
 * the rest of the rail: the Worker refuses the route off its testnet environment.
 */
import { actions, teraToGas } from "near-api-js";
import { isEd25519PublicKey } from "@lumenia/near/relayer/policy";
import type { CapLimits } from "@lumenia/near/relayer/caps";
import {
  NearRelayRefusal,
  checkNearCaps,
  explorerTxUrl,
  messageOf,
  parseNearOutcome,
  recordNearCap,
  signAndSendActions,
  type NearCapDecision,
  type NearCapStore,
  type NearRelayOutcome,
  type NearRelayerConfig,
  type NearRpc,
} from "./near-relay.js";
import { ipBucket } from "./rate-limit.js";

/* ------------------------------------ the rules ------------------------------------ */

/** The smallest practice link, in USDC units (6 decimals): 0.10 USDC, the escrow's own minimum. */
export const PRACTICE_MIN_UNITS = 100_000n;
/** The largest practice link: 1.00 USDC, so the shared balance lasts through judging. */
export const PRACTICE_MAX_UNITS = 1_000_000n;
/** A practice link lives from 10 minutes to 1 day; an expired one goes back to the balance (lib/near-practice-sweep.ts). */
export const PRACTICE_MIN_EXPIRY_S = 600;
export const PRACTICE_MAX_EXPIRY_S = 86_400;
/** A memo is stored on the public ledger with the link: short, and plain text. */
export const PRACTICE_MAX_MEMO_BYTES = 64;
/** The gas attached to the ft_transfer_call, as the relay policy allows for a link. */
export const PRACTICE_GAS_TGAS = 100;
/** The cap store namespace: near:<network>:practice:... */
export const PRACTICE_SCOPE = "practice";

/** The defaults of the three caps (the Worker's vars override them). */
export const DEFAULT_PRACTICE_CAPS: CapLimits = { perSenderPerDay: 10, globalPerDay: 300, senderCooldownS: 30 };

const ENV_NAMES = {
  perIpPerDay: "NEAR_PRACTICE_PER_IP_PER_DAY",
  perDay: "NEAR_PRACTICE_PER_DAY",
  cooldownS: "NEAR_PRACTICE_COOLDOWN_S",
} as const;

/** The practice route's own configuration: its caps, or why it cannot serve. A STATE, not a throw. */
export type PracticeConfigState =
  | { ok: true; limits: CapLimits }
  | { ok: false; code: "near_not_configured" | "practice_off"; reason: string };

function readCap(env: Record<string, string | undefined>, name: string, fallback: number): number | string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return `${name} must be a non-negative integer, got "${raw}"`;
  return n;
}

export function practiceConfigFromEnv(env: Record<string, string | undefined> = process.env): PracticeConfigState {
  const perSenderPerDay = readCap(env, ENV_NAMES.perIpPerDay, DEFAULT_PRACTICE_CAPS.perSenderPerDay);
  const globalPerDay = readCap(env, ENV_NAMES.perDay, DEFAULT_PRACTICE_CAPS.globalPerDay);
  const senderCooldownS = readCap(env, ENV_NAMES.cooldownS, DEFAULT_PRACTICE_CAPS.senderCooldownS);
  for (const v of [perSenderPerDay, globalPerDay, senderCooldownS]) {
    if (typeof v === "string") return { ok: false, code: "near_not_configured", reason: v };
  }
  if (globalPerDay === 0 || perSenderPerDay === 0) {
    return { ok: false, code: "practice_off", reason: `practice links are switched off on this Worker (${ENV_NAMES.perDay} or ${ENV_NAMES.perIpPerDay} is 0)` };
  }
  return { ok: true, limits: { perSenderPerDay: perSenderPerDay as number, globalPerDay: globalPerDay as number, senderCooldownS: senderCooldownS as number } };
}

/* ------------------------------------ the request ------------------------------------ */

/** A practice link request that passed every offline rule. */
export interface PracticeRequest {
  /** The link's public key, "ed25519:<base58 of 32 bytes>". Its secret stays in the browser. */
  publicKey: string;
  /** USDC units (6 decimals) as a decimal string, the ft_transfer_call amount. */
  amountUnits: string;
  /** The amount as the caller wrote it, normalised to two decimals at least ("1.00"). */
  amountUsdc: string;
  expiresInS: number;
  /** Trimmed, non-empty, at most PRACTICE_MAX_MEMO_BYTES; absent when none was given. */
  memo?: string;
}

export type PracticeParse = { ok: true; request: PracticeRequest } | { ok: false; code: "bad_request" | "public_key" | "amount" | "expiry" | "memo"; reason: string };

const FIELDS = ["publicKey", "amountUsdc", "expiresInS", "memo"];
const USDC_DECIMAL = /^(\d{1,7})(?:\.(\d{1,6}))?$/;
// Control characters have no place in a memo shown on a public ledger and in a log line.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function unitsToUsdc(units: bigint): string {
  const whole = units / 1_000_000n;
  let frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
}

/**
 * The body, judged offline: exactly {publicKey, amountUsdc, expiresInS, memo?}, nothing else. An
 * amount is a decimal STRING ("1.00"), never a JSON number, so no float ever touches it.
 */
export function parsePracticeRequest(body: unknown): PracticeParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "bad_request", reason: 'the body must be a JSON object: {"publicKey","amountUsdc","expiresInS","memo"?}' };
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !FIELDS.includes(k));
  if (unknown.length > 0) return { ok: false, code: "bad_request", reason: `unknown field(s): ${unknown.slice(0, 5).join(", ")}` };

  if (!isEd25519PublicKey(b.publicKey)) {
    return { ok: false, code: "public_key", reason: 'publicKey must be the link\'s public key, "ed25519:<base58 of 32 bytes>" (never its secret)' };
  }
  const publicKey = b.publicKey;

  if (typeof b.amountUsdc !== "string") return { ok: false, code: "amount", reason: 'amountUsdc must be a decimal string, like "1.00"' };
  const m = USDC_DECIMAL.exec(b.amountUsdc.trim());
  if (!m) return { ok: false, code: "amount", reason: 'amountUsdc must be a decimal string with at most 6 decimals, like "1.00"' };
  const units = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  if (units < PRACTICE_MIN_UNITS || units > PRACTICE_MAX_UNITS) {
    return { ok: false, code: "amount", reason: `a practice link is ${unitsToUsdc(PRACTICE_MIN_UNITS)} to ${unitsToUsdc(PRACTICE_MAX_UNITS)} USDC` };
  }

  const expiresInS = b.expiresInS;
  if (typeof expiresInS !== "number" || !Number.isInteger(expiresInS) || expiresInS < PRACTICE_MIN_EXPIRY_S || expiresInS > PRACTICE_MAX_EXPIRY_S) {
    return { ok: false, code: "expiry", reason: `expiresInS must be a whole number of seconds from ${PRACTICE_MIN_EXPIRY_S} to ${PRACTICE_MAX_EXPIRY_S} (10 minutes to 1 day)` };
  }

  let memo: string | undefined;
  if (b.memo !== undefined && b.memo !== null) {
    if (typeof b.memo !== "string") return { ok: false, code: "memo", reason: "memo must be a string" };
    const trimmed = b.memo.trim();
    if (CONTROL.test(trimmed)) return { ok: false, code: "memo", reason: "memo must be plain text, without control characters" };
    if (new TextEncoder().encode(trimmed).length > PRACTICE_MAX_MEMO_BYTES) {
      return { ok: false, code: "memo", reason: `memo is longer than ${PRACTICE_MAX_MEMO_BYTES} bytes` };
    }
    if (trimmed !== "") memo = trimmed;
  }

  return { ok: true, request: { publicKey, amountUnits: units.toString(), amountUsdc: unitsToUsdc(units), expiresInS, ...(memo ? { memo } : {}) } };
}

/** The escrow's single-link msg, in the shape the contract and the relay policy read. */
export function practiceMsg(req: PracticeRequest): string {
  return JSON.stringify({ public_key: req.publicKey, expires_in_s: req.expiresInS, ...(req.memo ? { memo: req.memo } : {}) });
}

/* ------------------------------------ the handler ------------------------------------ */

export interface PracticeDeps {
  config: NearRelayerConfig;
  /** The relayer's secret key, the Worker secret. Never logged. */
  secret: string;
  rpc: NearRpc;
  store: NearCapStore;
  limits: CapLimits;
  now?: () => number;
  log?: (line: string) => void;
  pollMs?: number;
  maxPolls?: number;
}

export interface PracticeLinkResult {
  txHash: string;
  explorerUrl: string;
  /** The account that funded the link on chain (the relayer account): the drop's `funder`. */
  funderId: string;
  outcome: NearRelayOutcome;
}

/** The one log line per decision: JSON, never the caller's address, the relayer's key or a body. */
function decisionLine(now: number, fields: Record<string, unknown>): string {
  const clean: Record<string, unknown> = { at: new Date(now).toISOString(), route: "near/practice-link" };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = v;
  return JSON.stringify(clean);
}

/** A cap refusal in the practice route's own words (the relay's speak of relays and senders). */
function practiceCapRefusal(d: Extract<NearCapDecision, { ok: false }>, limits: CapLimits): NearRelayRefusal {
  if (d.code === "cooldown") {
    return new NearRelayRefusal(429, "cooldown", `one practice link every ${limits.senderCooldownS} s from one connection: try again in ${d.retryAfterS} s`, d.retryAfterS);
  }
  if (d.code === "sender_daily") {
    return new NearRelayRefusal(429, "ip_daily", `this connection has made its ${limits.perSenderPerDay} practice links for today (UTC)`, d.retryAfterS);
  }
  return new NearRelayRefusal(429, "global_daily", `the practice balance has made its ${limits.globalPerDay} links for today (UTC)`, d.retryAfterS);
}

/**
 * The whole route past the Worker's own gates (network, configuration, kill switch). Throws
 * NearRelayRefusal with the HTTP status to answer; anything else is an unexpected error.
 */
export async function practiceLinkHandler(body: unknown, callerIp: string, deps: PracticeDeps): Promise<PracticeLinkResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const started = now();
  const { config, rpc, store, limits } = deps;

  const parsed = parsePracticeRequest(body);
  if (!parsed.ok) {
    log(decisionLine(now(), { decision: "refused", code: parsed.code, reason: parsed.reason }));
    throw new NearRelayRefusal(400, parsed.code, parsed.reason);
  }
  const req = parsed.request;
  const who = { publicKey: req.publicKey, amount: req.amountUsdc, expiresInS: req.expiresInS };
  const refuse = (e: NearRelayRefusal): never => {
    log(decisionLine(now(), { decision: "refused", ...who, code: e.code, reason: e.message }));
    throw e;
  };
  const refuseStore = (e: unknown): never =>
    refuse(new NearRelayRefusal(503, "store_unavailable", `the cap store did not answer, so no practice link was made (${messageOf(e)})`));
  const caller = ipBucket(callerIp.trim() === "" ? "unknown" : callerIp.trim());

  let cap: NearCapDecision;
  try {
    cap = await checkNearCaps(store, limits, config.network, caller, now(), PRACTICE_SCOPE);
  } catch (e) {
    return refuseStore(e);
  }
  if (!cap.ok) return refuse(practiceCapRefusal(cap, limits));

  if (rpc.viewFtBalance) {
    let balance: bigint;
    try {
      balance = await rpc.viewFtBalance(config.usdcId, config.relayerAccountId);
    } catch (e) {
      return refuse(new NearRelayRefusal(502, "rpc", `the practice balance could not be read: ${messageOf(e)}`));
    }
    if (balance < BigInt(req.amountUnits)) {
      return refuse(new NearRelayRefusal(503, "practice_empty", `the practice balance holds ${unitsToUsdc(balance)} USDC, less than the ${req.amountUsdc} asked for`));
    }
  }

  let recorded: NearCapDecision;
  try {
    recorded = await recordNearCap(store, limits, config.network, caller, now(), PRACTICE_SCOPE);
  } catch (e) {
    return refuseStore(e);
  }
  if (!recorded.ok) return refuse(practiceCapRefusal(recorded, limits));

  /* From here the caps are spent: a send that fails still counts, because the transaction may be on
     the network (the relay's rule). The escrow refuses a public key it already holds, so a retry of
     the same link can never open it twice. */
  const action = actions.functionCall(
    "ft_transfer_call",
    { receiver_id: config.escrowId, amount: req.amountUnits, msg: practiceMsg(req) },
    teraToGas(PRACTICE_GAS_TGAS),
    1n,
  );
  let txHash: string;
  let response: unknown;
  try {
    ({ txHash, response } = await signAndSendActions(deps, config.usdcId, [action]));
  } catch (e) {
    const reason = `the practice link could not be submitted: ${messageOf(e)}`;
    log(decisionLine(now(), { decision: "allowed", ...who, status: "not_sent", reason }));
    throw new NearRelayRefusal(502, "submit_failed", reason);
  }
  const outcome = parseNearOutcome(response, {
    kind: "create_link",
    senderId: config.relayerAccountId,
    amountUnits: req.amountUnits,
    linkPublicKeys: [req.publicKey],
  });
  log(
    decisionLine(now(), {
      decision: "allowed",
      ...who,
      txHash,
      status: outcome.status,
      reason: outcome.status === "success" ? undefined : outcome.summary,
      ms: now() - started,
    }),
  );
  return { txHash, explorerUrl: explorerTxUrl(config.network, txHash), funderId: config.relayerAccountId, outcome };
}
