/**
 * SponsorSigner seam — the sponsor's signing capability, abstracted so the hot
 * env key (this sprint) and an external KMS raw-signer are drop-in interchangeable.
 * The rest of the service never touches a raw secret.
 *
 * `sign` may be async: the KMS signer (lib/kms-signer.ts) raw-signs the 32-byte tx
 * hash over the network (AWS KMS Ed25519, Spike #1b mechanics) and wraps it as a
 * DecoratedSignature. Call sites `await signer.sign(tx)` — a no-op for the sync
 * env-key signer.
 */
import { Keypair, type Transaction, type FeeBumpTransaction } from "@stellar/stellar-sdk";

export interface SponsorSigner {
  /** The sponsor's public account address (G...). */
  publicKey(): string;
  /** Add the sponsor's signature to a tx (mutates it in place). May be async (KMS). */
  sign(tx: Transaction | FeeBumpTransaction): void | Promise<void>;
}

/** Env hot-key signer: wraps a local Ed25519 Keypair (S...). Testnet-sprint default. */
export class EnvKeypairSigner implements SponsorSigner {
  private readonly kp: Keypair;

  constructor(secret: string) {
    this.kp = Keypair.fromSecret(secret);
  }

  publicKey(): string {
    return this.kp.publicKey();
  }

  sign(tx: Transaction | FeeBumpTransaction): void {
    tx.sign(this.kp);
  }
}

export function signerFromSecret(secret: string): SponsorSigner {
  return new EnvKeypairSigner(secret);
}
