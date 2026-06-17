/**
 * Account identity (Tyler condition #2: address-stable).
 *
 * The Stellar account address is the user's stable identity. It is stored and
 * referenced as data — it is NOT re-derived from whichever Signer is active.
 * This is what makes the v1→v2 migration a *signer swap* (KMS/local Ed25519 →
 * passkey smart-account) instead of a per-user account migration: the address
 * never changes, only the authority behind it.
 */
export interface Account {
  /** Stable Stellar address (G...). Persisted; never recomputed from the signer. */
  readonly address: string;
  /** Opaque handle to the current recovery method (Argon2id primary, PRF upgrade). */
  readonly recovery: "argon2id" | "argon2id+prf";
}
