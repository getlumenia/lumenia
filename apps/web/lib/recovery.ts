/**
 * Recovery box — the SERVER-STORABLE, zero-knowledge wrap of the home-account seed
 * (RECOVERY_ARCHITECTURE §3.3 + §11/§12, Stage 3). Distinct from lib/keystore.ts (the
 * DEVICE-LOCAL at-rest cache): this produces a fully PORTABLE ciphertext "box" that
 * re-derives the SAME 32-byte seed on ANY device from a password (floor) or a passkey
 * PRF output (upgrade). The server stores ONLY the box (ciphertext + KDF params +
 * iv/salt) — never the seed, the password, or the PRF secret — so it can open none of
 * it. A server breach yields Argon2id-hard blobs (password copy) and an unopenable
 * AES-GCM blob (PRF copy) — the whole thing stays non-custodial.
 *
 * Proven end-to-end by Spike S1 (RECOVERY_ARCHITECTURE §7, 8/8): one seed, two
 * independent wraps, either reopens the exact seed; tampered ciphertext / wrong
 * password / wrong PRF are all rejected by AES-GCM auth. This module is that crypto,
 * productized. The seed never leaves this module + lib/signer.ts as plaintext, and is
 * never logged or sent anywhere.
 *
 * SCOPE: this module only wraps/unwraps BYTES. It does NOT talk to any server and does
 * NOT read WebAuthn — the blob-store client (PUT/GET /recovery/{id}, §12 step 2) and the
 * actual PRF extraction (Spike #2, real hardware, §12 step 5) sit on top of it.
 */
import { deriveKek, DEFAULT_ARGON, type ArgonParams } from "./argon";

/* base64 helpers — portable across the browser and Node (btoa/atob are global in both). */
const b64 = {
  enc(u: Uint8Array): string {
    let s = "";
    for (const byte of u) s += String.fromCharCode(byte);
    return btoa(s);
  },
  dec(s: string): Uint8Array {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  },
};

// WebCrypto's BufferSource is narrower than Uint8Array<ArrayBufferLike>; our arrays are
// always ArrayBuffer-backed at runtime, so coerce for the type-checker only (mirrors keystore.ts).
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

// HKDF domain-separation label for the PRF copy (binds the derived key to this use).
const PRF_HKDF_INFO = new TextEncoder().encode("lumenia-recovery-prf-v1");

export type RecoveryCopyKind = "password" | "prf";

/** A password-wrapped copy: Argon2id(password, salt) -> AES-256-GCM(seed). */
export interface PasswordCopy {
  kind: "password";
  iv: string; // base64, 12 bytes
  ct: string; // base64
  salt: string; // base64, 16 bytes (Argon2id salt)
  argon: ArgonParams;
}

/** A passkey-PRF-wrapped copy: HKDF-SHA256(prf, hkdfSalt) -> AES-256-GCM(seed). */
export interface PrfCopy {
  kind: "prf";
  iv: string; // base64, 12 bytes
  ct: string; // base64
  hkdfSalt: string; // base64, 16 bytes
}

export type RecoveryCopy = PasswordCopy | PrfCopy;

/** The full box stored server-side (JSON-serialisable; all bytes are base64). */
export interface RecoveryBox {
  formatVersion: 1;
  copies: RecoveryCopy[];
}

async function aesGcmEncrypt(
  keyBytes: Uint8Array,
  seed: Uint8Array,
): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
  const key = await crypto.subtle.importKey("raw", bs(keyBytes), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(seed)));
  return { iv, ct };
}

/** Throws (AES-GCM auth failure) on a wrong key or tampered ciphertext/iv. */
async function aesGcmDecrypt(keyBytes: Uint8Array, iv: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", bs(keyBytes), { name: "AES-GCM" }, false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(ct)));
}

/** Derive a 32-byte AES key from a raw WebAuthn PRF output via HKDF-SHA256. */
async function prfToKey(prf: Uint8Array, hkdfSalt: Uint8Array): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey("raw", bs(prf), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: bs(hkdfSalt), info: bs(PRF_HKDF_INFO) },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * A SECOND, independent value from the SAME PRF output: the server-side lookup id for this box.
 *
 * This is what makes "find my account with one Face ID tap" possible. The box carries no id, no
 * address and no email, and until now could only be addressed by SHA-256(email) behind a mailed
 * code. Derived here from the authenticator's own secret instead, the id is 256 bits that only a
 * successful user-verified ceremony on this origin can produce.
 *
 * Two deliberate differences from prfToKey, both load-bearing:
 *   - a DIFFERENT HKDF `info` label, so the id is computationally independent of the AES wrap key
 *     and can be handed to a server without leaking a bit of it;
 *   - a FIXED all-zero salt rather than the box's random hkdfSalt, because the id must be
 *     computable BEFORE the box that carries that salt can be fetched. RFC 5869 allows this, and
 *     the PRF output is already a uniformly random secret, so domain separation comes entirely
 *     from `info`. The differing salt also yields a different PRK, so independence is doubly held.
 *
 * WIRE FORMAT, PERMANENT. The label, the salt and the 32-byte length can never change once one
 * alias exists on the server: changing any of them silently orphans every stored backup and tells
 * the user "no backup found" for money that is perfectly safe. The frozen vector in
 * recovery.selftest.ts fails loudly if any of it drifts.
 */
const ID_HKDF_INFO = new TextEncoder().encode("lumenia-recovery-id-v1");
const ID_HKDF_SALT = new Uint8Array(32); // all zeroes, on purpose (see above)

export async function prfToBoxId(prf: Uint8Array): Promise<string> {
  const ikm = await crypto.subtle.importKey("raw", bs(prf), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: bs(ID_HKDF_SALT), info: bs(ID_HKDF_INFO) },
    ikm,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* --------------------------------- password ---------------------------------- */

export async function wrapWithPassword(
  seed: Uint8Array,
  password: string,
  argon: ArgonParams = DEFAULT_ARGON,
): Promise<PasswordCopy> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kek = await deriveKek(password, salt, argon);
  const { iv, ct } = await aesGcmEncrypt(kek, seed);
  kek.fill(0);
  return { kind: "password", iv: b64.enc(iv), ct: b64.enc(ct), salt: b64.enc(salt), argon };
}

/** Re-derive the seed. Throws on a wrong password or tampered ciphertext. */
export async function unwrapWithPassword(copy: PasswordCopy, password: string): Promise<Uint8Array> {
  const kek = await deriveKek(password, b64.dec(copy.salt), copy.argon);
  try {
    return await aesGcmDecrypt(kek, b64.dec(copy.iv), b64.dec(copy.ct));
  } finally {
    kek.fill(0);
  }
}

/* ----------------------------------- prf ------------------------------------- */

export async function wrapWithPrf(seed: Uint8Array, prf: Uint8Array): Promise<PrfCopy> {
  const hkdfSalt = crypto.getRandomValues(new Uint8Array(16));
  const key = await prfToKey(prf, hkdfSalt);
  const { iv, ct } = await aesGcmEncrypt(key, seed);
  key.fill(0);
  return { kind: "prf", iv: b64.enc(iv), ct: b64.enc(ct), hkdfSalt: b64.enc(hkdfSalt) };
}

/** Re-derive the seed. Throws on a wrong PRF output or tampered ciphertext. */
export async function unwrapWithPrf(copy: PrfCopy, prf: Uint8Array): Promise<Uint8Array> {
  const key = await prfToKey(prf, b64.dec(copy.hkdfSalt));
  try {
    return await aesGcmDecrypt(key, b64.dec(copy.iv), b64.dec(copy.ct));
  } finally {
    key.fill(0);
  }
}

/* --------------------------------- box helpers ------------------------------- */

export function emptyBox(): RecoveryBox {
  return { formatVersion: 1, copies: [] };
}

/** Add or replace the copy of the given kind (at most one copy per kind). */
export function putCopy(box: RecoveryBox, copy: RecoveryCopy): RecoveryBox {
  const copies = box.copies.filter((c) => c.kind !== copy.kind);
  copies.push(copy);
  return { ...box, copies };
}

export function findCopy<K extends RecoveryCopyKind>(
  box: RecoveryBox,
  kind: K,
): Extract<RecoveryCopy, { kind: K }> | undefined {
  return box.copies.find((c) => c.kind === kind) as Extract<RecoveryCopy, { kind: K }> | undefined;
}
