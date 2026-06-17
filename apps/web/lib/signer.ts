/**
 * Signer abstraction (Tyler condition #1).
 *
 * Everything that signs goes through this ONE interface. v1 uses a classic
 * Ed25519 key unlocked by biometric/password; v2 swaps in an OZ passkey
 * smart-account signer — WITHOUT changing the claim flow or the account
 * address (see ./account.ts). The rest of the app must never know which
 * concrete signer is in use.
 */
import type { Transaction } from "@stellar/stellar-sdk";

export interface Signer {
  /** Stellar public key (G...) of the account this signer controls. */
  publicKey(): string;
  /** Sign a transaction and return it (mutated/clone) ready to submit. */
  sign(tx: Transaction): Promise<Transaction>;
  /** Which concrete backend — for diagnostics only, never for control flow. */
  readonly kind: "local-ed25519" | "kms" | "passkey-smart-account";
}

/**
 * v1 placeholder: a local Ed25519 signer. The real implementation keeps the
 * secret encrypted at rest (Argon2id-wrapped, PRF upgrade) and only decrypts
 * it transiently after biometric/password unlock. Stubbed here so the
 * skeleton compiles and the claim flow can be wired against the interface.
 */
export function createLocalSigner(_unlock: () => Promise<Uint8Array>): Signer {
  throw new Error("not implemented — v1 local Ed25519 signer (Argon2id-wrapped)");
}
