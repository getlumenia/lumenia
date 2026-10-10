/**
 * The website's recovery client, on the LUMENIA ACCOUNT CONTRACT v1 (sections 1, 2 and 6).
 *
 * One email backs up one account. This module is how the website keeps to that:
 *
 *   storeBox      writes a backup, ALWAYS signed by the account it backs up. A row already holding
 *                 another account's backup comes back as a BackupConflict carrying that box (and,
 *                 for a row no account is tied to yet, a single-use ticket), never as an overwrite.
 *   fetchBox      reads a backup with the emailed code, and says whether its row is tied to an
 *                 account (`bound`), with a ticket to tie it when it is not.
 *   checkMine     asks whether this email's backup is tied to THIS account. No code needed, and the
 *                 answer is only ever about the signer's own account.
 *   releaseEmail  unties an email from this account, so it can back up another one.
 *
 * Every call goes to the RECOVERY host (NEXT_PUBLIC_SPONSOR_URL, the practice-money Worker) on both
 * networks, so one backup serves practice and real money alike, and every proof is signed for that
 * host's network (recoveryHostNetwork), never the device's switch.
 *
 * OLDER SERVERS. A field the server does not send means "unknown", and a 404 from a route it does
 * not have means "unknown". Neither ever means "no" (contract 0.4).
 *
 * lib/recovery-api.ts keeps the older calls exactly as they are for the extension, which imports
 * them (apps/extension/src/core/index.ts); this module is only for the website.
 */
import type { RecoveryBox } from "./recovery";
import type { Signer } from "./signer";
import { emailId, signOwnerProof, NoProofSignerError, type OwnerProof, type ProofNetwork } from "./owner-proof";

const RECOVERY_HOST = (process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev").replace(/\/$/, "");
const MAINNET_HOST = (process.env.NEXT_PUBLIC_SPONSOR_URL_MAINNET ?? "").replace(/\/$/, "");

/**
 * The network the recovery host answers for. The sponsor rebuilds every signed message with its OWN
 * network, so a proof signed for the device's network would be refused the moment somebody switched
 * to real money. The same rule lib/recovery-api.ts has always used.
 */
export function recoveryHostNetwork(): ProofNetwork {
  return MAINNET_HOST !== "" && MAINNET_HOST === RECOVERY_HOST ? "mainnet" : "testnet";
}

/** The sentence every refusal to post an unsigned backup shows. */
export const CANNOT_SIGN_BACKUP = "We couldn't sign this backup. Unlock and try again.";
/** A ticket that is used up, too old, or for another email (contract 2.2). */
export const TICKET_EXPIRED = "That took too long. Send a new code and try again.";
const BAD_CODE = "That code is wrong or has expired.";

/** The email already backs up another account (contract 2.2, 409 "email-taken"). Nothing was written. */
export class BackupConflict extends Error {
  /** true: the row is tied to no account yet, so a ticket came with it and it may be replaced. */
  readonly unbound: boolean;
  /** Exactly what /recovery-fetch would return for the same code. */
  readonly box: RecoveryBox;
  /** Single use, 600 seconds, this email only. Only for an unbound row. */
  readonly ticket?: string;
  constructor(message: string, unbound: boolean, box: RecoveryBox, ticket?: string) {
    super(message);
    this.name = "BackupConflict";
    this.unbound = unbound;
    this.box = box;
    this.ticket = ticket;
  }
}

/** A refusal with the server's own sentence and code (an otp-budget 429, a ticket 401, ...). */
export class RecoveryRefusal extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "RecoveryRefusal";
    this.status = status;
    this.code = code;
  }
}

type FetchLike = typeof fetch;
interface CallOpts {
  /** For the self-tests. Destructured before use: a browser fetch called as a method throws. */
  fetchImpl?: FetchLike;
  /** Pins the proof's time and nonce, for the golden vectors. */
  at?: { ts?: number; nonce?: string };
}

const HEX64 = /^[0-9a-f]{64}$/;

function isBox(v: unknown): v is RecoveryBox {
  return Boolean(v) && typeof v === "object" && Array.isArray((v as { copies?: unknown }).copies);
}

async function post(fetchImpl: FetchLike, path: string, body: unknown): Promise<Response> {
  return fetchImpl(`${RECOVERY_HOST}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A 429 carries the server's own sentence (contract 2.1: the otp-budget refusal); keep it. */
function refusalFrom(res: Response, body: Record<string, unknown>, fallback: string): RecoveryRefusal {
  const message = typeof body.error === "string" && body.error ? body.error : fallback;
  return new RecoveryRefusal(message, res.status, typeof body.code === "string" ? body.code : undefined);
}

async function proofFor(signer: Signer, name: string, at?: CallOpts["at"]): Promise<OwnerProof> {
  return signOwnerProof(signer, "links", name, recoveryHostNetwork(), at);
}

/**
 * Store `box` as the backup `email` opens.
 *
 * Exactly one of `code` (the 6 digits just mailed) and `ticket` (from a BackupConflict or fetchBox,
 * standing in for a code exactly once). `signer` is the key being backed up, and it is REQUIRED:
 * a backup that goes out unsigned is a row any later holder of the inbox code can replace, which is
 * how one email ended up silently swapping between two accounts. So an unsignable backup is refused
 * here, before anything is posted.
 *
 * `replace` asks the server to take over a row that is tied to NO account yet (contract 2.2); it
 * never overrides a row tied to another account.
 *
 * Returns `bound`: true when the server tied the row to this account, false when it stored it
 * untied, null when an older server did not say.
 */
export async function storeBox(
  opts: {
    email: string;
    box: RecoveryBox;
    code?: string;
    ticket?: string;
    signer: Signer | undefined;
    replace?: boolean;
    alias?: { aliasId: string; aliasProof: string };
  } & CallOpts,
): Promise<{ bound: boolean | null }> {
  const { email, box, code, ticket, signer, replace, alias, fetchImpl = fetch, at } = opts;
  if ((code === undefined) === (ticket === undefined)) throw new Error("A code or a ticket is needed, not both.");
  if (!signer) throw new Error(CANNOT_SIGN_BACKUP);
  const id = await emailId(email);
  let owner: OwnerProof;
  try {
    owner = await proofFor(signer, id, at);
  } catch (e) {
    if (e instanceof NoProofSignerError) throw new Error(CANNOT_SIGN_BACKUP);
    throw e;
  }
  const res = await post(fetchImpl, "/recovery", {
    id,
    box,
    ...(ticket !== undefined ? { ticket } : { code }),
    owner,
    ...(replace ? { replace: true } : {}),
    ...(alias ?? {}),
  });
  const body = await readJson(res);
  if (res.ok) return { bound: typeof body.bound === "boolean" ? body.bound : null };
  if (res.status === 409 && body.code === "email-taken" && isBox(body.box)) {
    const unbound = body.unbound === true;
    const t = unbound && typeof body.ticket === "string" && HEX64.test(body.ticket) ? body.ticket : undefined;
    throw new BackupConflict(typeof body.error === "string" ? body.error : "That email already holds a backup.", unbound, body.box, t);
  }
  if (res.status === 401) throw new RecoveryRefusal(ticket !== undefined ? TICKET_EXPIRED : BAD_CODE, 401, ticket !== undefined ? "ticket-expired" : "bad-code");
  if (res.status === 429) throw refusalFrom(res, body, "Too many tries for this email. Wait, then ask for a new code.");
  throw refusalFrom(res, body, "Couldn't secure your money. Try again.");
}

/**
 * Read the backup `email` opens, with the code just mailed. null when there is none.
 *
 * `bound` is null on an older server that does not say. `ticket` comes only with a row tied to no
 * account (bound false): the restore uses it once to tie the row to the account it opened.
 */
export async function fetchBox(
  email: string,
  code: string,
  opts: CallOpts = {},
): Promise<{ box: RecoveryBox; bound: boolean | null; ticket?: string } | null> {
  const { fetchImpl = fetch } = opts;
  const res = await post(fetchImpl, "/recovery-fetch", { id: await emailId(email), code });
  const body = await readJson(res);
  if (res.status === 404) return null;
  if (res.status === 401) throw new RecoveryRefusal(BAD_CODE, 401, "bad-code");
  if (res.status === 429) throw refusalFrom(res, body, "Too many tries for this email. Wait, then ask for a new code.");
  if (!res.ok) throw refusalFrom(res, body, "Couldn't restore your money. Try again.");
  if (!isBox(body.box)) return null;
  const bound = typeof body.bound === "boolean" ? body.bound : null;
  const ticket = bound === false && typeof body.ticket === "string" && HEX64.test(body.ticket) ? body.ticket : undefined;
  return { box: body.box, bound, ...(ticket ? { ticket } : {}) };
}

export type MineAnswer = "mine" | "not-mine" | "unknown";

/**
 * Is `email`'s backup tied to the signer's account? No code: the proof is the account's own
 * signature, and the server's answer never says anything about another account (no row, an untied
 * row and someone else's row all answer "not mine"). A 404 (an older server), a refusal or no
 * connection is "unknown", never "not mine".
 */
export async function checkMine(email: string, signer: Signer, opts: CallOpts = {}): Promise<MineAnswer> {
  const { fetchImpl = fetch, at } = opts;
  try {
    const id = await emailId(email);
    const owner = await proofFor(signer, `check:${id}`, at);
    const res = await post(fetchImpl, "/recovery-check", { id, owner });
    if (!res.ok) return "unknown";
    const body = await readJson(res);
    return body.mine === true ? "mine" : body.mine === false ? "not-mine" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Untie `email` from the signer's account (contract 2.5), so the email can back up another one. The
 * row is deleted only if it is tied to this account. "not-yours" when it is not (no row, an untied
 * row, another account's row); "unknown" from an older server or with no connection.
 */
export async function releaseEmail(email: string, signer: Signer, opts: CallOpts = {}): Promise<"released" | "not-yours" | "unknown"> {
  const { fetchImpl = fetch, at } = opts;
  try {
    const id = await emailId(email);
    const owner = await proofFor(signer, `release:${id}`, at);
    const res = await post(fetchImpl, "/recovery-release", { id, owner });
    if (res.ok) return "released";
    const body = await readJson(res);
    if (res.status === 409 && body.code === "not-yours") return "not-yours";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * After a restore, what this browser may record about the restored account's backup (contract 6):
 * tie a row that is tied to NO account to the key it just opened (the same box, the ticket the
 * fetch handed back, `replace`, the restored key's signature), or ask whether a tied row is this
 * account's own. Never throws: the account is back either way.
 *
 *   true   the server tied it to this account, or says it already is;
 *   false  the server said the row is tied to no account (or to another one), and it still is: a
 *          bind that did not go through (the ticket ran out, no connection) changes nothing, so the
 *          account line offers "Back it up again", never "backed up with ...";
 *   null   nobody could say (an older server, a check that did not get an answer).
 */
export async function tieRestored(
  email: string,
  fetched: { box: RecoveryBox; bound: boolean | null; ticket?: string },
  signer: Signer,
  opts: CallOpts = {},
): Promise<boolean | null> {
  if (fetched.bound === false) {
    if (!fetched.ticket) return false;
    try {
      const r = await storeBox({ email, box: fetched.box, ticket: fetched.ticket, replace: true, signer, ...opts });
      return r.bound ?? false;
    } catch {
      return false;
    }
  }
  const mine = await checkMine(email, signer, opts);
  return mine === "mine" ? true : mine === "not-mine" ? false : null;
}

/**
 * What the backup step does after a BackupConflict, once the password typed for it has been tried
 * on the stored box (contract 5.4):
 *
 *   bind-own      it opened to THIS account: the person's own older backup. Tie it with the ticket.
 *   offer-bring   it opened to ANOTHER account the person holds: offer to bring that one here, and
 *                 to back this one up with another email. Never offered as a replace.
 *   ask-password  it did not open: ask for that backup's own password; "Replace it" only for a row
 *                 tied to no account (a tied row is never replaced).
 */
export type ConflictPlan = { kind: "bind-own" } | { kind: "offer-bring" } | { kind: "ask-password"; offerReplace: boolean };

export function conflictPlan(openedPubkey: string | null, accountPubkey: string, unbound: boolean): ConflictPlan {
  if (openedPubkey === accountPubkey) return { kind: "bind-own" };
  if (openedPubkey !== null) return { kind: "offer-bring" };
  return { kind: "ask-password", offerReplace: unbound };
}

/** Under every backup and restore email field (contract 5.5). */
export const EMAIL_HINT =
  "Type it the same way every time: first.last@gmail.com and firstlast@gmail.com are two different emails here.";
