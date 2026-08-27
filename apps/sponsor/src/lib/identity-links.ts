/**
 * Identity links — the "ways back in" store (docs/IDENTITY_AND_ACCOUNTS.md §5).
 *
 * READ §2 OF THAT DOCUMENT BEFORE CHANGING ANYTHING HERE. A linked identity is a LOCATOR and a
 * GATE, never a key: it files a copy of the user's ALREADY-ENCRYPTED recovery box under an id
 * derived from something they control (a passkey, an email address, a Google/GitHub/X account), and
 * it decides who may be handed that ciphertext back. What opens the box is still exactly two
 * things — the password (Argon2id) or the passkey (WebAuthn PRF). Nothing in this file can decrypt
 * anything, and nothing in this file may ever be described to a user as signing in.
 *
 * ONE MECHANISM, MANY PROVIDERS. Every provider ends at the same pair of operations — prove control
 * of an identity, then attach/fetch/detach the box filed under it — so adding the next provider is
 * an adapter, not an architecture:
 *
 *   passkey  id = the PRF-derived box id      proof = a second independent PRF output
 *   email    id = H(email)                    proof = the emailed 6-digit code (recovery-otp.ts)
 *   google   id = H(provider:subject)         proof = a server-side OAuth code exchange
 *   github   "                                "
 *   x        "                                "
 *
 * WHY A LOOKUP NEEDS A PROOF. "Is this identity already connected?" is a useful answer for the user
 * holding the identity and an enumeration oracle for everyone else — feed it hashed emails and it
 * reports which ones have a Lumenia account, and what they are called. So a check is only ever
 * answered to a caller that just proved control of the identity it is asking about.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { kvConfigFromEnv } from "./rate-limit.js";
import { validateBox, type RecoveryBox } from "./recovery-store.js";
import { handleOf } from "./handles.js";

export type Provider = "passkey" | "email" | "google" | "github" | "x";
export const PROVIDERS: Provider[] = ["passkey", "email", "google", "github", "x"];
/** Providers whose proof is an OAuth round trip (the ones §8.1 has to register apps for). */
export const OAUTH_PROVIDERS = ["google", "github", "x"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** The sponsor's own vocabulary (config.network). The web maps its "public" onto "mainnet". */
type NetworkId = "testnet" | "mainnet";

const KEY_IDENTITY = "lumenia:identity:";
const KEY_OF = "lumenia:identity-of:";
const KEY_STATE = "lumenia:oauth-state:";
const KEY_TICKET = "lumenia:oauth-ticket:";

const ID_RE = /^[0-9a-f]{64}$/;
const STATE_TTL_SEC = 600;
const TICKET_TTL_SEC = 300;
const MAX_ROW_BYTES = 8192;
/** A single account may attach this many identities. A bound, not a target. */
const MAX_LINKS_PER_ACCOUNT = 12;

/* --------------------------------- tiny KV layer ---------------------------------- */

const mem = new Map<string, { value: string; exp?: number }>();

function memGet(key: string): string | null {
  const row = mem.get(key);
  if (!row) return null;
  if (row.exp && row.exp <= Date.now()) {
    mem.delete(key);
    return null;
  }
  return row.value;
}

async function kvGet(key: string): Promise<string | null> {
  const kv = kvConfigFromEnv();
  if (!kv) return memGet(key);
  const res = await fetch(`${kv.url}/get/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${kv.token}` },
  });
  if (!res.ok) throw new Error(`identity store returned ${res.status}`);
  const data = (await res.json()) as { result?: string | null };
  return data.result ?? null;
}

async function kvSet(key: string, value: string, ttlSec?: number): Promise<void> {
  if (value.length > MAX_ROW_BYTES) throw new Error("identity row too large");
  const kv = kvConfigFromEnv();
  if (!kv) {
    mem.set(key, { value, exp: ttlSec ? Date.now() + ttlSec * 1000 : undefined });
    return;
  }
  const cmd = ["SET", key, value, ...(ttlSec ? ["EX", String(ttlSec)] : [])];
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify([cmd]),
  });
  if (!res.ok) throw new Error(`identity store returned ${res.status}`);
}

async function kvDel(key: string): Promise<void> {
  const kv = kvConfigFromEnv();
  if (!kv) {
    mem.delete(key);
    return;
  }
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify([["DEL", key]]),
  });
  if (!res.ok) throw new Error(`identity store returned ${res.status}`);
}

/** Test seam: drop the in-memory fallback between cases. No effect when KV is configured. */
export function __resetIdentityStore(): void {
  mem.clear();
}

/* ------------------------------------ ids ----------------------------------------- */

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The id an identity is filed under. Domain-separated and versioned so the same email can never
 * collide with the recovery store's own email key, and so a future v2 derivation can coexist.
 * The passkey provider is the exception: its id IS the client's PRF-derived box id, which is
 * already 256 bits of secret, and re-hashing it here would throw that property away.
 */
export async function identityId(provider: Provider, subject: string): Promise<string> {
  if (provider === "passkey") {
    const id = subject.toLowerCase();
    if (!ID_RE.test(id)) throw new Error("passkey identity id must be 64-char hex");
    return id;
  }
  const normalized = provider === "email" ? subject.trim().toLowerCase() : subject.trim();
  if (!normalized) throw new Error("empty identity subject");
  return sha256Hex(`lumenia-id:v1:${provider}:${normalized}`);
}

/* ----------------------------------- the rows ------------------------------------- */

export interface IdentityRow {
  provider: Provider;
  /** The account this identity leads back to. */
  address: string;
  network: NetworkId;
  createdAt: number;
  /** The ciphertext box, so a fresh device can be handed it after proving control. Optional: a link
   *  can exist before a backup does, and an account with no box is still findable by address. */
  box?: RecoveryBox;
  /** passkey rows only: SHA-256 of the independent PRF proof, binding the row to that passkey. */
  proofHash?: string;
}

export interface LinkSummary {
  provider: Provider;
  id: string;
  createdAt: number;
}

async function readRow(id: string): Promise<IdentityRow | null> {
  const raw = await kvGet(KEY_IDENTITY + id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IdentityRow;
  } catch {
    return null;
  }
}

async function readLinks(network: NetworkId, address: string): Promise<LinkSummary[]> {
  const raw = await kvGet(`${KEY_OF}${network}:${address}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as LinkSummary[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeLinks(network: NetworkId, address: string, links: LinkSummary[]): Promise<void> {
  if (links.length === 0) {
    await kvDel(`${KEY_OF}${network}:${address}`);
    return;
  }
  await kvSet(`${KEY_OF}${network}:${address}`, JSON.stringify(links));
}

/* --------------------------------- proof of control -------------------------------- */

/**
 * How a caller proves it controls the identity it is naming. Exactly one of these must be present,
 * and each is checked by the route before anything is read or written.
 *
 *  - `passkey`: the id itself plus an independent PRF output. Both come from one user-verified
 *    ceremony on this origin; neither can be derived from the other.
 *  - `email`: the address plus a code this service mailed, verified by recovery-otp.
 *  - `ticket`: a one-time value this service minted in its OWN OAuth callback after exchanging a
 *    code with the provider. The user never sees the provider's token, and we never store it.
 */
export type IdentityProof =
  | { kind: "passkey"; id: string; proof: string }
  | { kind: "email"; email: string; code: string }
  | { kind: "ticket"; ticket: string };

export interface ResolvedIdentity {
  provider: Provider;
  id: string;
  /** Human-readable, for the UI only — never stored. e.g. the email or the provider account name. */
  label?: string;
}

export interface OAuthTicket {
  provider: OAuthProvider;
  subject: string;
  label?: string;
  address?: string;
  network: NetworkId;
}

/** Consume a one-time OAuth ticket. Single-use: reading it deletes it. */
async function consumeTicket(ticket: string): Promise<OAuthTicket | null> {
  if (!/^[0-9a-f]{32,64}$/.test(ticket)) return null;
  const raw = await kvGet(KEY_TICKET + ticket);
  if (!raw) return null;
  await kvDel(KEY_TICKET + ticket);
  try {
    return JSON.parse(raw) as OAuthTicket;
  } catch {
    return null;
  }
}

/**
 * Turn a proof into the identity it proves, or null when it proves nothing.
 * `verifyEmailOtp` is injected so this module never imports the mailer, and tests can drive it.
 */
export async function resolveProof(
  proof: IdentityProof,
  deps: { verifyEmailOtp: (email: string, code: string) => Promise<boolean> },
): Promise<ResolvedIdentity | null> {
  if (proof.kind === "passkey") {
    if (!ID_RE.test(proof.id) || !ID_RE.test(proof.proof)) return null;
    const row = await readRow(proof.id);
    if (row?.proofHash) {
      // Bound on first write; a later caller must present the same PRF proof (the write-IDOR fix
      // that recovery-store.ts documents for alias rows — same reasoning, same store shape).
      if ((await sha256Hex(proof.proof)) !== row.proofHash) return null;
    }
    return { provider: "passkey", id: proof.id };
  }
  if (proof.kind === "email") {
    const email = proof.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
    if (!(await deps.verifyEmailOtp(email, proof.code))) return null;
    return { provider: "email", id: await identityId("email", email), label: email };
  }
  const t = await consumeTicket(proof.ticket);
  if (!t) return null;
  return { provider: t.provider, id: await identityId(t.provider, t.subject), label: t.label };
}

/* ------------------------------------ operations ---------------------------------- */

export interface CheckResult {
  /** Is this identity already connected to an account? */
  taken: boolean;
  /** The account it leads to — returned ONLY to a caller that proved control of the identity. */
  address?: string;
  /** That account's `@name`, when it has one. This is what makes the warning useful. */
  handle?: string;
  provider: Provider;
  label?: string;
}

/**
 * "Is this passkey / email / Google account already connected — and to whom?"
 * The answer names the account, which is the whole point of the warning the user sees:
 * *"This Face ID already opens @meric."* Safe to answer because the caller just proved they hold
 * the identity being asked about.
 */
export async function checkIdentity(resolved: ResolvedIdentity, network: NetworkId): Promise<CheckResult> {
  const row = await readRow(resolved.id);
  if (!row) return { taken: false, provider: resolved.provider, label: resolved.label };
  const handle = await handleOf(row.address);
  return {
    taken: true,
    address: row.address,
    handle: handle ?? undefined,
    provider: resolved.provider,
    label: resolved.label,
  };
}

export type AttachResult =
  | { ok: true; provider: Provider; id: string; links: LinkSummary[] }
  | { ok: false; reason: string; conflict?: { address: string; handle?: string } };

/**
 * Connect a proved identity to an account, optionally filing the account's ciphertext box under it.
 *
 * REFUSES to re-point an identity that already leads to a DIFFERENT account. Overwriting would
 * silently break the other account's way back in — the person who set it up would find their route
 * gone with no event they could have noticed. The refusal carries the other account's name so the
 * UI can say what happened instead of failing blankly.
 */
export async function attachIdentity(
  resolved: ResolvedIdentity,
  address: string,
  network: NetworkId,
  box: unknown,
  passkeyProof?: string,
): Promise<AttachResult> {
  if (!StrKey.isValidEd25519PublicKey(address)) return { ok: false, reason: "invalid account address" };

  const existing = await readRow(resolved.id);
  if (existing && existing.address !== address) {
    const handle = await handleOf(existing.address);
    return {
      ok: false,
      reason: "That is already connected to another account.",
      conflict: { address: existing.address, handle: handle ?? undefined },
    };
  }

  const links = await readLinks(network, address);
  if (!links.some((l) => l.id === resolved.id) && links.length >= MAX_LINKS_PER_ACCOUNT) {
    return { ok: false, reason: "This account already has as many connections as we allow." };
  }

  const row: IdentityRow = {
    provider: resolved.provider,
    address,
    network,
    createdAt: existing?.createdAt ?? Date.now(),
    ...(box !== undefined && box !== null ? { box: validateBox(box) } : existing?.box ? { box: existing.box } : {}),
    ...(existing?.proofHash
      ? { proofHash: existing.proofHash }
      : resolved.provider === "passkey" && passkeyProof && ID_RE.test(passkeyProof)
        ? { proofHash: await sha256Hex(passkeyProof) }
        : {}),
  };
  await kvSet(KEY_IDENTITY + resolved.id, JSON.stringify(row));

  const next = links.some((l) => l.id === resolved.id)
    ? links
    : [...links, { provider: resolved.provider, id: resolved.id, createdAt: row.createdAt }];
  await writeLinks(network, address, next);
  return { ok: true, provider: resolved.provider, id: resolved.id, links: next };
}

/** Hand back the ciphertext filed under a proved identity — the "find my account" path. */
export async function fetchByIdentity(
  resolved: ResolvedIdentity,
): Promise<{ address: string; handle?: string; box?: RecoveryBox } | null> {
  const row = await readRow(resolved.id);
  if (!row) return null;
  const handle = await handleOf(row.address);
  return { address: row.address, handle: handle ?? undefined, box: row.box };
}

/** Disconnect a proved identity from the account it leads to. Deletes the row and its index entry. */
export async function detachIdentity(resolved: ResolvedIdentity): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await readRow(resolved.id);
  if (!row) return { ok: false, reason: "That is not connected." };
  await kvDel(KEY_IDENTITY + resolved.id);
  const links = (await readLinks(row.network, row.address)).filter((l) => l.id !== resolved.id);
  await writeLinks(row.network, row.address, links);
  return { ok: true };
}

/**
 * Disconnect every link of one provider from an account, authorized by the ACCOUNT rather than by
 * the identity.
 *
 * Requiring the identity's own proof to remove it reads tidy and behaves badly: taking a Google
 * connection off would mean a full round trip back to Google, and taking off a passkey you no
 * longer have — the exact case where you most want it gone — would be impossible. The account the
 * link points at is the party with standing here, and it proves itself with a signature.
 */
export async function detachProviderByAccount(
  address: string,
  network: NetworkId,
  provider: Provider,
): Promise<{ ok: true; removed: number }> {
  const links = await readLinks(network, address);
  const doomed = links.filter((l) => l.provider === provider);
  for (const link of doomed) {
    const row = await readRow(link.id);
    // Only delete a row that still points at THIS account — a link re-pointed elsewhere is not
    // this account's to remove, and a stale index entry must not become a way to break someone
    // else's route home.
    if (row && row.address === address) await kvDel(KEY_IDENTITY + link.id);
  }
  await writeLinks(
    network,
    address,
    links.filter((l) => l.provider !== provider),
  );
  return { ok: true, removed: doomed.length };
}

/**
 * Which identities does THIS account have connected? Returns provider + when, never the id itself:
 * the id is the lookup key, and an account listing is not proof of control over what it lists.
 */
export async function listLinks(
  address: string,
  network: NetworkId,
): Promise<{ provider: Provider; createdAt: number }[]> {
  if (!StrKey.isValidEd25519PublicKey(address)) return [];
  return (await readLinks(network, address)).map((l) => ({ provider: l.provider, createdAt: l.createdAt }));
}

/* -------------------------------- OAuth adapters ---------------------------------- */

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** Does this provider accept (and want) PKCE? GitHub OAuth apps do not. */
  pkce: boolean;
  /** Read the stable subject id + a human label out of the provider's user endpoint. */
  userUrl: string;
  readUser: (json: Record<string, unknown>) => { subject: string; label?: string } | null;
  /** X wants the client credentials as HTTP Basic on the token call. */
  basicAuth?: boolean;
}

function envPair(provider: OAuthProvider): { id?: string; secret?: string } {
  const upper = provider.toUpperCase();
  return {
    id: process.env[`OAUTH_${upper}_CLIENT_ID`],
    secret: process.env[`OAUTH_${upper}_CLIENT_SECRET`],
  };
}

function oauthConfig(provider: OAuthProvider): OAuthConfig | null {
  const { id, secret } = envPair(provider);
  if (!id || !secret) return null; // not registered yet — the UI says so rather than pretending
  const common = { clientId: id, clientSecret: secret };
  if (provider === "google") {
    return {
      ...common,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scope: "openid email",
      pkce: true,
      readUser: (j) => (typeof j.sub === "string" ? { subject: j.sub, label: typeof j.email === "string" ? j.email : undefined } : null),
    };
  }
  if (provider === "github") {
    return {
      ...common,
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userUrl: "https://api.github.com/user",
      scope: "read:user",
      pkce: false,
      readUser: (j) =>
        j.id !== undefined && j.id !== null
          ? { subject: String(j.id), label: typeof j.login === "string" ? `@${j.login}` : undefined }
          : null,
    };
  }
  return {
    ...common,
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    userUrl: "https://api.x.com/2/users/me",
    scope: "users.read",
    pkce: true,
    basicAuth: true,
    readUser: (j) => {
      const data = j.data as Record<string, unknown> | undefined;
      if (!data || typeof data.id !== "string") return null;
      return { subject: data.id, label: typeof data.username === "string" ? `@${data.username}` : undefined };
    },
  };
}

/** Which providers are actually usable right now (credentials present). */
export function availableOAuthProviders(): OAuthProvider[] {
  return OAUTH_PROVIDERS.filter((p) => oauthConfig(p) !== null);
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(new Uint8Array(digest))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Where the provider sends the browser back. Must match the app registration EXACTLY. */
export function oauthRedirectUri(provider: OAuthProvider): string {
  const base = (process.env.OAUTH_REDIRECT_BASE ?? process.env.SPONSOR_PUBLIC_URL ?? "").replace(/\/$/, "");
  return `${base}/oauth/${provider}/callback`;
}

/** Where the browser is sent after the callback finishes — the app's settings page. */
function webReturnUrl(): string {
  return (process.env.WEB_URL ?? "https://getlumenia.com").replace(/\/$/, "");
}

export async function startOAuth(
  provider: OAuthProvider,
  address: string | undefined,
  network: NetworkId,
): Promise<{ ok: true; authUrl: string } | { ok: false; reason: string }> {
  const cfg = oauthConfig(provider);
  if (!cfg) return { ok: false, reason: `${provider} is not available yet.` };
  if (!oauthRedirectUri(provider).startsWith("http")) {
    return { ok: false, reason: "this service has no public URL configured" };
  }
  const state = randomHex(16);
  const verifier = cfg.pkce ? randomHex(32) : "";
  await kvSet(KEY_STATE + state, JSON.stringify({ provider, verifier, address, network }), STATE_TTL_SEC);

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: oauthRedirectUri(provider),
    response_type: "code",
    scope: cfg.scope,
    state,
  });
  if (cfg.pkce) {
    params.set("code_challenge", await pkceChallenge(verifier));
    params.set("code_challenge_method", "S256");
  }
  return { ok: true, authUrl: `${cfg.authorizeUrl}?${params.toString()}` };
}

/**
 * The provider's redirect lands here. Exchanges the code SERVER-SIDE (the client secret never
 * reaches the browser), reads the stable subject, mints a one-time ticket, and sends the browser
 * back to the app with it. No provider access token is ever stored — it is used once, in this
 * function, and dropped.
 */
export async function finishOAuth(
  provider: string,
  code: string | null,
  state: string | null,
): Promise<{ ok: true; redirectTo: string } | { ok: false; reason: string }> {
  if (!OAUTH_PROVIDERS.includes(provider as OAuthProvider)) return { ok: false, reason: "unknown provider" };
  const p = provider as OAuthProvider;
  const cfg = oauthConfig(p);
  if (!cfg) return { ok: false, reason: `${p} is not available yet.` };
  if (!code || !state) return { ok: false, reason: "that connection did not complete" };

  const rawState = await kvGet(KEY_STATE + state);
  if (!rawState) return { ok: false, reason: "that connection expired — start again" };
  await kvDel(KEY_STATE + state);
  const parsed = JSON.parse(rawState) as { provider: OAuthProvider; verifier: string; address?: string; network: NetworkId };
  if (parsed.provider !== p) return { ok: false, reason: "that connection did not match" };

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: oauthRedirectUri(p),
    ...(cfg.pkce ? { code_verifier: parsed.verifier } : {}),
    ...(cfg.basicAuth ? {} : { client_id: cfg.clientId, client_secret: cfg.clientSecret }),
  });
  const tokenRes = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      ...(cfg.basicAuth
        ? { authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}` }
        : {}),
    },
    body: body.toString(),
  });
  if (!tokenRes.ok) return { ok: false, reason: "that provider refused the connection" };
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) return { ok: false, reason: "that provider refused the connection" };

  const userRes = await fetch(cfg.userUrl, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json", "user-agent": "lumenia" },
  });
  if (!userRes.ok) return { ok: false, reason: "could not read that account" };
  const user = cfg.readUser((await userRes.json()) as Record<string, unknown>);
  if (!user) return { ok: false, reason: "could not read that account" };

  const ticket = randomHex(24);
  await kvSet(
    KEY_TICKET + ticket,
    JSON.stringify({ provider: p, subject: user.subject, label: user.label, address: parsed.address, network: parsed.network } satisfies OAuthTicket),
    TICKET_TTL_SEC,
  );
  return { ok: true, redirectTo: `${webReturnUrl()}/settings?connected=${ticket}&provider=${p}` };
}
