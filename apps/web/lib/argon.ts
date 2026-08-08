/**
 * Argon2id key derivation in the browser via hash-wasm (FRONTEND_PLAN §9 — NOT the
 * native `argon2` node build, NOT argon2-browser). Derives the KEK that wraps the
 * account seed (Phase 2). Params are tunable so the browser-key-lifecycle spike can
 * find the band that's acceptable on a cheap Android inside the WhatsApp webview
 * (fast enough, no OOM). This module is the only place Argon2id is configured.
 */
import { argon2id } from "hash-wasm";

export interface ArgonParams {
  /** memory cost in MiB */
  memMiB: number;
  /** time cost (iterations) */
  time: number;
  /** lanes / parallelism */
  parallelism: number;
}

/** A mobile-conscious starting point; tuned by the spike on a real device. */
export const DEFAULT_ARGON: ArgonParams = { memMiB: 48, time: 2, parallelism: 1 };

/**
 * The band this app will derive in, when the parameters did not come from this app.
 *
 * A recovery box is fetched from the server and carries its OWN KDF parameters, so those numbers
 * are attacker-influenced input, not configuration. Unbounded they are two separate weapons: high
 * (`memMiB: 4_000_000`) hangs or OOMs the browser on every restore attempt, and low (`memMiB: 1,
 * time: 1`) hands back a wrap that is cheap to crack offline — and worse, a client that accepted
 * it would re-upload at that strength on the next backup.
 *
 * The floor is OWASP's Argon2id minimum (19 MiB at t=2), which the sponsor also enforces before
 * storing. The ceiling is what a cheap Android in a webview can survive; we only ever WRITE
 * DEFAULT_ARGON, so anything above it came from something other than this app.
 */
export const ARGON_BOUNDS = {
  memMiB: { min: 19, max: 256 },
  time: { min: 2, max: 16 },
  parallelism: { min: 1, max: 8 },
} as const;

/** Throw unless `p` is a set of parameters this app is willing to spend a device's memory on. */
export function assertArgonInBounds(p: ArgonParams): void {
  const ok =
    Number.isInteger(p.memMiB) &&
    p.memMiB >= ARGON_BOUNDS.memMiB.min &&
    p.memMiB <= ARGON_BOUNDS.memMiB.max &&
    Number.isInteger(p.time) &&
    p.time >= ARGON_BOUNDS.time.min &&
    p.time <= ARGON_BOUNDS.time.max &&
    Number.isInteger(p.parallelism) &&
    p.parallelism >= ARGON_BOUNDS.parallelism.min &&
    p.parallelism <= ARGON_BOUNDS.parallelism.max;
  if (!ok) throw new Error("This backup has settings this app doesn't support, so it wasn't opened.");
}

/** Derive a 32-byte key-encryption key from a password + salt. */
export async function deriveKek(
  password: string,
  salt: Uint8Array,
  p: ArgonParams,
): Promise<Uint8Array> {
  return argon2id({
    password,
    salt,
    parallelism: p.parallelism,
    iterations: p.time,
    memorySize: p.memMiB * 1024, // hash-wasm wants KiB
    hashLength: 32,
    outputType: "binary",
  });
}
