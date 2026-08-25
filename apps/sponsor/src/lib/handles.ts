/**
 * Handle registry — the `@name` a person can be paid at, and the SEP-0002 federation
 * address it resolves to (docs/IDENTITY_AND_ACCOUNTS.md §3).
 *
 * WHY THIS IS NOT AN ACCOUNT SYSTEM. There is no session to authenticate against: a Lumenia
 * account IS an Ed25519 key. So every write here is a SIGNATURE over a message that names the
 * account, verified with the public key the caller claims to be. The server holds no secret of the
 * user's, issues no token, and can neither move a name nor mint one — it can only refuse.
 *
 * WHAT A NAME COSTS THE USER, stated because the UI has to say it: publishing name↔address makes
 * that account's whole on-chain history attributable, by anyone, forever. Claiming is opt-in and
 * releasable, and nothing in the product assigns a name automatically.
 *
 * IMPERSONATION is the real threat on a payment surface, not squatting: `@mer1c` next to `@meric`
 * is how someone gets paid by mistake. So a name is refused when its CONFUSABLE SKELETON collides
 * with a name that already exists — the skeleton is what is reserved, the string is what is shown.
 *
 * Storage is the same Upstash REST store that backs rate-limiting and recovery, under its own key
 * prefix. Writes go through SET..NX so two simultaneous claims cannot both win, and a partial claim
 * rolls itself back rather than stranding half a registration.
 */
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { kvConfigFromEnv } from "./rate-limit.js";

/* ------------------------------------- shape -------------------------------------- */

/** 3–20 chars, starts with a letter, lowercase letters/digits/underscore. */
const NAME_RE = /^[a-z][a-z0-9_]{2,19}$/;
/** How long a released name stays unclaimable by ANYONE, including its previous owner. */
export const RELEASE_COOLDOWN_SEC = 30 * 24 * 3600;
/** How far a proof's timestamp may be from ours, in seconds, in either direction. */
const PROOF_SKEW_SEC = 300;
/** How long a consumed proof is remembered, so it cannot be replayed inside its own window. */
const PROOF_MEMORY_SEC = PROOF_SKEW_SEC * 2 + 60;

const KEY_NAME = "lumenia:handle:";
const KEY_SKEL = "lumenia:handle-skel:";
const KEY_OF = "lumenia:handle-of:";
const KEY_PROOF = "lumenia:handle-proof:";

/**
 * Names nobody may hold. Two groups: words that would let a stranger look official
 * (`support`, `admin`, `lumenia`) and words the product itself may want as a route.
 */
const RESERVED = new Set([
  "admin", "administrator", "root", "system", "official", "team", "staff", "support",
  "help", "helpdesk", "security", "abuse", "billing", "payments", "payment", "pay",
  "lumenia", "lumenio", "lumenla", "getlumenia", "stellar", "sdf", "circle", "usdc",
  "wallet", "money", "bank", "api", "www", "mail", "email", "app", "account", "accounts",
  "settings", "login", "signin", "signup", "register", "claim", "send", "request", "split",
  "contacts", "activity", "home", "start", "about", "terms", "privacy", "legal", "status",
  "null", "undefined", "anonymous", "me", "you", "everyone",
]);

/**
 * Fold a name to the skeleton an impersonator would collide with. Digit→letter substitutions plus
 * the two multi-character lookalikes that actually get used, and underscores dropped entirely —
 * `@me_ric` must not be claimable next to `@meric`.
 */
export function skeleton(name: string): string {
  return name
    .replace(/_/g, "")
    // Multi-character shapes first — folding the letters would destroy the pairs.
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    // Then each confusable CLASS to one representative. `1`, `l` and `i` are one class, which is
    // why `l` folds too: `@bi11` and `@bill` are the same shape to a person glancing at a payment
    // screen, and only one of them may exist.
    .replace(/[1l]/g, "i")
    .replace(/0/g, "o")
    .replace(/2/g, "z")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/[68]/g, "b")
    .replace(/7/g, "t")
    .replace(/9/g, "g");
}

/** Lowercase, trim, drop a leading `@`. Accepts what a user would type; the validator judges it. */
export function normalizeHandle(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/^@+/, "");
}

export interface HandleRejection {
  ok: false;
  reason: string;
}

/** Is this a name we would ever store? Shape + reserved list only — availability is a store read. */
export function validateHandleShape(name: string): { ok: true } | HandleRejection {
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      reason:
        "A name is 3–20 characters, starts with a letter, and uses only letters, numbers and _",
    };
  }
  if (RESERVED.has(name) || RESERVED.has(skeleton(name))) {
    return { ok: false, reason: "That name is reserved." };
  }
  return { ok: true };
}

/* ------------------------------------- store -------------------------------------- */

/** The sponsor's own vocabulary (config.network). The web maps its "public" onto "mainnet". */
type NetworkId = "testnet" | "mainnet";

export interface HandleRecord {
  pubkey: string;
  network: NetworkId;
  createdAt: number;
  /** Set only on a tombstone: the name is released and unclaimable until this instant (ms). */
  releasedUntil?: number;
}

const mem = new Map<string, { value: string; exp?: number }>(); // local/test fallback (no KV)

function memGet(key: string): string | null {
  const row = mem.get(key);
  if (!row) return null;
  if (row.exp && row.exp <= Date.now()) {
    mem.delete(key);
    return null;
  }
  return row.value;
}

async function kvGet(key: string): Promise<string | null> {
  const kv = kvConfigFromEnv();
  if (!kv) return memGet(key);
  const res = await fetch(`${kv.url}/get/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${kv.token}` },
  });
  if (!res.ok) throw new Error(`handle store returned ${res.status}`);
  const data = (await res.json()) as { result?: string | null };
  return data.result ?? null;
}

/** SET key value NX [EX ttl] — returns true when THIS caller took the key. */
async function kvSetNx(key: string, value: string, ttlSec?: number): Promise<boolean> {
  const kv = kvConfigFromEnv();
  if (!kv) {
    if (memGet(key) !== null) return false;
    mem.set(key, { value, exp: ttlSec ? Date.now() + ttlSec * 1000 : undefined });
    return true;
  }
  const cmd: (string | number)[] = ["SET", key, value, "NX"];
  if (ttlSec) cmd.push("EX", ttlSec);
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify([cmd.map(String)]),
  });
  if (!res.ok) throw new Error(`handle store returned ${res.status}`);
  const [first] = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  if (first?.error) throw new Error(`handle store error: ${first.error}`);
  return first?.result === "OK";
}

/** SET key value [EX ttl] — unconditional, used for tombstones and rollback-free overwrites. */
async function kvSet(key: string, value: string, ttlSec?: number): Promise<void> {
  const kv = kvConfigFromEnv();
  if (!kv) {
    mem.set(key, { value, exp: ttlSec ? Date.now() + ttlSec * 1000 : undefined });
    return;
  }
  const cmd: string[] = ["SET", key, value, ...(ttlSec ? ["EX", String(ttlSec)] : [])];
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify([cmd]),
  });
  if (!res.ok) throw new Error(`handle store returned ${res.status}`);
}

async function kvDel(key: string): Promise<void> {
  const kv = kvConfigFromEnv();
  if (!kv) {
    mem.delete(key);
    return;
  }
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify([["DEL", key]]),
  });
  if (!res.ok) throw new Error(`handle store returned ${res.status}`);
}

/** Test seam: drop the in-memory fallback between cases. No effect when KV is configured. */
export function __resetHandleStore(): void {
  mem.clear();
}

/* ------------------------------------- proofs ------------------------------------- */

/**
 * What an account signature authorizes. `links` is not a handle operation at all — it reuses this
 * same proof so that "which ways back in does this account have?" can only be asked by the account
 * itself, rather than by anyone who knows an address.
 */
export type ProofAction = "claim" | "release" | "links";

/**
 * The exact bytes the account key signs. Built identically on the client
 * (apps/web/lib/handles.ts::handleProofMessage) — one function, two copies, and the tests pin the
 * string, because a drift here does not fail loudly, it just refuses everyone.
 */
export function handleProofMessage(
  action: ProofAction,
  name: string,
  pubkey: string,
  ts: number,
  nonce: string,
  network: NetworkId,
): string {
  return `lumenia-handle-${action}:v1:${name}:${pubkey}:${ts}:${nonce}:${network}`;
}

/** A per-request random value. See the note on `nonce` in ProofInput for why it is not optional. */
export function proofNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ProofInput {
  action: ProofAction;
  name: string;
  pubkey: string;
  ts: number;
  /**
   * Per-request randomness, 8–32 hex characters.
   *
   * Not decoration: the timestamp is only second-granular, so without a nonce two LEGITIMATE
   * requests in the same second — a double-tapped button, a retry after a flaky response —
   * produce byte-identical messages, and the replay guard below refuses the second one as an
   * attack. The nonce makes "the same request twice" and "a replayed signature" different events.
   */
  nonce: string;
  network: NetworkId;
  /** base64 Ed25519 signature over handleProofMessage(...). */
  proof: string;
}

/**
 * Verify that the holder of `pubkey`'s secret key authorized THIS action on THIS name, recently,
 * and that we have not already honoured this exact proof.
 *
 * The replay memory matters even though the timestamp is bounded: within the ±5 minute window the
 * same signature would otherwise work repeatedly, which turns a single leaked proof (a shared log,
 * a proxy) into a re-claim after a release.
 */
export async function verifyHandleProof(input: ProofInput): Promise<{ ok: true } | HandleRejection> {
  if (!StrKey.isValidEd25519PublicKey(input.pubkey)) {
    return { ok: false, reason: "invalid account address" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(input.ts) || Math.abs(now - input.ts) > PROOF_SKEW_SEC) {
    return { ok: false, reason: "this request expired — check your device clock and try again" };
  }
  if (!/^[0-9a-f]{8,32}$/.test(input.nonce)) return { ok: false, reason: "malformed request" };
  const message = handleProofMessage(input.action, input.name, input.pubkey, input.ts, input.nonce, input.network);
  let signatureOk = false;
  try {
    signatureOk = Keypair.fromPublicKey(input.pubkey).verify(
      Buffer.from(message, "utf8"),
      Buffer.from(input.proof, "base64"),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, reason: "that signature does not match this account" };

  // Single-use inside the window. NX loses the race for a duplicate, which is exactly the answer.
  const fresh = await kvSetNx(KEY_PROOF + (await sha256Hex(message)), "1", PROOF_MEMORY_SEC);
  if (!fresh) return { ok: false, reason: "this request was already used" };
  return { ok: true };
}

/* ------------------------------------ operations ---------------------------------- */

export interface ClaimResult {
  ok: true;
  name: string;
  pubkey: string;
  network: NetworkId;
}

async function readRecord(name: string): Promise<HandleRecord | null> {
  const raw = await kvGet(KEY_NAME + name);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HandleRecord;
  } catch {
    return null;
  }
}

/** Is this name held, or cooling down after a release? */
export async function lookupHandle(
  rawName: unknown,
): Promise<{ name: string; pubkey: string; network: NetworkId } | null> {
  const name = normalizeHandle(rawName);
  if (validateHandleShape(name).ok !== true) return null;
  const rec = await readRecord(name);
  if (!rec || rec.releasedUntil) return null; // a tombstone is not an owner
  return { name, pubkey: rec.pubkey, network: rec.network };
}

/** The name this account holds on this network, or null. */
export async function handleOf(rawPubkey: unknown, network: NetworkId): Promise<string | null> {
  const pubkey = String(rawPubkey ?? "");
  if (!StrKey.isValidEd25519PublicKey(pubkey)) return null;
  return kvGet(`${KEY_OF}${network}:${pubkey}`);
}

/**
 * Can this name be claimed RIGHT NOW, and if not, why in words a person can act on?
 *
 * `lookupHandle` is not enough to answer that. It returns null for a name that is merely cooling
 * down after a release, and it knows nothing about skeleton collisions — so a screen built on it
 * told people a name was free, let them type it, and only refused at the button. Both refusals are
 * knowable up front, so they are answered up front.
 */
export async function handleAvailability(
  rawName: unknown,
): Promise<{ available: boolean; reason?: string }> {
  const name = normalizeHandle(rawName);
  const shape = validateHandleShape(name);
  if (shape.ok !== true) return { available: false, reason: shape.reason };

  const rec = await readRecord(name);
  if (rec) {
    if (!rec.releasedUntil) return { available: false, reason: "That name is taken." };
    if (rec.releasedUntil > Date.now()) {
      return { available: false, reason: "That name was given up recently and is not available yet." };
    }
  }

  const holder = await kvGet(KEY_SKEL + skeleton(name));
  if (holder && holder !== name) {
    return { available: false, reason: "That name is too close to one that already exists." };
  }
  return { available: true };
}

/**
 * Claim `name` for `pubkey`, proved by a signature from that account.
 *
 * Three keys have to be taken together — the name, its confusable skeleton, and the account's
 * reverse pointer — and any of them can already be held. They are taken in the order that fails
 * cheapest, and a failure after a partial take rolls back what it took, so a lost race never leaves
 * a name reserved by nobody.
 */
export async function claimHandle(input: ProofInput): Promise<ClaimResult | HandleRejection> {
  const name = normalizeHandle(input.name);
  const shape = validateHandleShape(name);
  if (shape.ok !== true) return shape;

  const proofOk = await verifyHandleProof({ ...input, name, action: "claim" });
  if (proofOk.ok !== true) return proofOk;

  const existing = await readRecord(name);
  if (existing) {
    if (existing.releasedUntil && existing.releasedUntil > Date.now()) {
      return { ok: false, reason: "That name was given up recently and is not available yet." };
    }
    if (!existing.releasedUntil) {
      return existing.pubkey === input.pubkey
        ? { ok: true, name, pubkey: input.pubkey, network: input.network } // already yours
        : { ok: false, reason: "That name is taken." };
    }
  }

  // The account may hold only one name. Checked before we take anything, and enforced again by the
  // NX on the reverse key below — this read is the friendly answer, that write is the guarantee.
  const already = await handleOf(input.pubkey, input.network);
  if (already && already !== name) {
    return { ok: false, reason: `This account is already @${already}. Give that name up first.` };
  }

  const skel = skeleton(name);
  const tookSkel = await kvSetNx(KEY_SKEL + skel, name);
  if (!tookSkel) {
    const holder = await kvGet(KEY_SKEL + skel);
    if (holder !== name) {
      return { ok: false, reason: "That name is too close to one that already exists." };
    }
  }

  const record: HandleRecord = {
    pubkey: input.pubkey,
    network: input.network,
    createdAt: Date.now(),
  };
  const tookName = existing
    ? (await kvSet(KEY_NAME + name, JSON.stringify(record)), true) // replacing an expired tombstone
    : await kvSetNx(KEY_NAME + name, JSON.stringify(record));
  if (!tookName) {
    if (tookSkel) await kvDel(KEY_SKEL + skel);
    return { ok: false, reason: "That name is taken." };
  }

  const tookOf = await kvSetNx(`${KEY_OF}${input.network}:${input.pubkey}`, name);
  if (!tookOf) {
    await kvDel(KEY_NAME + name);
    if (tookSkel) await kvDel(KEY_SKEL + skel);
    return { ok: false, reason: "This account already has a name." };
  }

  return { ok: true, name, pubkey: input.pubkey, network: input.network };
}

/**
 * Give up a name. The name does NOT become free: it is tombstoned for RELEASE_COOLDOWN_SEC, for
 * everyone including its previous owner. A name that has been handed to people who pay with it must
 * not become registrable by a stranger the moment its owner moves on.
 */
export async function releaseHandle(input: ProofInput): Promise<{ ok: true; name: string } | HandleRejection> {
  const name = normalizeHandle(input.name);
  const shape = validateHandleShape(name);
  if (shape.ok !== true) return shape;

  const rec = await readRecord(name);
  if (!rec || rec.releasedUntil) return { ok: false, reason: "Nobody holds that name." };
  if (rec.pubkey !== input.pubkey) return { ok: false, reason: "That name is not yours." };

  const proofOk = await verifyHandleProof({ ...input, name, action: "release" });
  if (proofOk.ok !== true) return proofOk;

  const until = Date.now() + RELEASE_COOLDOWN_SEC * 1000;
  await kvSet(
    KEY_NAME + name,
    JSON.stringify({ ...rec, releasedUntil: until } satisfies HandleRecord),
    RELEASE_COOLDOWN_SEC,
  );
  // The skeleton stays reserved for exactly as long as the tombstone, so a lookalike cannot move in
  // during the cooldown either.
  await kvSet(KEY_SKEL + skeleton(name), name, RELEASE_COOLDOWN_SEC);
  await kvDel(`${KEY_OF}${rec.network}:${rec.pubkey}`);
  return { ok: true, name };
}

/* ----------------------------------- federation ----------------------------------- */

/** The domain names are published under, e.g. `meric*getlumenia.com`. */
export function federationDomain(): string {
  return process.env.FEDERATION_DOMAIN ?? "getlumenia.com";
}

export interface FederationAnswer {
  stellar_address: string;
  account_id: string;
}

/**
 * SEP-0002 federation lookup. Two of the four types are meaningful here:
 *   `name` — `meric*getlumenia.com` → the account
 *   `id`   — a `G…` account → its name, when it has one
 * `txid` and `forward` are not supported and say so, rather than answering something plausible.
 */
export async function federationLookup(
  q: string,
  type: string,
  network: NetworkId,
): Promise<FederationAnswer | HandleRejection> {
  if (type === "name") {
    const [name, domain] = q.split("*");
    if (!name || !domain) return { ok: false, reason: "invalid federation address" };
    if (domain.toLowerCase() !== federationDomain().toLowerCase()) {
      return { ok: false, reason: "unknown federation domain" };
    }
    const found = await lookupHandle(name);
    if (!found) return { ok: false, reason: "not found" };
    return {
      stellar_address: `${found.name}*${federationDomain()}`,
      account_id: found.pubkey,
    };
  }
  if (type === "id") {
    const name = await handleOf(q, network);
    if (!name) return { ok: false, reason: "not found" };
    return { stellar_address: `${name}*${federationDomain()}`, account_id: q };
  }
  return { ok: false, reason: "unsupported federation type" };
}
