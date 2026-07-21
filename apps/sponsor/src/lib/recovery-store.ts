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
  return (
    Object.keys(p).length === 3 &&
    typeof p.memMiB === "number" && p.memMiB > 0 && p.memMiB <= 1024 &&
    typeof p.time === "number" && p.time > 0 && p.time <= 16 &&
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

/** Store (or replace) the box for `id`. Ciphertext-only; validated strictly. */
export async function putBox(rawId: unknown, rawBox: unknown): Promise<{ ok: true }> {
  const id = validateId(rawId);
  const box = validateBox(rawBox);
  const json = JSON.stringify(box);
  if (json.length > MAX_BOX_BYTES) throw new Error("box too large");

  const kv = kvConfigFromEnv();
  if (!kv) {
    mem.set(id, json);
    console.log(`[recovery:put] ${id.slice(0, 8)}… (no KV — in-memory fallback)`);
    return { ok: true };
  }
  const res = await fetch(`${kv.url}/set/lumenia:recovery:${id}`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}` },
    body: json, // Upstash SET: the raw request body is the value
  });
  if (!res.ok) throw new Error(`recovery store returned ${res.status}`);
  return { ok: true };
}

/** Fetch the box for `id`, or null if none. (OTP-gating on this path lands in §12 step 3.) */
export async function getBox(rawId: unknown): Promise<RecoveryBox | null> {
  const id = validateId(rawId);
  const kv = kvConfigFromEnv();
  if (!kv) {
    const v = mem.get(id);
    return v ? (JSON.parse(v) as RecoveryBox) : null;
  }
  const res = await fetch(`${kv.url}/get/lumenia:recovery:${id}`, {
    headers: { authorization: `Bearer ${kv.token}` },
  });
  if (!res.ok) throw new Error(`recovery store returned ${res.status}`);
  const data = (await res.json()) as { result?: string | null };
  return data.result ? (JSON.parse(data.result) as RecoveryBox) : null;
}
