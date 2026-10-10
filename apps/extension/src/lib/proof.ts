/**
 * An owner proof: the account's own Ed25519 signature that it authorizes one request about one
 * email (LUMENIA ACCOUNT CONTRACT v1, section 1). The sponsor rebuilds the same message with its OWN
 * network and checks the signature, the clock (300 s) and that the message was never used before.
 *
 * Built here, in the extension, rather than taken from apps/web/lib/handles.ts: the extension imports
 * nothing new from the website's library, and the message is pinned to the contract's golden vectors
 * in the self-tests instead (test/account.selftest.ts, test/router.selftest.ts).
 *
 * It signs a message, never a transaction: nothing here can move money.
 */
import type { Signer } from "../core";
import { ExtError } from "./errors";

/** "links" for the recovery rows (write, check, release), "pilot" for asking to join real money. */
export type ProofAction = "links" | "pilot";
/** The network of the HOST the proof is sent to (recovery: always "testnet"; the pilot: "mainnet"). */
export type ProofNetwork = "testnet" | "mainnet";

export interface OwnerProof {
  pubkey: string;
  /** unix seconds */
  ts: number;
  /** 16 lowercase hex */
  nonce: string;
  /** base64 Ed25519 signature by pubkey over the UTF-8 of proofMessage(...) */
  proof: string;
}

/** Must equal the sponsor's handleProofMessage (apps/sponsor/src/lib/handles.ts) byte for byte. */
export function proofMessage(action: ProofAction, name: string, pubkey: string, ts: number, nonce: string, network: ProofNetwork): string {
  return `lumenia-handle-${action}:v1:${name}:${pubkey}:${ts}:${nonce}:${network}`;
}

function randomNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Sign `name` for `action` on `network` with the account's key. `fixed` is for the self-tests only:
 * it pins the time and the nonce so the result can be compared with the contract's golden vectors.
 */
export async function ownerProof(
  signer: Signer,
  action: ProofAction,
  name: string,
  network: ProofNetwork,
  fixed?: { ts: number; nonce: string },
): Promise<OwnerProof> {
  if (!signer.signMessage) throw new ExtError("internal", "This account can't sign that here.");
  const pubkey = signer.publicKey();
  const ts = fixed?.ts ?? Math.floor(Date.now() / 1000);
  const nonce = fixed?.nonce ?? randomNonce();
  const signature = await signer.signMessage(new TextEncoder().encode(proofMessage(action, name, pubkey, ts, nonce, network)));
  return { pubkey, ts, nonce, proof: toBase64(signature) };
}
