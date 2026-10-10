/**
 * The extension's own client for the backup rows on the recovery host (LUMENIA ACCOUNT CONTRACT v1,
 * section 2). The website keeps its own; this one is built here because the extension imports
 * nothing new from apps/web/lib (the code mail still goes through core's requestRecoveryOtp).
 *
 * One host for both kinds of money: every call goes to the testnet Worker (testnetConfig().sponsorUrl),
 * whichever money is in use, so one backup is found from practice and real money alike. Every owner
 * proof is therefore signed for "testnet", the host's own network: a proof signed for the other one
 * is refused by the host.
 *
 * What it ships: the email's id (never the address), the backup ciphertext, a mailed code or a
 * single-use ticket, and a signature from the account. Never a key, a seed or a password.
 *
 * Against an older host every new field is optional: a missing `bound` reads as unknown (null), and a
 * 404 from a route it does not have reads as unknown, never as "no".
 */
import { testnetConfig, type RecoveryBox, type Signer } from "../core";
import { ExtError, fail } from "./errors";
import { emailId } from "./identity";
import { ownerProof } from "./proof";

const HOST_NETWORK = "testnet" as const;
const HEX64 = /^[0-9a-f]{64}$/;

/** "That took too long": a ticket is good for 600 s and one use (LUMENIA ACCOUNT CONTRACT v1, 5.4). */
export const TICKET_EXPIRED = "That took too long. Send a new code and try again.";

/**
 * The email already holds a backup for ANOTHER account (409 email-taken). Raised only after the code
 * (or ticket) was checked, so it tells the person nothing they could not read with that code anyway.
 * `box` is that backup, as /recovery-fetch would return it; `ticket` lets this one request bind or
 * replace an untied row without a second code.
 */
export class BackupConflict extends Error {
  constructor(
    readonly unbound: boolean,
    readonly box: RecoveryBox,
    readonly ticket: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "BackupConflict";
  }
}

function host(): string {
  return testnetConfig().sponsorUrl.replace(/\/$/, "");
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${host()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The answer's JSON object, or null when it is not one (an empty body, a proxy page, `null`). */
async function bodyOf(res: Response): Promise<Record<string, unknown> | null> {
  const j = (await res.json().catch(() => null)) as unknown;
  return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
}

const sentence = (s: string): string => (s ? `${s.trim().replace(/\.?$/, ".")}` : "");

/** A 429: the per-email code budget says so in its own words; any other limit is ours. */
function tooMany(b: Record<string, unknown> | null): ExtError {
  return b?.code === "otp-budget" && typeof b.error === "string" ? new ExtError("rate-limited", b.error) : fail("rate-limited");
}

const isBox = (v: unknown): v is RecoveryBox => !!v && typeof v === "object" && Array.isArray((v as { copies?: unknown }).copies);

export interface StoreRequest {
  email: string;
  box: RecoveryBox;
  /** the mailed code, or */
  code?: string;
  /** the single-use ticket a conflict or a fetch handed back (stands in for the code once) */
  ticket?: string;
  /** the account the backup belongs to: its signature binds the row to it */
  signer: Signer;
  /** take over a row that is not tied to any account yet (never a tied one) */
  replace?: boolean;
}

/**
 * Store a backup for `email`. Resolves with whether the host says the row is now tied to this
 * account (null: an older host that does not say). Throws BackupConflict when the email backs up
 * another account, and a named ExtError otherwise.
 */
export async function storeBox(r: StoreRequest): Promise<{ bound: boolean | null }> {
  const id = await emailId(r.email);
  const owner = await ownerProof(r.signer, "links", id, HOST_NETWORK);
  const res = await post("/recovery", {
    id,
    box: r.box,
    ...(r.ticket ? { ticket: r.ticket } : { code: r.code }),
    owner,
    ...(r.replace ? { replace: true } : {}),
  });
  const b = await bodyOf(res);
  if (res.ok) return { bound: typeof b?.bound === "boolean" ? b.bound : null };
  const reason = typeof b?.error === "string" ? b.error : "";
  if (res.status === 401) throw r.ticket ? new ExtError("bad-code", TICKET_EXPIRED) : fail("bad-code");
  if (res.status === 409 && b?.code === "email-taken") {
    if (isBox(b.box)) {
      const ticket = typeof b.ticket === "string" && HEX64.test(b.ticket) ? b.ticket : undefined;
      throw new BackupConflict(b.unbound === true, b.box, b.unbound === true ? ticket : undefined, sentence(reason));
    }
    throw new ExtError("email-taken", sentence(reason) || "That email already holds a backup for a different account. Use another email address for this one.");
  }
  if (res.status === 429) throw tooMany(b);
  // The host's own refusals, in its words: a tied row and no signature, an older host's "already holds
  // a backup for a different account", or a host that requires a signed backup. Nothing was stored.
  if ((res.status === 400 || res.status === 409) && reason) throw new ExtError("backup-refused", sentence(reason));
  throw new ExtError("internal", "We couldn't store your backup. Try again.");
}

export interface FetchedBox {
  box: RecoveryBox;
  /** tied to an account (true), not yet (false), or an older host that does not say (null) */
  bound: boolean | null;
  /** only for an untied row: lets the restored key bind it once, without a second code */
  ticket?: string;
}

/** The backup for `email`, traded for the mailed code, or null when there is none. */
export async function fetchBox(email: string, code: string): Promise<FetchedBox | null> {
  const id = await emailId(email);
  const res = await post("/recovery-fetch", { id, code });
  if (res.status === 404) return null;
  if (res.status === 401) throw fail("bad-code");
  const b = await bodyOf(res);
  if (res.status === 429) throw tooMany(b);
  if (!res.ok || !b) throw new ExtError("internal", "We couldn't reach your backup. Try again.");
  if (b.box === undefined || b.box === null) return null;
  const bound = typeof b.bound === "boolean" ? b.bound : null;
  const ticket = bound === false && typeof b.ticket === "string" && HEX64.test(b.ticket) ? b.ticket : undefined;
  return { box: b.box as RecoveryBox, bound, ...(ticket ? { ticket } : {}) };
}

/**
 * Does `email` back up the account `signer` holds? A signed question that needs no code and says
 * nothing about anyone else's account: no row, an untied row and another key's row all answer "no".
 * "unknown" for an older host (404), a refused signature (a device clock far off), a limit or the
 * network; `reason` carries the host's sentence when it gave one.
 */
export async function checkMine(email: string, signer: Signer): Promise<{ answer: "mine" | "not-mine" | "unknown"; reason?: string }> {
  try {
    const id = await emailId(email);
    const owner = await ownerProof(signer, "links", `check:${id}`, HOST_NETWORK);
    const res = await post("/recovery-check", { id, owner });
    const b = await bodyOf(res);
    if (!res.ok) return { answer: "unknown", ...(res.status === 401 && typeof b?.error === "string" ? { reason: b.error } : {}) };
    if (b?.mine === true) return { answer: "mine" };
    if (b?.mine === false) return { answer: "not-mine" };
    return { answer: "unknown" };
  } catch {
    return { answer: "unknown" };
  }
}

/**
 * Let `email` stop opening the account `signer` holds (its backup row is deleted): after a new
 * backup under another email. Only a row tied to this account is ever deleted by the host.
 */
export async function releaseEmail(email: string, signer: Signer): Promise<"released" | "not-yours" | "unknown"> {
  try {
    const id = await emailId(email);
    const owner = await ownerProof(signer, "links", `release:${id}`, HOST_NETWORK);
    const res = await post("/recovery-release", { id, owner });
    if (res.ok) return "released";
    const b = await bodyOf(res);
    return res.status === 409 && b?.code === "not-yours" ? "not-yours" : "unknown";
  } catch {
    return "unknown";
  }
}
