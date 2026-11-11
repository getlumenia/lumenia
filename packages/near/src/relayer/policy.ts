// The relayer's whole allowlist, as pure functions with no network access.
//
// A NEP-366 SignedDelegate arrives as base64 borsh. `evaluate` decodes it and
// answers one question: may the relayer pay the gas (and the 1 yoctoNEAR) for
// exactly this delegate? Two shapes are allowed, nothing else:
//
//   1. receiver_id == USDC contract, one FunctionCall `ft_transfer_call` whose
//      args send the USDC to the Lumenia escrow with a link message (one link
//      key or a batch of link keys, expiry 1 hour to 7 days), deposit exactly
//      1 yoctoNEAR, gas at most 100 Tgas. This creates a Lumenia link.
//   2. receiver_id == escrow, one FunctionCall `reclaim` with no deposit and
//      at most 100 Tgas. This lets a funder with no NEAR take an expired link
//      back.
//
// The delegate must also expire within BLOCK_WINDOW blocks of the current
// height, carry a valid sender account id, and its signature must verify
// against its own public key (so nobody can spend a stranger's daily cap or
// the relayer's NEAR by forging a sender id).
import { sha256 } from "@noble/hashes/sha2.js";
import { deserialize } from "borsh";
import {
  KeyType,
  PublicKey,
  SCHEMA,
  base64Decode,
  baseDecode,
  encodeDelegateAction,
  encodeSignedDelegate,
  type DelegateAction,
  type SignedDelegate,
} from "near-api-js";

export const TGAS = 1_000_000_000_000n;
/** Most gas a relayed call may ask for. */
export const MAX_GAS = 100n * TGAS;
/** A delegate may not be valid for longer than this many blocks from now (about 10 minutes). */
export const BLOCK_WINDOW = 600;
/** Link life accepted in the msg, in seconds (1 hour to 7 days). */
export const MIN_EXPIRY_S = 3_600;
export const MAX_EXPIRY_S = 604_800;
/** The escrow stores at most this many memo bytes per drop. */
export const MAX_MEMO_BYTES = 256;
/** Largest batch msg the policy accepts. */
export const MAX_DROPS_PER_MSG = 100;
/** Function-call args larger than this are refused before parsing. */
export const MAX_ARGS_BYTES = 16 * 1024;
const U128_MAX = (1n << 128n) - 1n;
/** NEP-366: a delegate nonce may not exceed max_block_height * 1e6. */
const NONCE_PER_BLOCK = 1_000_000n;

export interface PolicyConfig {
  /** The Lumenia escrow contract (lumenia-near.testnet). */
  escrowId: string;
  /** The NEP-141 USDC contract the escrow accepts. */
  usdcId: string;
}

export interface PolicyContext extends PolicyConfig {
  /** The chain's current block height (the caller fetches it; the policy stays offline). */
  currentBlockHeight: bigint | number;
}

export type RelayKind = "create_link" | "reclaim";

export type RefusalCode =
  | "undecodable"
  | "sender"
  | "receiver"
  | "key"
  | "expiry"
  | "nonce"
  | "actions"
  | "nesting"
  | "action_type"
  | "method"
  | "deposit"
  | "gas"
  | "args"
  | "msg"
  | "signature";

export interface Allowed {
  allow: true;
  kind: RelayKind;
  senderId: string;
  receiverId: string;
  method: string;
  /** The sender's signing key in "ed25519:..." form. */
  publicKey: string;
  nonce: bigint;
  maxBlockHeight: bigint;
  gas: bigint;
  deposit: bigint;
  /** USDC units (6 decimals) moved into the escrow; absent for a reclaim. */
  amountUnits?: string;
  /** Link life requested; absent for a reclaim. */
  expiresInS?: number;
  /** The link key(s) created, or the one reclaimed. */
  linkPublicKeys: string[];
}

export interface Refused {
  allow: false;
  code: RefusalCode;
  reason: string;
  senderId?: string;
  receiverId?: string;
  method?: string;
}

export type Verdict = Allowed | Refused;

// ---------------------------------------------------------------------------
// The decoded shape. borsh v2 returns plain objects whose enum values are
// one-key objects; near-api-js class instances have the same structure, so
// both are accepted everywhere below.
// ---------------------------------------------------------------------------

type Bytes = ArrayLike<number>;

export interface DecodedPublicKey {
  ed25519Key?: { data: Bytes };
  secp256k1Key?: { data: Bytes };
  mlDsa65Key?: { data: Bytes };
}

export interface DecodedFunctionCall {
  methodName: string;
  args: Bytes;
  gas: bigint;
  deposit: bigint;
}

export interface DecodedAction {
  functionCall?: DecodedFunctionCall;
  [variant: string]: unknown;
}

export interface DecodedDelegateAction {
  senderId: string;
  receiverId: string;
  actions: DecodedAction[];
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: DecodedPublicKey;
}

export interface DecodedSignature {
  ed25519Signature?: { data: Bytes };
  secp256k1Signature?: { data: Bytes };
  mlDsa65Signature?: { data: Bytes };
}

export interface DecodedSignedDelegate {
  delegateAction: DecodedDelegateAction;
  signature: DecodedSignature;
}

export class PolicyDecodeError extends Error {
  override name = "PolicyDecodeError";
}

/** Borsh-decode a SignedDelegate from bytes or a base64 string. Throws PolicyDecodeError. */
export function decodeSignedDelegate(input: Uint8Array | string): DecodedSignedDelegate {
  let bytes: Uint8Array;
  try {
    bytes = typeof input === "string" ? base64Decode(input.trim()) : input;
  } catch (e) {
    throw new PolicyDecodeError(`signedDelegate is not valid base64 (${messageOf(e)})`);
  }
  if (bytes.length === 0) throw new PolicyDecodeError("signedDelegate is empty");
  let decoded: DecodedSignedDelegate;
  try {
    decoded = deserialize(SCHEMA.SignedDelegate, bytes) as unknown as DecodedSignedDelegate;
    if (!decoded || typeof decoded !== "object" || !decoded.delegateAction) {
      throw new Error("missing delegateAction");
    }
  } catch (e) {
    throw new PolicyDecodeError(`signedDelegate is not a borsh SignedDelegate (${messageOf(e)})`);
  }
  // borsh-js does not complain about bytes left over after the struct, so the
  // relayer insists on the canonical encoding: what it would send must be
  // exactly what it received.
  let again: Uint8Array;
  try {
    again = encodeSignedDelegate(decoded as unknown as SignedDelegate);
  } catch (e) {
    throw new PolicyDecodeError(`signedDelegate does not re-encode (${messageOf(e)})`);
  }
  if (again.length !== bytes.length || !again.every((b, i) => b === bytes[i])) {
    throw new PolicyDecodeError(
      `signedDelegate is not canonical borsh (${bytes.length} bytes received, ${again.length} bytes re-encoded)`,
    );
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

export function evaluate(
  input: SignedDelegate | DecodedSignedDelegate | Uint8Array | string,
  ctx: PolicyContext,
): Verdict {
  let sd: DecodedSignedDelegate;
  if (typeof input === "string" || input instanceof Uint8Array) {
    try {
      sd = decodeSignedDelegate(input);
    } catch (e) {
      return refuse("undecodable", messageOf(e));
    }
  } else {
    sd = input as unknown as DecodedSignedDelegate;
  }
  const da = sd?.delegateAction;
  if (!da || typeof da !== "object") return refuse("undecodable", "delegateAction is missing");

  const senderId = String(da.senderId ?? "");
  const receiverId = String(da.receiverId ?? "");
  const who = { senderId, receiverId };
  if (!isValidAccountId(senderId)) {
    return refuse("sender", `sender_id "${senderId}" is not a valid NEAR account id`, who);
  }
  if (!isValidAccountId(receiverId)) {
    return refuse("receiver", `receiver_id "${receiverId}" is not a valid NEAR account id`, who);
  }

  let publicKey: PublicKey;
  try {
    publicKey = toPublicKey(da.publicKey);
  } catch (e) {
    return refuse("key", `public_key is not usable: ${messageOf(e)}`, who);
  }

  // Validity window.
  const now = BigInt(ctx.currentBlockHeight);
  const maxBlockHeight = toBigInt(da.maxBlockHeight);
  if (maxBlockHeight === null) return refuse("expiry", "max_block_height is not a number", who);
  if (maxBlockHeight <= now) {
    return refuse(
      "expiry",
      `max_block_height ${maxBlockHeight} is not above the current height ${now}: the delegate has expired`,
      who,
    );
  }
  if (maxBlockHeight > now + BigInt(BLOCK_WINDOW)) {
    return refuse(
      "expiry",
      `max_block_height ${maxBlockHeight} is more than ${BLOCK_WINDOW} blocks ahead of the current height ${now}`,
      who,
    );
  }
  const nonce = toBigInt(da.nonce);
  if (nonce === null || nonce <= 0n) return refuse("nonce", "nonce must be a positive integer", who);
  if (nonce > maxBlockHeight * NONCE_PER_BLOCK) {
    return refuse("nonce", `nonce ${nonce} is above the protocol bound max_block_height * 1e6`, who);
  }

  // Exactly one plain FunctionCall.
  if (!Array.isArray(da.actions)) return refuse("actions", "actions is not a list", who);
  if (da.actions.length !== 1) {
    return refuse("actions", `exactly one action is required, got ${da.actions.length}`, who);
  }
  const action = da.actions[0];
  if (!action || typeof action !== "object") return refuse("actions", "the action is empty", who);
  if ("signedDelegate" in action || "delegate" in action) {
    return refuse("nesting", "nested delegate actions are not allowed", who);
  }
  const fc = action.functionCall;
  if (!fc || typeof fc !== "object") {
    const variant = Object.keys(action)[0] ?? "unknown";
    return refuse("action_type", `only FunctionCall actions are relayed, got ${variant}`, who);
  }
  const method = String(fc.methodName ?? "");
  const what = { ...who, method };
  const gas = toBigInt(fc.gas);
  const deposit = toBigInt(fc.deposit);
  if (gas === null || gas <= 0n || gas > MAX_GAS) {
    return refuse("gas", `gas ${formatTgas(gas)} is outside the allowed range (0, 100] Tgas`, what);
  }
  if (deposit === null || deposit < 0n) return refuse("deposit", "deposit is not a number", what);

  let args: Record<string, unknown>;
  try {
    args = parseArgs(fc.args);
  } catch (e) {
    return refuse("args", `function call args must be a JSON object: ${messageOf(e)}`, what);
  }

  let kind: RelayKind;
  let detail: { amountUnits?: string; expiresInS?: number; linkPublicKeys: string[] };
  if (receiverId === ctx.usdcId) {
    if (method !== "ft_transfer_call") {
      return refuse("method", `method "${method}" on the USDC contract is not allowed (only ft_transfer_call)`, what);
    }
    if (deposit !== 1n) {
      return refuse("deposit", `ft_transfer_call must attach exactly 1 yoctoNEAR, got ${deposit}`, what);
    }
    const r = checkTransferCallArgs(args, ctx);
    if (!r.ok) return refuse(r.code, r.reason, what);
    kind = "create_link";
    detail = { amountUnits: r.amountUnits, expiresInS: r.expiresInS, linkPublicKeys: r.linkPublicKeys };
  } else if (receiverId === ctx.escrowId) {
    if (method !== "reclaim") {
      return refuse("method", `method "${method}" on the escrow is not allowed (only reclaim)`, what);
    }
    if (deposit !== 0n) {
      return refuse("deposit", `reclaim must attach no deposit, got ${deposit} yoctoNEAR`, what);
    }
    const r = checkReclaimArgs(args);
    if (!r.ok) return refuse(r.code, r.reason, what);
    kind = "reclaim";
    detail = { linkPublicKeys: r.linkPublicKeys };
  } else {
    return refuse(
      "receiver",
      `receiver "${receiverId}" is neither the USDC contract (${ctx.usdcId}) nor the escrow (${ctx.escrowId})`,
      what,
    );
  }

  // The signature last: it is the only expensive check.
  let signatureOk = false;
  try {
    signatureOk = verifyDelegateSignature(sd, publicKey);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return refuse("signature", "the delegate signature does not verify against its public_key", what);
  }

  return {
    allow: true,
    kind,
    senderId,
    receiverId,
    method,
    publicKey: publicKey.toString(),
    nonce,
    maxBlockHeight,
    gas,
    deposit,
    ...detail,
  };
}

// ---------------------------------------------------------------------------
// Argument checks
// ---------------------------------------------------------------------------

type ArgCheck<T> = ({ ok: true } & T) | { ok: false; code: RefusalCode; reason: string };

function checkTransferCallArgs(
  args: Record<string, unknown>,
  ctx: PolicyConfig,
): ArgCheck<{ amountUnits: string; expiresInS: number; linkPublicKeys: string[] }> {
  const unknown = Object.keys(args).filter((k) => !["receiver_id", "amount", "msg", "memo"].includes(k));
  if (unknown.length > 0) {
    return { ok: false, code: "args", reason: `ft_transfer_call args carry unknown fields: ${unknown.join(", ")}` };
  }
  if (args.receiver_id !== ctx.escrowId) {
    return {
      ok: false,
      code: "receiver",
      reason: `ft_transfer_call receiver_id must be the escrow ${ctx.escrowId}, got ${JSON.stringify(args.receiver_id ?? null)}`,
    };
  }
  const amount = parseU128(args.amount);
  if (amount === null || amount <= 0n) {
    return { ok: false, code: "args", reason: "amount must be a positive integer string of USDC units" };
  }
  if (args.memo !== undefined && args.memo !== null) {
    const memoErr = checkMemo(args.memo, "ft_transfer_call memo");
    if (memoErr) return { ok: false, code: "args", reason: memoErr };
  }
  if (typeof args.msg !== "string") {
    return { ok: false, code: "msg", reason: "msg must be a string holding the Lumenia link message" };
  }
  const msg = checkLinkMsg(args.msg);
  if (!msg.ok) return msg;
  return { ok: true, amountUnits: amount.toString(), expiresInS: msg.expiresInS, linkPublicKeys: msg.linkPublicKeys };
}

/**
 * Accepts the two link message shapes:
 *   {"public_key":"ed25519:...","expires_in_s":N,"memo":"optional"}
 *   {"drops":[<key or {public_key,amount?,memo?}>, ...],"expires_in_s":N,"memo":"optional"}
 */
export function checkLinkMsg(text: string): ArgCheck<{ expiresInS: number; linkPublicKeys: string[] }> {
  const bad = (why: string): ArgCheck<never> => ({
    ok: false,
    code: "msg",
    reason: `msg is not a Lumenia link message: ${why}`,
  });
  if (text.length > 8 * 1024) return bad("longer than 8 KB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return bad(`not JSON (${messageOf(e)})`);
  }
  if (!isPlainObject(parsed)) return bad("not a JSON object");

  const expiresInS = parsed.expires_in_s;
  if (typeof expiresInS !== "number" || !Number.isInteger(expiresInS)) {
    return bad("expires_in_s must be an integer number of seconds");
  }
  if (expiresInS < MIN_EXPIRY_S || expiresInS > MAX_EXPIRY_S) {
    return bad(`expires_in_s ${expiresInS} is outside ${MIN_EXPIRY_S}..${MAX_EXPIRY_S} (1 hour to 7 days)`);
  }
  if (parsed.memo !== undefined && parsed.memo !== null) {
    const memoErr = checkMemo(parsed.memo, "memo");
    if (memoErr) return bad(memoErr);
  }

  if ("drops" in parsed) {
    const unknown = Object.keys(parsed).filter((k) => !["drops", "expires_in_s", "memo"].includes(k));
    if (unknown.length > 0) return bad(`unknown fields: ${unknown.join(", ")}`);
    const drops = parsed.drops;
    if (!Array.isArray(drops) || drops.length === 0) return bad("drops must be a non-empty list");
    if (drops.length > MAX_DROPS_PER_MSG) return bad(`drops has ${drops.length} entries, the limit is ${MAX_DROPS_PER_MSG}`);
    const keys: string[] = [];
    for (const [i, d] of drops.entries()) {
      let key: unknown;
      if (typeof d === "string") {
        key = d;
      } else if (isPlainObject(d)) {
        const extra = Object.keys(d).filter((k) => !["public_key", "amount", "memo"].includes(k));
        if (extra.length > 0) return bad(`drops[${i}] has unknown fields: ${extra.join(", ")}`);
        key = d.public_key;
        if (d.amount !== undefined) {
          const a = parseU128(d.amount);
          if (a === null || a <= 0n) return bad(`drops[${i}].amount must be a positive integer string`);
        }
        if (d.memo !== undefined && d.memo !== null) {
          const memoErr = checkMemo(d.memo, `drops[${i}].memo`);
          if (memoErr) return bad(memoErr);
        }
      } else {
        return bad(`drops[${i}] must be a key string or an object with public_key`);
      }
      if (!isEd25519PublicKey(key)) return bad(`drops[${i}].public_key must be an "ed25519:" public key`);
      if (keys.includes(key)) return bad(`drops[${i}].public_key repeats an earlier key`);
      keys.push(key);
    }
    return { ok: true, expiresInS, linkPublicKeys: keys };
  }

  const unknown = Object.keys(parsed).filter((k) => !["public_key", "expires_in_s", "memo"].includes(k));
  if (unknown.length > 0) return bad(`unknown fields: ${unknown.join(", ")}`);
  if (!isEd25519PublicKey(parsed.public_key)) return bad('public_key must be an "ed25519:" public key');
  return { ok: true, expiresInS, linkPublicKeys: [parsed.public_key] };
}

function checkReclaimArgs(args: Record<string, unknown>): ArgCheck<{ linkPublicKeys: string[] }> {
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== "public_key") {
    return { ok: false, code: "args", reason: "reclaim args must be exactly {public_key}" };
  }
  if (!isEd25519PublicKey(args.public_key)) {
    return { ok: false, code: "args", reason: 'reclaim public_key must be an "ed25519:" public key' };
  }
  return { ok: true, linkPublicKeys: [args.public_key] };
}

function checkMemo(memo: unknown, label: string): string | null {
  if (typeof memo !== "string") return `${label} must be a string`;
  if (utf8Length(memo) > MAX_MEMO_BYTES) return `${label} is longer than ${MAX_MEMO_BYTES} bytes`;
  return null;
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/** True when the delegate's signature verifies against its own public_key. */
export function verifyDelegateSignature(sd: DecodedSignedDelegate, publicKey?: PublicKey): boolean {
  const pk = publicKey ?? toPublicKey(sd.delegateAction.publicKey);
  const sig = signatureBytes(sd.signature);
  if (!sig) return false;
  const message = encodeDelegateAction(sd.delegateAction as unknown as DelegateAction);
  return pk.verify(sha256(message), sig);
}

function signatureBytes(sig: DecodedSignature | undefined): Uint8Array | null {
  if (!sig || typeof sig !== "object") return null;
  const v = sig.ed25519Signature ?? sig.secp256k1Signature ?? sig.mlDsa65Signature;
  if (!v || !v.data) return null;
  return Uint8Array.from(v.data);
}

/** Build a near-api-js PublicKey from the decoded enum (or pass an instance through). */
export function toPublicKey(pk: DecodedPublicKey | PublicKey): PublicKey {
  if (pk instanceof PublicKey) return pk;
  if (!pk || typeof pk !== "object") throw new Error("public_key is missing");
  if (pk.ed25519Key) return new PublicKey({ keyType: KeyType.ED25519, data: Uint8Array.from(pk.ed25519Key.data) });
  if (pk.secp256k1Key) {
    return new PublicKey({ keyType: KeyType.SECP256K1, data: Uint8Array.from(pk.secp256k1Key.data) });
  }
  if (pk.mlDsa65Key) return new PublicKey({ keyType: KeyType.MLDSA65, data: Uint8Array.from(pk.mlDsa65Key.data) });
  throw new Error("unknown key type");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** NEAR account id rules: 2 to 64 chars, lowercase alphanumerics, separators between parts. */
export function isValidAccountId(id: unknown): id is string {
  return typeof id === "string" && id.length >= 2 && id.length <= 64 && ACCOUNT_ID_RE.test(id);
}

/** "ed25519:<base58 of 32 bytes>" and nothing else. */
export function isEd25519PublicKey(key: unknown): key is string {
  if (typeof key !== "string" || !key.startsWith("ed25519:")) return false;
  const body = key.slice("ed25519:".length);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(body)) return false;
  try {
    return baseDecode(body).length === 32;
  } catch {
    return false;
  }
}

function parseArgs(raw: Bytes): Record<string, unknown> {
  const bytes = Uint8Array.from(raw ?? []);
  if (bytes.length > MAX_ARGS_BYTES) throw new Error(`args are ${bytes.length} bytes, the limit is ${MAX_ARGS_BYTES}`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (!isPlainObject(parsed)) throw new Error("not a JSON object");
  return parsed;
}

function parseU128(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(v)) return null;
  const n = BigInt(v);
  return n > U128_MAX ? null : n;
}

function toBigInt(v: unknown): bigint | null {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
    if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
    return null;
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function formatTgas(gas: bigint | null): string {
  if (gas === null) return "unknown";
  const whole = gas / TGAS;
  const frac = ((gas % TGAS) * 100n) / TGAS;
  return frac === 0n ? `${whole} Tgas` : `${whole}.${frac.toString().padStart(2, "0")} Tgas`;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function refuse(code: RefusalCode, reason: string, who: Partial<Pick<Refused, "senderId" | "receiverId" | "method">> = {}): Refused {
  return { allow: false, code, reason, ...who };
}

// ---------------------------------------------------------------------------
// Plain-words description (GET /policy and the README table)
// ---------------------------------------------------------------------------

export interface PolicyDescription {
  words: string[];
  rules: {
    allowed: Array<{
      name: RelayKind;
      receiver_id: string;
      method: string;
      deposit_yocto: string;
      max_gas_tgas: number;
      args: Record<string, string>;
    }>;
    delegate: { max_actions: 1; nested_delegate: false; max_block_height_window_blocks: number; signature_checked_offline: true };
    link_msg: { expires_in_s: [number, number]; memo_max_bytes: number; max_drops_per_msg: number };
  };
}

export function describePolicy(cfg: PolicyConfig): PolicyDescription {
  return {
    words: [
      "The relayer pays NEAR gas for one kind of signed message (NEP-366 delegate) and refuses everything else.",
      `Allowed 1, create a link: a call to the USDC contract ${cfg.usdcId}, method ft_transfer_call, sending the sender's own USDC to the Lumenia escrow ${cfg.escrowId} with a link message (one link key or a batch, life 1 hour to 7 days), exactly 1 yoctoNEAR attached, at most 100 Tgas.`,
      `Allowed 2, take an expired link back: a call to the escrow ${cfg.escrowId}, method reclaim, no deposit, at most 100 Tgas.`,
      "Refused: any other receiver or method, any other deposit or gas, any other action type (transfers, keys, deploys), more than one action, a nested delegate, a message that expires more than 600 blocks ahead or has already expired, and any signature that does not verify.",
      "The relayer never holds or moves the sender's USDC: the signed message is the sender's own instruction, the relayer only attaches gas.",
    ],
    rules: {
      allowed: [
        {
          name: "create_link",
          receiver_id: cfg.usdcId,
          method: "ft_transfer_call",
          deposit_yocto: "1",
          max_gas_tgas: 100,
          args: {
            receiver_id: cfg.escrowId,
            amount: "positive integer string (USDC units, 6 decimals)",
            msg: '{"public_key":"ed25519:...","expires_in_s":3600..604800,"memo"?:string} or {"drops":[...],"expires_in_s":3600..604800}',
            memo: "optional string, at most 256 bytes",
          },
        },
        {
          name: "reclaim",
          receiver_id: cfg.escrowId,
          method: "reclaim",
          deposit_yocto: "0",
          max_gas_tgas: 100,
          args: { public_key: "ed25519:... (the link key)" },
        },
      ],
      delegate: {
        max_actions: 1,
        nested_delegate: false,
        max_block_height_window_blocks: BLOCK_WINDOW,
        signature_checked_offline: true,
      },
      link_msg: {
        expires_in_s: [MIN_EXPIRY_S, MAX_EXPIRY_S],
        memo_max_bytes: MAX_MEMO_BYTES,
        max_drops_per_msg: MAX_DROPS_PER_MSG,
      },
    },
  };
}
