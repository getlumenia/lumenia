"use client";

/**
 * Recovery API client — talks to the sponsor's zero-knowledge recovery endpoints
 * (RECOVERY_ARCHITECTURE §12). The box is BUILT/OPENED in lib/recovery.ts (the seed
 * never leaves the browser); this module ships CIPHERTEXT, a one-time email code, and — on a
 * backup — a SIGNATURE from the account over the box's own id, which is what stops a stolen inbox
 * replacing a working backup. It never ships a key, a password or a seed.
 * The id is SHA-256(normalized email) — computed identically to the sponsor (idForEmail),
 * so the server never needs the raw email to find the box.
 */
import type { RecoveryBox } from "./recovery";
import { handleProofMessage } from "./handles";
import type { Signer } from "./signer";

const SPONSOR_URL = (process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev").replace(/\/$/, "");

/** The box id for an email — must match the sponsor's idForEmail exactly. */
export async function emailToId(email: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${SPONSOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorFrom(res: Response, fallback: string): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  return j.error ?? fallback;
}

/** Email a single-use code proving control of `email`. */
export async function requestRecoveryOtp(email: string): Promise<void> {
  const res = await post("/recovery-otp", { email });
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't send the code. Try again."));
}

/**
 * Store the ciphertext-only box for `email`, gated by the emailed code.
 *
 * `aliasId` (from recovery.ts::prfToBoxId) stores a SECOND copy under the passkey-derived id, and
 * that copy is what "find my money with Face ID" reads later with no email and no code. It rides
 * behind this same verified code on purpose: the backup flow already holds one, so adding the
 * alias widens no surface.
 */
/**
 * A local marker that a recovery box was actually STORED for this account.
 *
 * Four surfaces were using `phase === 2` to mean "backed up": /start's "Locked, and backed up.",
 * /pilot skipping its own backup step, /account's Disconnect showing the soft one-tap confirmation
 * instead of the type-REMOVE wall, and the /start step body promising "a new phone can bring your
 * money back with your email". But `phase === 2` only means "locked with a password on this
 * device" — LockMoneyCard sets it without ever creating a box. So a user could be told four times
 * that they were backed up, clear their browser, and find the only copy of their key was gone.
 *
 * Local-only and deliberately conservative: it can be wrong in the safe direction (a device that
 * restored a backup made elsewhere reads "not backed up" and is merely asked again), never in the
 * dangerous one.
 */
const BACKED_UP_KEY = "lumenia.backedup";

export function markBackedUp(pubkey: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(BACKED_UP_KEY) ?? "[]") as string[];
    if (!all.includes(pubkey)) localStorage.setItem(BACKED_UP_KEY, JSON.stringify([...all, pubkey]));
  } catch {
    /* storage blocked — hasBackup() stays false, which is the safe answer */
  }
}

export function hasBackup(pubkey: string | undefined): boolean {
  if (!pubkey) return false;
  try {
    return (JSON.parse(localStorage.getItem(BACKED_UP_KEY) ?? "[]") as string[]).includes(pubkey);
  } catch {
    return false;
  }
}

/** What the account signs to authorize writing its own box — the shape the sponsor verifies. */
export interface OwnerProof {
  pubkey: string;
  ts: number;
  nonce: string;
  proof: string;
}

/**
 * The chain the RECOVERY host answers for — which is not necessarily the one this device spends on.
 *
 * Every call in this module goes to NEXT_PUBLIC_SPONSOR_URL whatever network the user is in, so one
 * backup stays findable from both practice and real money. The sponsor rebuilds the signed message
 * with its OWN network, so signing with the device's active network (what lib/handles.ts does, and
 * why signHandleProof is not reused here) would produce a proof this host refuses the moment
 * somebody switches — a backup that fails for exactly the users who have real money in it.
 */
const MAINNET_SPONSOR_URL = (process.env.NEXT_PUBLIC_SPONSOR_URL_MAINNET ?? "").replace(/\/$/, "");
function recoveryHostNetwork(): "testnet" | "mainnet" {
  return MAINNET_SPONSOR_URL !== "" && MAINNET_SPONSOR_URL === SPONSOR_URL ? "mainnet" : "testnet";
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * "This account authorizes writing box `id`" — the same `links` proof the identity routes take,
 * rebuilt and checked by apps/sponsor/src/lib/recovery-store.ts::ownerHashFrom. The message string
 * comes from lib/handles.ts so only ONE copy of that contract exists on this side.
 *
 * Returns undefined when the active signer cannot sign a raw message (a v2 passkey smart account
 * has no such operation) — that stores an UNBOUND row rather than failing, because a backup nobody
 * can make is worse than one nobody has bound yet. Every v1 account CAN sign, so the live backup
 * path binds its row; an unbound one means the device could not be unlocked at that moment.
 */
async function ownerProofFor(id: string, signer: Signer): Promise<OwnerProof | undefined> {
  if (!signer.signMessage) return undefined;
  const pubkey = signer.publicKey();
  const ts = Math.floor(Date.now() / 1000);
  const nonce = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const message = handleProofMessage("links", id, pubkey, ts, nonce, recoveryHostNetwork());
  const signature = await signer.signMessage(new TextEncoder().encode(message));
  return { pubkey, ts, nonce, proof: toBase64(signature) };
}

/**
 * `signer` is what binds the stored row to this account.
 *
 * The emailed code proves control of an INBOX, and the id is SHA-256 of the address it was mailed
 * to — so a code alone is the whole distance between somebody else's mailbox and the only copy of
 * their key. Backup is the one moment the account is demonstrably in hand (the seed has just been
 * unlocked, or the password has just been set), so that is where the signature is taken.
 *
 * Both trailing arguments are REQUIRED-but-nullable rather than optional, so a new caller has to
 * decide about the signature instead of dropping it by accident: an omitted one costs nothing at
 * the call site and silently un-protects the row. Passing undefined still stores a FIRST box — a
 * new user has no account to prove yet, and a backup that is hard to make is a backup nobody has —
 * but that row stays replaceable by anyone who can read the mail, and once a row IS bound the
 * sponsor refuses a write that arrives without a matching proof.
 */
export async function storeRecoveryBox(
  email: string,
  code: string,
  box: RecoveryBox,
  alias: { aliasId: string; aliasProof: string } | undefined,
  signer: Signer | undefined,
): Promise<void> {
  const id = await emailToId(email);
  const owner = signer ? await ownerProofFor(id, signer) : undefined;
  const res = await post("/recovery", { id, box, code, ...(owner ? { owner } : {}), ...(alias ?? {}) });
  if (res.status === 401) throw new Error("That code is wrong or has expired.");
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't secure your money. Try again."));
}

/**
 * Fetch a box by its passkey-derived id. No email, no code — the id itself is 256 bits that only a
 * user-verified passkey ceremony on this origin can produce, and what comes back is ciphertext
 * that the same passkey has to open. Returns null when there is no such backup.
 */
export async function fetchRecoveryBoxByPrfId(aliasId: string): Promise<RecoveryBox | null> {
  const res = await post("/recovery-alias-fetch", { id: aliasId });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't look for your backup. Try again."));
  const data = (await res.json()) as { box?: RecoveryBox };
  return data.box ?? null;
}

/** Fetch the box for `email`, gated by the code. Returns null if there is no backup. */
export async function fetchRecoveryBox(email: string, code: string): Promise<RecoveryBox | null> {
  const id = await emailToId(email);
  const res = await post("/recovery-fetch", { id, code });
  if (res.status === 404) return null;
  if (res.status === 401) throw new Error("That code is wrong or has expired.");
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't restore your money. Try again."));
  const data = (await res.json()) as { box?: RecoveryBox };
  return data.box ?? null;
}
