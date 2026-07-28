/**
 * Optional claim password — the lock a sender can put on a money link.
 *
 * Without one, a money link is a bearer instrument: whoever opens it takes the money.
 * That is honest and it is fast, and it stays the default. But a link travels through
 * chat apps, and chats get forwarded, screenshotted and backed up. So a sender can
 * add a password that the recipient has to know before the money will move — the same
 * shape Interac e-Transfer has used for years, including its lesson: send the password
 * on a DIFFERENT channel than the link, because a thief who has the chat has both.
 *
 * HOW IT WORKS, and why it isn't a server check.
 *
 * The link key is not stored anywhere and not sent anywhere. It is DERIVED from two
 * halves: a random 32-byte seed that rides in the URL fragment, and the password that
 * never touches a URL. Both together produce the Ed25519 key the escrow will accept.
 * One half alone produces nothing.
 *
 *   linkKey = Ed25519( SHA-256( seed ‖ Argon2id(password, salt = SHA-256(domain ‖ seed)) ) )
 *
 * So the password is not "checked" by us and cannot be waved past. Whoever intercepts
 * the link holds half a key. To get the other half they must run Argon2id (48 MiB,
 * memory-hard) once per guess, on their own hardware — there is no server to rate-limit
 * because there is no server in the loop. That also means a WEAK password is a weak
 * lock: guessing is offline and unlimited, which is exactly what the send screen says
 * out loud rather than implying a strength we don't have.
 *
 * The recipient's side is instant and needs no network: derive the key, compare its
 * public half to the link id already in the URL path. Match = right password.
 *
 * If the sender forgets the password nothing is lost — the money still returns to them
 * after the 7-day window, because reclaiming is authorised by the sender's own account
 * and never touches the link key.
 */
import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";
import { deriveKek, DEFAULT_ARGON } from "./argon";

/** Fragment marker for a password-locked link: `#p1.<seed>`. Plain links keep `#S…`. */
const FRAGMENT_PREFIX = "p1.";
/** Domain separation so this KDF output can never collide with the recovery-box KEK. */
const DOMAIN = "lumenia.claim-password.v1";

function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const bytes = new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    joined.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
}

/** A fresh 32-byte link seed — the half that travels in the URL. */
export function makeLinkSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

/**
 * Derive the link keypair from the seed + password. Memory-hard by design: this is the
 * only thing standing between someone who intercepted the link and the money, so it is
 * deliberately slow (Argon2id at the app's standard params) on a phone AND on a rig.
 */
export async function deriveLinkKey(seed: Uint8Array, password: string): Promise<Keypair> {
  const domain = new TextEncoder().encode(DOMAIN);
  const salt = await sha256(domain, seed);
  const stretched = await deriveKek(password, salt.subarray(0, 16), DEFAULT_ARGON);
  const keySeed = await sha256(seed, stretched);
  return Keypair.fromRawEd25519Seed(Buffer.from(keySeed));
}

/** The URL fragment for a password-locked link (the seed only — never the password). */
export function passwordFragment(seed: Uint8Array): string {
  return `${FRAGMENT_PREFIX}${b64urlEncode(seed)}`;
}

export type LinkFragment =
  /** A plain bearer link: the fragment IS the key. */
  | { kind: "key"; secret: string }
  /** A password-locked link: the fragment is half of the key. */
  | { kind: "password"; seed: Uint8Array };

/** Read a claim URL's fragment. Returns null when there is nothing usable in it. */
export function parseLinkFragment(fragment: string): LinkFragment | null {
  const frag = fragment.replace(/^#/, "").trim();
  if (!frag) return null;
  if (frag.startsWith(FRAGMENT_PREFIX)) {
    const seed = b64urlDecode(frag.slice(FRAGMENT_PREFIX.length));
    return seed ? { kind: "password", seed } : null;
  }
  return { kind: "key", secret: frag };
}

/**
 * Try a password against a password-locked link. The link id in the URL path is the
 * public half of the real key, so a wrong password is caught locally and instantly —
 * no request, nothing leaked, and no way for a wrong guess to reach the escrow.
 */
export async function unlockLink(
  seed: Uint8Array,
  password: string,
  linkHex: string,
): Promise<{ ok: true; secret: string } | { ok: false }> {
  const kp = await deriveLinkKey(seed, password);
  const derived = Buffer.from(kp.rawPublicKey()).toString("hex");
  if (derived.toLowerCase() !== linkHex.toLowerCase()) return { ok: false };
  return { ok: true, secret: kp.secret() };
}

/**
 * A floor for claim passwords, softer than the recovery-password floor on purpose:
 * this one is spoken aloud on the phone or typed into a second app, so a 10-character
 * mixed-class rule would push people back to no password at all. Four characters of
 * anything is still theatre, though, so the floor is real.
 */
export function claimPasswordProblem(pw: string): string | null {
  if (pw.length < 6) return "Use at least 6 characters.";
  if (/^\d+$/.test(pw) && pw.length < 8) return "A short number is easy to guess — make it longer, or add letters.";
  if (/^(.)\1+$/.test(pw)) return "That's one character repeated — pick something else.";
  return null;
}
