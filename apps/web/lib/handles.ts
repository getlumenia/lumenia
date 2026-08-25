"use client";

/**
 * Names (`@handle`) — client side (docs/IDENTITY_AND_ACCOUNTS.md §3).
 *
 * A name is claimed with a SIGNATURE from the account itself, not with a session: this module
 * builds the exact message `apps/sponsor/src/lib/handles.ts::handleProofMessage` will rebuild, has
 * the account sign it, and posts the pair. The server can refuse a name; it can never move one,
 * and it never sees a key.
 *
 * THE MESSAGE STRING IS A CONTRACT. Two copies of it exist — here and on the sponsor — and a drift
 * between them does not fail loudly, it silently refuses every user. Both sides are pinned by
 * tests (`pnpm --filter @lumenia/sponsor test:identity`), and the format is versioned so a change
 * has to be deliberate.
 *
 * What the network reads: nothing here moves money, and none of it belongs on the claim route. A
 * name is a sender-side and returning-user-side thing.
 */
import { activeNetwork, type NetworkId } from "./network";
import type { Signer } from "./signer";

/** The sponsor's own vocabulary for a network; the web calls the same chain "public". */
type SponsorNetwork = "testnet" | "mainnet";

function sponsorNetwork(id: NetworkId = activeNetwork().id): SponsorNetwork {
  return id === "public" ? "mainnet" : "testnet";
}

function base(): string {
  return activeNetwork().sponsorUrl.replace(/\/$/, "");
}

type ProofAction = "claim" | "release" | "links";

/** Must match apps/sponsor/src/lib/handles.ts::handleProofMessage exactly. */
export function handleProofMessage(
  action: ProofAction,
  name: string,
  pubkey: string,
  ts: number,
  nonce: string,
  network: SponsorNetwork,
): string {
  return `lumenia-handle-${action}:v1:${name}:${pubkey}:${ts}:${nonce}:${network}`;
}

function proofNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export interface SignedProof {
  pubkey: string;
  ts: number;
  nonce: string;
  proof: string;
}

/**
 * Have the account sign an authorization for `action`. Throws in plain language when the active
 * signer cannot sign a raw message — a v2 passkey smart account will need a different proof, and
 * pretending otherwise would produce a signature nobody can verify.
 */
export async function signHandleProof(
  signer: Signer,
  action: ProofAction,
  name: string,
): Promise<SignedProof> {
  if (!signer.signMessage) {
    throw new Error("This account can't prove a name on this device yet.");
  }
  const pubkey = signer.publicKey();
  const ts = Math.floor(Date.now() / 1000);
  const nonce = proofNonce();
  const message = handleProofMessage(action, name, pubkey, ts, nonce, sponsorNetwork());
  const signature = await signer.signMessage(new TextEncoder().encode(message));
  return { pubkey, ts, nonce, proof: toBase64(signature) };
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

export interface HandleAvailability {
  /** Held by somebody — including you. */
  taken: boolean;
  /** The account it resolves to, when taken. */
  address?: string;
  /** Free to claim right now. False for a reserved word, a bad shape, or a cooling-down name. */
  available: boolean;
  /** Why not, when not — already in the product's voice, straight from the registry. */
  reason?: string;
}

/** Is this name free? Safe to call while typing; the registry is a public lookup by design. */
export async function checkHandle(name: string): Promise<HandleAvailability> {
  const res = await fetch(`${base()}/handle?name=${encodeURIComponent(name)}`);
  if (res.ok) {
    const body = (await res.json()) as { address?: string };
    return { taken: true, available: false, address: body.address };
  }
  if (res.status === 404) {
    const body = (await res.json().catch(() => ({}))) as { available?: boolean; error?: string };
    return { taken: false, available: Boolean(body.available), reason: body.error };
  }
  throw new Error(await readError(res, "Couldn't check that name. Try again."));
}

/** The name this account holds, or null. */
export async function handleOf(address: string): Promise<string | null> {
  const res = await fetch(`${base()}/handle-of?pubkey=${encodeURIComponent(address)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await readError(res, "Couldn't read your name."));
  return ((await res.json()) as { name?: string }).name ?? null;
}

/** Claim `name` for the signer's account. Claiming a name you already hold succeeds quietly. */
export async function claimHandle(signer: Signer, rawName: string): Promise<{ name: string }> {
  const name = rawName.trim().toLowerCase().replace(/^@+/, "");
  const signed = await signHandleProof(signer, "claim", name);
  const res = await fetch(`${base()}/handle-claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, ...signed }),
  });
  if (!res.ok) throw new Error(await readError(res, "Couldn't take that name."));
  return { name };
}

/**
 * Give a name up. It does not become free — nobody may register it for 30 days, including you.
 * The UI says so before calling this, because a name people have paid to is not a thing to release
 * casually.
 */
export async function releaseHandle(signer: Signer, rawName: string): Promise<void> {
  const name = rawName.trim().toLowerCase().replace(/^@+/, "");
  const signed = await signHandleProof(signer, "release", name);
  const res = await fetch(`${base()}/handle-release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, ...signed }),
  });
  if (!res.ok) throw new Error(await readError(res, "Couldn't give that name up."));
}

/** The federation address a name resolves as, for display: `meric*getlumenia.com`. */
export function federationAddress(name: string): string {
  const domain = process.env.NEXT_PUBLIC_FEDERATION_DOMAIN ?? "getlumenia.com";
  return `${name}*${domain}`;
}

/*
 * DELIBERATELY ABSENT: a `getlumenia.com/@name` pay page.
 *
 * A name is worth having the moment it resolves — federation makes it work in any Stellar wallet
 * today, and request-money can address it. A hosted "pay @meric" page is a separate surface with
 * its own decisions (what a stranger sees, what an unclaimed name shows, how an amount is asked
 * for), and shipping a link that 404s would be worse than not offering one. It is the next step,
 * recorded in docs/IDENTITY_AND_ACCOUNTS.md §9 rather than half-built here.
 */
