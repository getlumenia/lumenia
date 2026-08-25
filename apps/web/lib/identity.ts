"use client";

/**
 * Ways back in — client side (docs/IDENTITY_AND_ACCOUNTS.md §5).
 *
 * READ THIS BEFORE WIRING ANY OF IT TO A BUTTON: connecting Google, GitHub, X, an email address or
 * a passkey does NOT sign anybody in, and must never be labelled as if it does. Each connection
 * files a copy of the account's ALREADY-ENCRYPTED backup under an id derived from something the
 * person controls, so a future device can FIND it. Opening it still takes the password or the
 * passkey. The product has no sign-in, because there is nothing to sign in to.
 *
 * The useful consequence, and the reason the check endpoint exists: when somebody connects a
 * passkey that already leads to another account, we can say *"this Face ID already opens @meric"*
 * instead of silently overwriting the other account's route home.
 */
import { activeNetwork } from "./network";
import type { RecoveryBox } from "./recovery";
import { signHandleProof } from "./handles";
import type { Signer } from "./signer";

export type Provider = "passkey" | "email" | "google" | "github" | "x";

/** Providers that need an app registered before they can be offered at all. */
export const OAUTH_PROVIDERS: Provider[] = ["google", "github", "x"];

export const PROVIDER_LABEL: Record<Provider, string> = {
  passkey: "Face ID",
  email: "Email",
  google: "Google",
  github: "GitHub",
  x: "X",
};

function base(): string {
  return activeNetwork().sponsorUrl.replace(/\/$/, "");
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

/**
 * How the caller proves it holds the identity. One of:
 *  - passkey: the PRF-derived id plus a second, independent PRF output
 *  - email:   the address plus the code we mailed
 *  - ticket:  a one-time value the sponsor minted in its own OAuth callback
 */
export type IdentityProof =
  | { kind: "passkey"; id: string; proof: string }
  | { kind: "email"; email: string; code: string }
  | { kind: "ticket"; ticket: string };

export interface IdentityCheck {
  taken: boolean;
  provider: Provider;
  /** Only present when taken — the account this identity leads to. */
  address?: string;
  /** That account's name, when it has one. What makes the warning legible. */
  handle?: string;
  label?: string;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Which connections this deployment can actually offer right now. */
export async function availableProviders(): Promise<Provider[]> {
  try {
    const res = await fetch(`${base()}/identity-providers`);
    if (!res.ok) return ["passkey", "email"];
    return ((await res.json()) as { providers?: Provider[] }).providers ?? ["passkey", "email"];
  } catch {
    // An unreachable sponsor is not a statement about what exists; fall back to the two that need
    // no registration, and let the attach call be the thing that fails honestly.
    return ["passkey", "email"];
  }
}

/** "Is this already connected, and to whom?" — answered only because the caller just proved it holds it. */
export async function checkIdentity(proof: IdentityProof): Promise<IdentityCheck> {
  const res = await post("/identity-check", { proof });
  if (!res.ok) throw new Error(await readError(res, "We couldn't check that."));
  return (await res.json()) as IdentityCheck;
}

export interface AttachConflict {
  address: string;
  handle?: string;
}

/**
 * Connect a proved identity to this account, filing the ciphertext box under it.
 *
 * Throws with the OTHER account's name when the identity already leads somewhere else, rather than
 * taking it over — the person who set that up would otherwise lose their way back in with no event
 * they could have seen.
 */
export async function attachIdentity(
  proof: IdentityProof,
  address: string,
  box?: RecoveryBox,
  passkeyProof?: string,
): Promise<void> {
  const res = await post("/identity-attach", { proof, address, box, passkeyProof });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string; conflict?: AttachConflict };
  if (body.conflict) {
    const who = body.conflict.handle ? `@${body.conflict.handle}` : "another account on Lumenia";
    throw new Error(`That already opens ${who}. Disconnect it there first, or use a different one.`);
  }
  throw new Error(body.error ?? "We couldn't connect that.");
}

/** Fetch the account + box a proved identity leads to. Null when it leads nowhere. */
export async function fetchByIdentity(
  proof: IdentityProof,
): Promise<{ address: string; handle?: string; box?: RecoveryBox } | null> {
  const res = await post("/identity-fetch", { proof });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await readError(res, "We couldn't look that up."));
  return (await res.json()) as { address: string; handle?: string; box?: RecoveryBox };
}

/** Disconnect a proved identity. */
export async function detachIdentity(proof: IdentityProof): Promise<void> {
  const res = await post("/identity-detach", { proof });
  if (!res.ok) throw new Error(await readError(res, "We couldn't disconnect that."));
}

/**
 * Disconnect a provider from THIS account, authorized by the account's own signature.
 *
 * The other direction — "take my passkey off whatever it opens" — needs the identity's own proof
 * and lives on `detachIdentity`. This one is what a settings screen needs: going back to Google
 * just to remove Google is friction, and re-proving a passkey you have lost is impossible.
 */
export async function detachMine(signer: Signer, provider: Provider): Promise<void> {
  const signed = await signHandleProof(signer, "links", "");
  const res = await post("/identity-detach-mine", { ...signed, provider });
  if (!res.ok) throw new Error(await readError(res, "We couldn't disconnect that."));
}

/**
 * What this account has connected. Signed by the account, because a list of somebody's ways back
 * in is not public information about an address.
 */
export async function listLinks(signer: Signer): Promise<{ provider: Provider; createdAt: number }[]> {
  const signed = await signHandleProof(signer, "links", "");
  const res = await post("/identity-links", signed);
  if (!res.ok) throw new Error(await readError(res, "We couldn't read your connections."));
  return ((await res.json()) as { links?: { provider: Provider; createdAt: number }[] }).links ?? [];
}

/**
 * Begin an OAuth round trip. Returns the URL to send the browser to; the sponsor keeps the state
 * and the PKCE verifier, and the client secret never touches a browser.
 *
 * The browser comes back to `/settings?connected=<ticket>&provider=<p>`, and that ticket is what
 * `finishConnect` turns into an attach. Full-page navigation rather than a popup: popups are
 * unreliable in the in-app webviews a lot of this product's users arrive through.
 */
export async function startConnect(provider: Provider, address?: string): Promise<string> {
  const res = await post("/identity-start", { provider, address });
  if (!res.ok) throw new Error(await readError(res, `We couldn't start that connection.`));
  return ((await res.json()) as { authUrl: string }).authUrl;
}
