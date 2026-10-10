/**
 * Asking to join real money, signed by the account it is for (LUMENIA ACCOUNT CONTRACT v1, 1 and 3.2).
 *
 * The ask used to be a public key and an email, unsigned: anybody could file a request for any key,
 * and an email already used by another wallet was dropped without a word to anyone. Now:
 *
 *   - the ask carries the account's own signature (action "pilot", over the email's id), so a
 *     request can only ever be filed for the key in use, from the page that holds it;
 *   - the email is proven: by the backup it already protects for THIS account (no code needed), or
 *     by a 6-digit code mailed to it (requestPilotCode), which the server asks for when it cannot
 *     tell;
 *   - every refusal comes back typed, with the server's own sentence, and the result says what
 *     actually happened (filed, already asked, a mail sent or not) rather than a bare "ok".
 *
 * The pilot host is the real-money Worker. A build with no mainnet asks the practice Worker, and
 * signs for its network ("testnet"): the sponsor rebuilds the message with its own network.
 *
 * Pure apart from the fetch and the signer, both of which can be handed in; loads with no window.
 */
import { mainnetConfig, testnetConfig } from "./network";
import { handleProofMessage } from "./handles";
import type { Signer } from "./signer";
import { emailId, signOwnerProof, NoProofSignerError, type OwnerProof, type ProofNetwork } from "./owner-proof";
import { askPilotStatus, pilotStanding } from "./pilot-access";

const norm = (url: string) => url.replace(/\/$/, "");

/**
 * Where an ask goes (contract 0.2): the real-money Worker, and only in a build with no real money
 * the practice one. Never the device's switch: asking is not a money movement, and an ask filed on
 * whichever network the device happens to be on would land in two places for one person.
 */
export function pilotHost(): string {
  return norm(mainnetConfig()?.sponsorUrl ?? testnetConfig().sponsorUrl);
}

/** The pilot host's own network: "mainnet" when it is this build's real-money Worker. */
export function pilotHostNetwork(host: string): ProofNetwork {
  const mainnet = mainnetConfig();
  return mainnet && norm(mainnet.sponsorUrl) === norm(host) ? "mainnet" : "testnet";
}

/** The exact message the sponsor verifies for an ask (contract 1). */
export function pilotProofMessage(emailHash: string, pubkey: string, ts: number, nonce: string, network: ProofNetwork): string {
  return handleProofMessage("pilot", emailHash, pubkey, ts, nonce, network);
}

type FetchLike = typeof fetch;

/** Mail a 6-digit code to `email` from the pilot host, with the pilot's own wording (contract 2.1). */
export async function requestPilotCode(host: string, email: string, opts: { fetchImpl?: FetchLike } = {}): Promise<void> {
  const { fetchImpl = fetch } = opts;
  const res = await fetchImpl(`${norm(host)}/recovery-otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: email.trim(), purpose: "pilot" }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" && body.error ? body.error : "Couldn't send the code. Try again.");
  }
}

export type AskRefusalCode =
  | "code-required"
  | "bad-code"
  | "bad-proof"
  | "email-taken"
  | "proof-required"
  | "store-unavailable"
  | "rate-limited"
  | "failed";

export type AskResult =
  | {
      ok: true;
      /** The wallet's state after the ask; null from an older server, which does not say (re-read the status). */
      state: "pending" | "approved" | "rejected" | null;
      /** Whether a mail to the owner went out because of this ask. */
      filed: boolean;
      /** This account had asked before. */
      already: boolean;
      /** The short address of another wallet that asked with this email in the last 90 days. */
      emailAlsoFor?: string;
    }
  | { ok: false; code: AskRefusalCode; message: string };

const REFUSAL_CODES: readonly AskRefusalCode[] = ["code-required", "bad-code", "bad-proof", "email-taken", "proof-required", "store-unavailable"];

/**
 * Ask to join for the signer's account. `code` only when the server asked for one (code-required):
 * the first ask goes without, because an email that already backs this account up needs none.
 */
export async function askToJoin(opts: {
  host: string;
  signer: Signer;
  email: string;
  code?: string;
  src: "web";
  fetchImpl?: FetchLike;
  /** Pins the proof's time and nonce, for the golden vector. */
  at?: { ts?: number; nonce?: string };
}): Promise<AskResult> {
  const { host, signer, email, code, src, fetchImpl = fetch, at } = opts;
  const pubkey = signer.publicKey();
  let owner: OwnerProof;
  try {
    owner = await signOwnerProof(signer, "pilot", await emailId(email), pilotHostNetwork(host), at);
  } catch (e) {
    if (e instanceof NoProofSignerError) {
      return { ok: false, code: "bad-proof", message: "This account can't sign a request on this device." };
    }
    throw e;
  }
  let res: Response;
  try {
    res = await fetchImpl(`${norm(host)}/pilot-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey, email: email.trim(), owner, ...(code ? { code } : {}), src }),
    });
  } catch {
    return { ok: false, code: "failed", message: "We couldn't reach the server. Check your connection and try again." };
  }
  const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const sentence = typeof body.error === "string" && body.error ? body.error : "";
  if (res.ok) {
    const state = body.state === "pending" || body.state === "approved" || body.state === "rejected" ? body.state : null;
    return {
      ok: true,
      state,
      filed: body.filed === true,
      already: body.already === true,
      ...(typeof body.emailAlsoFor === "string" && body.emailAlsoFor ? { emailAlsoFor: body.emailAlsoFor } : {}),
    };
  }
  if (res.status === 429) return { ok: false, code: "rate-limited", message: sentence || "Too many tries. Wait a minute, then try again." };
  const known = REFUSAL_CODES.find((c) => c === body.code);
  if (known) return { ok: false, code: known, message: sentence || "Please try again." };
  if (res.status === 503) return { ok: false, code: "store-unavailable", message: sentence || "We couldn't record that just now. Try again in a minute." };
  return { ok: false, code: "failed", message: sentence || "Please try again." };
}

/**
 * An older server answers a successful ask with a bare {"ok":true} (or {"ok":true,"already":true})
 * and no state, and it also answered that way when it DROPPED the ask (an email another wallet had
 * used). So a result with no state is checked against /pilot-status before anything is said:
 * pending (or further) is what it looks like, "none" means the ask did not go through, and a status
 * that cannot be read is said as such. Any other result passes through untouched.
 */
export async function settleAsk(opts: {
  host: string;
  pubkey: string;
  result: AskResult;
  fetchImpl?: FetchLike;
}): Promise<AskResult> {
  const { host, pubkey, result, fetchImpl } = opts;
  if (!result.ok || result.state !== null) return result;
  const read = await askPilotStatus({ sponsorUrl: host, pubkey, ...(fetchImpl ? { fetchImpl } : {}) });
  const standing = pilotStanding(read);
  if (standing === "pending") return { ...result, state: "pending" };
  if (standing === "approved" || standing === "no-sends" || standing === "open") return { ...result, state: "approved" };
  if (standing === "declined" || standing === "revoked") return { ...result, state: "rejected" };
  if (standing === "none") return { ok: false, code: "failed", message: ASK_DID_NOT_GO_THROUGH };
  return { ok: false, code: "failed", message: ASK_UNCONFIRMED };
}

/** An older server said ok, and the status still reads "never asked". */
export const ASK_DID_NOT_GO_THROUGH = "Your request didn't go through. Try again later.";
/** An older server said ok, and the status could not be read to confirm it. */
export const ASK_UNCONFIRMED = "We couldn't confirm your request just now. Check again in a minute.";

/** The words of the ask (contract 5.2), the same on the website and in the extension. */
export const ASK_COPY = {
  heading: "Ask to join real money",
  emailKnown: (masked: string) => `We'll use the email that backs up this account: ${masked}.`,
  useDifferentEmail: "Use a different email",
  emailLabel: "Your email",
  emailHint: (short: string) => `Use the email that backs up this account (${short}).`,
  codeStep: (email: string) => `We sent a 6-digit code to ${email}. Enter it to confirm this email is yours.`,
  codeField: "6-digit code",
  ask: "Ask to join",
  asking: "Asking",
  askMore: "Ask for more sends",
  /** /pilot only: the extension holds its own account, and asks for it itself. */
  extensionNote: "Asking for an account in the Lumenia extension? Open the extension and ask from Real money there.",
} as const;

/** Which result an accepted ask shows. "standing" means: no result screen, the standing says it. */
export type AskView = "filed" | "already" | "more-filed" | "more-already" | "standing";

/**
 * `moreSends`: the ask was "Ask for more sends", from an approved account with every send used.
 * A settled result (settleAsk) always has a state; a pending one is "filed" the first time and
 * "already" after, and an approved one is a request for more sends, mailed now or already asked.
 */
export function askView(result: Extract<AskResult, { ok: true }>, moreSends: boolean): AskView {
  if (result.state === "pending") return result.already ? "already" : "filed";
  if (result.state === "approved" && moreSends) return result.filed ? "more-filed" : "more-already";
  return "standing";
}

/** The result's title and line (contract 5.2), naming the account and the masked email. */
export function askResultCopy(view: Exclude<AskView, "standing">, v: { short: string; masked: string }): { title: string; line: string } {
  switch (view) {
    case "filed":
      return { title: "Request sent.", line: `We'll email ${v.masked} when this account (${v.short}) is approved.` };
    case "already":
      return { title: "You've already asked.", line: `This account (${v.short}) is on the list. We'll email ${v.masked} when it is approved.` };
    case "more-filed":
      return { title: "Asked for more sends.", line: `We'll email ${v.masked} when this account (${v.short}) can send again.` };
    case "more-already":
      return { title: "You've already asked for more sends.", line: `We'll email ${v.masked} when this account (${v.short}) can send again.` };
  }
}

/** When the same email asked for another wallet in the last 90 days (`emailAlsoFor`). */
export function alsoAskedLine(other: string): string {
  return `This email also asked to join for account ${other}.`;
}

