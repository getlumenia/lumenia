/**
 * Restore from backup: email -> one-time code -> password, the same three steps as the website's
 * "already have money on another phone?" surface, with the network and the keystore injected so the
 * flow runs in the self-test against a fake /recovery-fetch.
 *
 * The box that comes back is ciphertext the server cannot open; only the password copy is usable
 * here (a passkey copy is bound to getlumenia.com's origin and can never open in an extension). The
 * fetch does not change the stored box.
 */
import type { PasswordCopy, RecoveryBox } from "../core";
import { ExtError, MESSAGES, fail } from "./errors";

export interface RestoreDeps {
  requestOtp(email: string): Promise<void>;
  fetchBox(email: string, code: string): Promise<RecoveryBox | null>;
  findPasswordCopy(box: RecoveryBox): PasswordCopy | undefined;
  unwrap(copy: PasswordCopy, password: string): Promise<Uint8Array>;
  publicKeyOf(seed: Uint8Array): string;
  /** keep the Phase-2 record (Argon2id + AES-GCM under the same password) in this extension */
  save(pubkey: string, seed: Uint8Array, password: string): Promise<void>;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validEmail(email: string): boolean {
  const e = email.trim();
  return e.length <= 254 && EMAIL_RE.test(e);
}

/** Digits only; people paste codes with spaces. */
export function normalizeCode(code: string): string {
  return code.replace(/\s+/g, "");
}

/** A failed request, as the refusal a person can act on. Shared with the backup steps (lib/backup.ts). */
export function networkFailure(e: unknown, fallback: string): ExtError {
  const msg = e instanceof Error ? e.message : String(e);
  // Only a request that never got an answer is "offline"; any other TypeError is a bad answer.
  if (/Failed to fetch|NetworkError|fetch failed|Load failed/i.test(msg)) return fail("offline");
  if (/rate limit|too many/i.test(msg)) return fail("rate-limited");
  return new ExtError("internal", fallback);
}

/** A box is server data: check its shape before anything reads it. */
function isBox(v: unknown): v is RecoveryBox {
  return !!v && typeof v === "object" && Array.isArray((v as { copies?: unknown }).copies);
}

/** Step 1: mail a code to `email`. */
export async function startRestore(deps: RestoreDeps, email: string): Promise<void> {
  if (!validEmail(email)) throw fail("bad-email");
  try {
    await deps.requestOtp(email.trim());
  } catch (e) {
    throw networkFailure(e, "We couldn't send the code. Try again.");
  }
}

/** Step 2: trade the code for the box. Refuses a box that has no password copy. */
export async function submitCode(deps: RestoreDeps, email: string, code: string): Promise<RecoveryBox> {
  const c = normalizeCode(code);
  if (!/^\d{6}$/.test(c)) throw fail("bad-code");
  let box: RecoveryBox | null;
  try {
    box = await deps.fetchBox(email.trim(), c);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/wrong or has expired/i.test(msg)) throw fail("bad-code");
    throw networkFailure(e, "We couldn't reach your backup. Try again.");
  }
  if (box === null) throw fail("no-backup");
  if (!isBox(box)) throw new ExtError("unsupported-backup", MESSAGES["unsupported-backup"]);
  if (!deps.findPasswordCopy(box)) throw fail("no-password-copy");
  return box;
}

/**
 * Step 3: open the box with the password and keep the account here. Returns the seed for the
 * caller to put in the session; the caller zeroes it.
 */
export async function openBox(deps: RestoreDeps, box: RecoveryBox, password: string): Promise<{ pubkey: string; seed: Uint8Array }> {
  if (!isBox(box)) throw new ExtError("unsupported-backup", MESSAGES["unsupported-backup"]);
  const copy = deps.findPasswordCopy(box);
  if (!copy) throw fail("no-password-copy");
  let seed: Uint8Array;
  try {
    seed = await deps.unwrap(copy, password);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/settings this app doesn't support/i.test(msg)) throw fail("unsupported-backup");
    // AES-GCM refuses a wrong key without saying why: that is a wrong password (or a damaged box).
    throw fail("bad-password");
  }
  if (seed.length !== 32) {
    seed.fill(0);
    throw fail("unsupported-backup");
  }
  const pubkey = deps.publicKeyOf(seed);
  try {
    await deps.save(pubkey, seed, password);
  } catch {
    seed.fill(0);
    throw new ExtError("internal", "We opened your backup but couldn't keep it in this browser. Try again.");
  }
  return { pubkey, seed };
}
