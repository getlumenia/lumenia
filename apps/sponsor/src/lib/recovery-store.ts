/**
 * Recovery blob store — the SERVER side of the zero-knowledge recovery box
 * (RECOVERY_ARCHITECTURE §4.2 + §12 step 2). Stores ONLY ciphertext + KDF params,
 * keyed by an opaque high-entropy id (the client's hashed identity). It NEVER holds a
 * seed, password, or PRF secret, and is NEVER joined to a pubkey or any money data — a
 * SEPARATE store, isolated from the sponsor signing key. The endpoint touches no keys
 * and no anti-drain policy (it signs nothing).
 *
 * Reuses the Upstash REST pair (kvConfigFromEnv) as a keyed value store; an in-memory
 * Map is the local/test fallback (single-process only — without KV a box would NOT
 * persist across serverless instances, which production always has).
 *
 * `validateBox` is the ciphertext-only guarantee ENFORCED server-side: a box may
 * contain ONLY the fields of a password/prf copy (iv/ct/salt/hkdfSalt/argon) — anything
 * else is rejected, so no plaintext seed/password/PRF and no PII can ever be stored.
 * The client wrap/unwrap lives in apps/web/lib/recovery.ts (Spike S1, proven 7/7).
 */
import { kvConfigFromEnv } from "./rate-limit.js";

const ID_RE = /^[0-9a-f]{64}$/; // SHA-256 hex — an opaque, high-entropy (256-bit) lookup key
const MAX_BOX_BYTES = 4096;

const mem = new Map<string, string>(); // local/test fallback (no KV configured)

type ArgonParams = { memMiB: number; time: number; parallelism: number };
type Copy =
  | { kind: "password"; iv: string; ct: string; salt: string; argon: ArgonParams }
  | { kind: "prf"; iv: string; ct: string; hkdfSalt: string };
export interface RecoveryBox {
  formatVersion: 1;
  copies: Copy[];
}

function isB64(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= 1024 && /^[A-Za-z0-9+/=]+$/.test(s);
}
function isArgon(a: unknown): a is ArgonParams {
  if (!a || typeof a !== "object") return false;
  const p = a as Record<string, unknown>;
  // Enforce a Argon2id MINIMUM (security review F4): a box wrapped with weak params (memMiB=1,
  // time=1) is trivially crackable offline once the store leaks. OWASP floor: ≥19 MiB, ≥2 passes.
  // DEFAULT_ARGON (48/2/1) clears it; an old/buggy/malicious client can't persist a weak box.
  return (
    Object.keys(p).length === 3 &&
    typeof p.memMiB === "number" && p.memMiB >= 19 && p.memMiB <= 1024 &&
    typeof p.time === "number" && p.time >= 2 && p.time <= 16 &&
    typeof p.parallelism === "number" && p.parallelism > 0 && p.parallelism <= 8
  );
}
function isCopy(c: unknown): c is Copy {
  if (!c || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  if (o.kind === "password") {
    return Object.keys(o).length === 5 && isB64(o.iv) && isB64(o.ct) && isB64(o.salt) && isArgon(o.argon);
  }
  if (o.kind === "prf") {
    return Object.keys(o).length === 4 && isB64(o.iv) && isB64(o.ct) && isB64(o.hkdfSalt);
  }
  return false;
}

/** Strict shape check — the ciphertext-only guarantee. Throws with a reason on mismatch. */
export function validateBox(box: unknown): RecoveryBox {
  if (!box || typeof box !== "object") throw new Error("box must be an object");
  const b = box as Record<string, unknown>;
  if (Object.keys(b).length !== 2) throw new Error("box has unexpected fields");
  if (b.formatVersion !== 1) throw new Error("unsupported box formatVersion");
  if (!Array.isArray(b.copies) || b.copies.length < 1 || b.copies.length > 3) {
    throw new Error("box.copies must be 1–3 entries");
  }
  const kinds = new Set<string>();
  for (const c of b.copies) {
    if (!isCopy(c)) throw new Error("a copy has an invalid shape (ciphertext-only fields required)");
    if (kinds.has(c.kind)) throw new Error("duplicate copy kind");
    kinds.add(c.kind);
  }
  return b as unknown as RecoveryBox;
}

function validateId(id: unknown): string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("id must be a 64-char hex string");
  return id;
}

/* ---------------------------------------------------------------------------
 * TWO NAMESPACES, and the separation IS the security control.
 *
 * The email-keyed id is SHA-256(email): LOW entropy. Know somebody's email and you know their id,
 * so the mailed OTP is the only thing standing between an attacker and their box. It must stay
 * OTP-gated forever.
 *
 * The alias id is HKDF over a WebAuthn PRF output (apps/web/lib/recovery.ts::prfToBoxId): 256 bits
 * that only a user-verified passkey ceremony on this origin can produce. Possessing it already
 * proves what an OTP would prove, so the alias FETCH is deliberately not OTP-gated — that is what
 * makes "find my account with one Face ID tap, no email, no code" possible.
 *
 * Both are 64 lowercase hex and the server cannot tell them apart. So the distinction can NEVER be
 * a flag on a shared route: an un-OTP'd fetch that read the email namespace would hand any box to
 * anyone who knows the victim's email address. It has to be a different key prefix behind a
 * different route, and test-recovery-store.ts asserts the isolation in both directions.
 * --------------------------------------------------------------------------- */
const KEY_EMAIL = "lumenia:recovery:";
const KEY_ALIAS = "lumenia:recovery-pk:";

async function putBoxAt(prefix: string, rawId: unknown, rawBox: unknown): Promise<{ ok: true }> {
  const id = validateId(rawId);
  const box = validateBox(rawBox);
  const json = JSON.stringify(box);
  if (json.length > MAX_BOX_BYTES) throw new Error("box too large");

  const kv = kvConfigFromEnv();
  if (!kv) {
    mem.set(prefix + id, json);
    console.log(`[recovery:put] ${prefix}${id.slice(0, 8)}… (no KV — in-memory fallback)`);
    return { ok: true };
  }
  const res = await fetch(`${kv.url}/set/${prefix}${id}`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}` },
    body: json, // Upstash SET: the raw request body is the value
  });
  if (!res.ok) throw new Error(`recovery store returned ${res.status}`);
  return { ok: true };
}

async function getBoxAt(prefix: string, rawId: unknown): Promise<RecoveryBox | null> {
  const id = validateId(rawId);
  const kv = kvConfigFromEnv();
  if (!kv) {
    const v = mem.get(prefix + id);
    return v ? (JSON.parse(v) as RecoveryBox) : null;
  }
  const res = await fetch(`${kv.url}/get/${prefix}${id}`, {
    headers: { authorization: `Bearer ${kv.token}` },
  });
  if (!res.ok) throw new Error(`recovery store returned ${res.status}`);
  const data = (await res.json()) as { result?: string | null };
  return data.result ? (JSON.parse(data.result) as RecoveryBox) : null;
}

/** Store (or replace) the EMAIL-keyed box. Always OTP-gated at the route. */
export async function putBox(rawId: unknown, rawBox: unknown): Promise<{ ok: true }> {
  return putBoxAt(KEY_EMAIL, rawId, rawBox);
}

/** Fetch the EMAIL-keyed box, or null. Always OTP-gated at the route. */
export async function getBox(rawId: unknown): Promise<RecoveryBox | null> {
  return getBoxAt(KEY_EMAIL, rawId);
}

/**
 * Store the PRF-alias copy of a box. Written only from /recovery, i.e. behind the same OTP the
 * email copy is: the backup flow already holds a verified code, so piggybacking widens no surface.
 * The box is DUPLICATED rather than stored as a pointer — a pointer looks tidier but breaks the
 * moment the user re-backs-up from a device with no Face ID, leaving somebody who just passed Face
 * ID staring at "this backup has no Face ID key". A stale duplicate is harmless: the seed never
 * rotates, so an older box still restores the correct account.
 */
export async function putAliasBox(rawId: unknown, rawBox: unknown): Promise<{ ok: true }> {
  return putBoxAt(KEY_ALIAS, rawId, rawBox);
}

/** Fetch the PRF-alias box, or null. Read by the un-OTP'd alias route ONLY. */
export async function getAliasBox(rawId: unknown): Promise<RecoveryBox | null> {
  return getBoxAt(KEY_ALIAS, rawId);
}
