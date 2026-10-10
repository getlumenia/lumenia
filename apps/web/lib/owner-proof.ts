/**
 * Owner proofs: "this account authorizes X", signed by the account's own key (LUMENIA ACCOUNT
 * CONTRACT v1, section 1). One builder for every proof the web sends: a backup write, the
 * "is this backup mine?" check, releasing an email, and an ask to join real money.
 *
 * The message is lib/handles.ts::handleProofMessage, the one copy of that string on this side. What
 * differs between callers is the NETWORK, and it is always the network of the HOST the proof goes
 * to, never the device's switch: the sponsor rebuilds the message with its own network, so a proof
 * signed for the other one is refused (lib/recovery-client.ts recoveryHostNetwork, lib/pilot-ask.ts).
 *
 * Pure apart from the signer and the clock, and both can be handed in, which is how the self-tests
 * pin the contract's golden vectors. Loads with no window or localStorage.
 */
import { handleProofMessage, type ProofAction } from "./handles";
import type { Signer } from "./signer";

/** The sponsor's own name for a network. */
export type ProofNetwork = "testnet" | "mainnet";

/** What the sponsor verifies: the account, when, a one-time nonce, and the signature. */
export interface OwnerProof {
  pubkey: string;
  ts: number;
  nonce: string;
  proof: string;
}

/** The signer has no raw-message signing (a v2 passkey smart account): no proof can be made. */
export class NoProofSignerError extends Error {
  constructor() {
    super("This account can't sign here.");
    this.name = "NoProofSignerError";
  }
}

/** emailId(email): lowercase hex SHA-256 of the trimmed, lowercased address (contract 0.3). */
export async function emailId(email: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 16 lowercase hex characters. */
export function proofNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Sign `action` over `name` for the host's `network`. `at` pins the time and the nonce, for the
 * golden vectors; in the app both are fresh on every call, because the sponsor refuses a message
 * it has seen before and one more than 300 seconds old.
 */
export async function signOwnerProof(
  signer: Signer,
  action: ProofAction,
  name: string,
  network: ProofNetwork,
  at: { ts?: number; nonce?: string } = {},
): Promise<OwnerProof> {
  if (!signer.signMessage) throw new NoProofSignerError();
  const pubkey = signer.publicKey();
  const ts = at.ts ?? Math.floor(Date.now() / 1000);
  const nonce = at.nonce ?? proofNonce();
  const message = handleProofMessage(action, name, pubkey, ts, nonce, network);
  const signature = await signer.signMessage(new TextEncoder().encode(message));
  return { pubkey, ts, nonce, proof: toBase64(signature) };
}
