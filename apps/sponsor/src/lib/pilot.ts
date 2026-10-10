/**
 * PILOT ALLOWLIST + PER-WALLET TX BUDGET.
 *
 * The user-funded mainnet pilot admits ONLY owner-approved wallets, and gives each a hard
 * budget of `PILOT_MAX_TX` (default 5) ledger-confirmed value operations. This is a SECOND,
 * independent bound next to the env-driven per-drop cap (lib/caps.ts, `MAX_DROP_USDC` — the
 * mainnet Worker runs 5): caps bound how MUCH moves, this bounds WHO may move it and HOW OFTEN.
 *
 * Only active when PILOT_MODE=1 (set on the mainnet Worker). On testnet and in normal
 * operation it is a no-op — it can never gate the open product.
 *
 * Backed by the same Upstash store as the rate-limiter and caps. Because this guards REAL
 * money on mainnet it is FAIL-CLOSED: no KV, no admission. An allowlist you cannot read is
 * not an allowlist. Namespaced by network so a shared store can't let a testnet entry admit
 * a wallet on mainnet.
 *
 * The counter uses the same reserve-then-release pattern as caps: INCR reserves a slot on
 * check, and the caller releases (DECR) if the transaction fails — so only a LEDGER-CONFIRMED
 * value op permanently burns one of the wallet's slots.
 */
import { kvConfigFromEnv } from "./rate-limit.js";

/** True only when the mainnet Worker is running in pilot mode. */
export function pilotEnabled(): boolean {
  return process.env.PILOT_MODE === "1";
}

/* ------------------------- one-tap approval links (signed) -------------------------
 *
 * The approve/decline links in the owner's email grant the right to move REAL money, so what
 * rides in that URL matters. It used to be `PILOT_APPROVE_TOKEN` itself: one static secret, valid
 * forever, for every wallet and both actions. Anything that saw one link — a mail provider, a
 * forwarded message, a browser history, a Referer from the confirmation page — held the permanent
 * ability to approve any wallet it liked.
 *
 * Now the URL carries a SIGNATURE instead of the secret: HMAC-SHA256 over exactly this action,
 * this wallet, and an expiry. The secret never leaves the Worker, and a leaked link approves the
 * one wallet it was minted for, until it expires. Verification is constant-time — a link is
 * checked before anything is written, and a byte-by-byte early exit would leak the target.
 */
const APPROVE_TTL_SEC = 7 * 24 * 60 * 60; // an owner should not be racing a timer to answer

function approveSecret(): string | null {
  return process.env.PILOT_APPROVE_TOKEN || null;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compare two hex strings without an early exit. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `{ token, exp }` for an approve/decline link, or null when no secret is configured. */
export async function mintApprovalToken(
  action: "approve" | "reject",
  pubkey: string,
  nowMs: number,
): Promise<{ token: string; exp: number } | null> {
  const secret = approveSecret();
  if (!secret) return null;
  const exp = Math.floor(nowMs / 1000) + APPROVE_TTL_SEC;
  return { token: await hmacHex(secret, `${action}:${pubkey}:${exp}`), exp };
}

/** Is this a link we minted, for this action and wallet, that has not expired? */
export async function verifyApprovalToken(
  action: "approve" | "reject",
  pubkey: string,
  token: string,
  rawExp: string,
  nowMs: number,
): Promise<boolean> {
  const secret = approveSecret();
  if (!secret || !token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const exp = Number.parseInt(rawExp, 10);
  if (!Number.isFinite(exp) || exp * 1000 < nowMs) return false;
  return timingSafeEqualHex(token, await hmacHex(secret, `${action}:${pubkey}:${exp}`));
}

function maxTx(): number {
  const n = Number.parseInt(process.env.PILOT_MAX_TX ?? "5", 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/** How many real-money sends an approved wallet gets (`PILOT_MAX_TX`, default 5). */
export function pilotLimit(): number {
  return maxTx();
}

/** short(G): the first 6 characters, "...", the last 6. How every mail and owner page names an account. */
export function shortAddress(pubkey: string): string {
  return pubkey.length > 12 ? `${pubkey.slice(0, 6)}...${pubkey.slice(-6)}` : pubkey;
}

function net(): string {
  return process.env.STELLAR_NETWORK ?? "testnet";
}

// approval flag + spend counter, namespaced by network.
const apprKey = (pk: string) => `pilot:${net()}:appr:${pk}`;
const txKey = (pk: string) => `pilot:${net()}:tx:${pk}`;
const statusKey = (pk: string) => `pilot:${net()}:status:${pk}`;
/**
 * The applicant's contact address, keyed by the wallet it applied with.
 *
 * This is the ONE place in the service where an email sits next to a money address in the clear,
 * and it is deliberate rather than incidental: the owner approves or declines a specific wallet,
 * and the mail that tells that person the answer has nowhere else to look. Nothing else here works
 * this way — the "already applied" marker below is keyed by hash, recovery-otp.ts keys its boxes by
 * hash and stores no address at all, and the notify-me lists (waitlist.ts) carry no pubkey.
 *
 * Two bounds keep it from becoming a standing register of who holds which mainnet wallet: every
 * write carries `PILOT_EMAIL_RETENTION_SECONDS`, so an application nobody ever decides expires on
 * its own, and `revokePilot` / `forgetPilotEmail` erase it outright once there is nothing left to
 * tell that person.
 */
const emailKey = (pk: string) => `pilot:${net()}:email:${pk}`;
/** How long a contact address is kept — an owner's decision window, not a permanent record. */
export const PILOT_EMAIL_RETENTION_SECONDS = 90 * 24 * 60 * 60;
/**
 * The "this address already applied" marker: the LATEST wallet that asked with this email, kept for
 * the same 90 days as the contact. Keyed on a HASH of the address rather than the address itself: a
 * Redis key name is not a place to keep someone's email in the clear, and this store is shared with
 * the rate limiter and caps.
 */
async function seenEmailKey(email: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pilot:${net()}:seen:${hex}`;
}
/** Where the wallet last asked from ("web" or "ext"), for the approval mail. Same 90 days. */
const srcKey = (pk: string) => `pilot:${net()}:src:${pk}`;
/** Set for 7 days when an owner mail about this wallet was ACCEPTED, so a re-ask does not mail again. */
const mailedKey = (pk: string) => `pilot:${net()}:mailed:${pk}`;
export const PILOT_MAILED_SECONDS = 7 * 24 * 60 * 60;
/**
 * Set by `revokePilot`, deleted by `approvePilot` and `rejectPilot`. A revoked wallet and a declined
 * one both read state "rejected"; this is what tells the client which sentence is true ("we took
 * this account off real money" against "not approved for now").
 */
const revokedKey = (pk: string) => `pilot:${net()}:revoked:${pk}`;

interface Kv {
  url: string;
  token: string;
}

/** Run one Upstash pipeline; throws on any command error (so callers fail closed). */
async function pipe(kv: Kv, commands: (string | number)[][]): Promise<unknown[]> {
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify(commands.map((c) => c.map(String))),
  });
  if (!res.ok) throw new Error(`pilot store returned ${res.status}`);
  const rows = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  for (const r of rows) if (r?.error) throw new Error(`pilot store error: ${r.error}`);
  return rows.map((r) => r.result);
}

export interface PilotVerdict {
  ok: boolean;
  reason?: string;
  /** Call this if the transaction FAILED, to hand the wallet's slot back. */
  release?: () => Promise<void>;
}

/**
 * Admit `pubkey` for one value op, or reject. On `ok: true` a slot is already reserved; the
 * caller MUST invoke `release()` if the transaction ends up failing. Fail-closed: any store
 * problem rejects.
 */
export async function enforcePilot(pubkey: string): Promise<PilotVerdict> {
  const kv = kvConfigFromEnv();
  if (!kv) return { ok: false, reason: "pilot allowlist unavailable (fail-closed)" };

  let approved: unknown;
  try {
    [approved] = await pipe(kv, [["GET", apprKey(pubkey)]]);
  } catch (e) {
    return { ok: false, reason: `pilot allowlist unreadable (fail-closed): ${(e as Error).message}` };
  }
  if (approved !== "1") {
    return { ok: false, reason: "this wallet is not on the pilot allowlist yet" };
  }

  // Reserve a slot atomically. INCR is the single source of truth against concurrent requests.
  let used: number;
  try {
    const [count] = await pipe(kv, [["INCR", txKey(pubkey)]]);
    used = Number(count);
  } catch (e) {
    return { ok: false, reason: `pilot counter unavailable (fail-closed): ${(e as Error).message}` };
  }

  const limit = maxTx();
  if (used > limit) {
    // Over budget: give the slot back so a rejected request doesn't permanently consume one.
    await pipe(kv, [["DECR", txKey(pubkey)]]).catch(() => {});
    return { ok: false, reason: `pilot limit reached: ${limit} transactions used` };
  }

  return {
    ok: true,
    release: async () => {
      await pipe(kv, [["DECR", txKey(pubkey)]]).catch(() => {});
    },
  };
}

/** The lifecycle of a pilot application. */
export type PilotState = "none" | "pending" | "approved" | "rejected";
const STATES: readonly string[] = ["none", "pending", "approved", "rejected"];

/**
 * One reading of a wallet's three keys, the same everywhere (the status route, the request, the
 * owner list). The status key is a record and the allowlist flag is the gate, so where they
 * disagree the gate wins: a status of "approved" with no flag behind it is a wallet revoked before
 * revokePilot also wrote the status (2026-10-08), and it reads as declined-and-revoked, never as
 * approved.
 */
function readState(st: unknown, appr: unknown, revokedFlag: unknown): { state: PilotState; approved: boolean; revoked: boolean } {
  const approved = appr === "1";
  const recorded = typeof st === "string" && STATES.includes(st) ? (st as PilotState) : null;
  if (recorded === "approved" && !approved) return { state: "rejected", approved: false, revoked: true };
  const state: PilotState = recorded ?? (approved ? "approved" : "none");
  return { state, approved, revoked: revokedFlag === "1" };
}

/**
 * The join request from a page that does not sign it (the web before the signed ask, extension
 * 0.1.2 and 0.1.3 never call it). Records a `pending` application UNLESS this wallet already has a
 * state, OR another wallet is the latest to have asked with this email, in which case it returns
 * {created:false} and the caller sends NO request mail. Fail-open only when there's no store (so the
 * owner still sees the log and can act by hand).
 *
 * The collision is NOT recorded, and that is still a hole the comment here used to deny: anyone can
 * name a victim's address with a throwaway wallet first, and the victim's own unsigned ask is then
 * not filed. Nothing on this path proves the address belongs to the asker, so filing the second ask
 * would let a stranger attach an email to any wallet instead. What changed is that it is no longer
 * silent: the caller logs it and mails the owner (lib/pilot-request.ts), who can act by hand, and
 * the signed path (`filePilotRequest`) takes a proven inbox past it. The answer to the asker stays
 * the ordinary success shape, so nobody can probe whether an address applied.
 */
export async function startPilotRequest(
  pubkey: string,
  email: string,
): Promise<{ created: boolean; state: PilotState; collision?: boolean; other?: string }> {
  const kv = kvConfigFromEnv();
  if (!kv) return { created: true, state: "pending" };
  const clean = email.trim().toLowerCase();
  const seenKey = await seenEmailKey(clean);
  const [st, seen] = await pipe(kv, [
    ["GET", statusKey(pubkey)],
    ["GET", seenKey],
  ]);
  const existing = (typeof st === "string" ? st : "none") as PilotState;
  if (existing !== "none") return { created: false, state: existing };
  if (typeof seen === "string" && seen !== pubkey) {
    return { created: false, state: "pending", collision: true, other: seen };
  }
  await pipe(kv, [
    ["SET", statusKey(pubkey), "pending"],
    ["SET", seenKey, pubkey, "EX", PILOT_EMAIL_RETENTION_SECONDS],
    ["SET", emailKey(pubkey), clean, "EX", PILOT_EMAIL_RETENTION_SECONDS],
  ]);
  return { created: true, state: "pending" };
}

/** Where a signed ask came from. */
export type PilotSource = "web" | "ext";
/** How the asker proved the email is theirs: a code mailed to it, or a backup row it protects. */
export type InboxProof = "code" | "backup";

export interface PilotFiling {
  /** The wallet's state after this ask. */
  state: "pending" | "approved" | "rejected";
  /** False only for the ask that moved the wallet from none to pending. */
  already: boolean;
  /** The owner mail this ask calls for now: a new request, an ask for more sends, or none. */
  mail: "request" | "more-sends" | null;
  /** The latest OTHER wallet to ask with this email in the last 90 days, and where it stands. */
  other?: { pubkey: string; state: PilotState };
  used: number;
  limit: number;
  /** What the filing rests on, for the owner mail. */
  inboxProof: InboxProof;
  src?: PilotSource;
}

/**
 * The SIGNED join request (worker.ts /pilot-request with an owner proof), after the route has
 * checked that the account signed it and that the asker controls the email (a code, or a backup row
 * bound to this account). Both proven, the email is theirs to use, so a second wallet asking with an
 * address another wallet used is FILED, and the owner mail says so.
 *
 * By the wallet's state:
 *  - none: becomes pending, and the owner is mailed a request.
 *  - pending: the contact is refreshed; the owner is mailed again only when no owner mail about
 *    this wallet was accepted in the last 7 days (`mailedKey`).
 *  - approved with every send used: the owner is mailed that it asks for more, at most once a week.
 *  - approved with sends left, or rejected: the contact is refreshed and nothing else happens. A
 *    decline is the owner's to reopen, never the asker's.
 *
 * Every signed ask refreshes the contact (90 days), the email's latest-wallet marker (90 days) and,
 * when given, where it came from. This function decides the mail; the caller sends it and calls
 * `markOwnerMailed` only when the mailer accepted it. Throws on any store problem.
 */
export async function filePilotRequest(
  pubkey: string,
  email: string,
  src: PilotSource | undefined,
  opts: { inboxProof: InboxProof },
): Promise<PilotFiling> {
  const kv = kvConfigFromEnv();
  if (!kv) throw new Error("pilot store not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  const clean = email.trim().toLowerCase();
  const seenKey = await seenEmailKey(clean);
  const [st, appr, tx, revoked, seen, mailed] = await pipe(kv, [
    ["GET", statusKey(pubkey)],
    ["GET", apprKey(pubkey)],
    ["GET", txKey(pubkey)],
    ["GET", revokedKey(pubkey)],
    ["GET", seenKey],
    ["GET", mailedKey(pubkey)],
  ]);
  const now = readState(st, appr, revoked);
  const used = Number(tx ?? 0);
  const limit = maxTx();

  let other: PilotFiling["other"];
  if (typeof seen === "string" && seen !== "" && seen !== pubkey) {
    const [os, oa, orv] = await pipe(kv, [
      ["GET", statusKey(seen)],
      ["GET", apprKey(seen)],
      ["GET", revokedKey(seen)],
    ]);
    other = { pubkey: seen, state: readState(os, oa, orv).state };
  }

  const refresh: (string | number)[][] = [
    ["SET", emailKey(pubkey), clean, "EX", PILOT_EMAIL_RETENTION_SECONDS],
    ["SET", seenKey, pubkey, "EX", PILOT_EMAIL_RETENTION_SECONDS],
    ...(src ? [["SET", srcKey(pubkey), src, "EX", PILOT_EMAIL_RETENTION_SECONDS]] : []),
  ];
  const recentlyMailed = mailed === "1";
  const base = { other, used, limit, inboxProof: opts.inboxProof, ...(src ? { src } : {}) };

  if (now.state === "none") {
    // NX: two asks racing from one wallet file it once; the one that loses reads as a re-ask.
    const [created] = await pipe(kv, [["SET", statusKey(pubkey), "pending", "NX"], ...refresh]);
    if (created === "OK") return { ...base, state: "pending", already: false, mail: "request" };
    return { ...base, state: "pending", already: true, mail: recentlyMailed ? null : "request" };
  }
  await pipe(kv, refresh);
  if (now.state === "pending") {
    return { ...base, state: "pending", already: true, mail: recentlyMailed ? null : "request" };
  }
  if (now.state === "approved") {
    const spent = used >= limit;
    return { ...base, state: "approved", already: true, mail: spent && !recentlyMailed ? "more-sends" : null };
  }
  return { ...base, state: "rejected", already: true, mail: null };
}

/** The owner mail about this wallet was accepted: no second one for 7 days (`filePilotRequest`). */
export async function markOwnerMailed(pubkey: string): Promise<void> {
  const kv = kvConfigFromEnv();
  if (!kv) return;
  await pipe(kv, [["SET", mailedKey(pubkey), "1", "EX", PILOT_MAILED_SECONDS]]);
}

/** Was an owner mail about this wallet accepted in the last 7 days? Throws on a store error. */
export async function ownerMailedRecently(pubkey: string): Promise<boolean> {
  const kv = kvConfigFromEnv();
  if (!kv) return false;
  const [v] = await pipe(kv, [["GET", mailedKey(pubkey)]]);
  return v === "1";
}

/** Where this wallet last asked from, best effort: null when unknown or unreadable. */
export async function getPilotSrc(pubkey: string): Promise<PilotSource | null> {
  const kv = kvConfigFromEnv();
  if (!kv) return null;
  const [v] = await pipe(kv, [["GET", srcKey(pubkey)]]).catch(() => [null]);
  return v === "web" || v === "ext" ? v : null;
}

/**
 * Is this wallet on the allowlist right now? Reads the allowlist flag itself, the one thing
 * `enforcePilot` admits on, and THROWS on a store error instead of guessing. The approve link uses
 * it to decide "already approved": the status key is not the allowlist (a revoked wallet kept
 * status "approved" until 2026-10-08), and a failed read treated as "not approved" let a re-tap
 * fall through to `approvePilot`.
 */
export async function isPilotApproved(pubkey: string): Promise<boolean> {
  const kv = kvConfigFromEnv();
  if (!kv) throw new Error("pilot store not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  const [appr] = await pipe(kv, [["GET", apprKey(pubkey)]]);
  return appr === "1";
}

/** A wallet's application state (none/pending/approved/rejected), read as `pilotStatus` reads it. */
export async function getPilotState(pubkey: string): Promise<PilotState> {
  const kv = kvConfigFromEnv();
  if (!kv) return "none";
  const [st, appr, revoked] = await pipe(kv, [
    ["GET", statusKey(pubkey)],
    ["GET", apprKey(pubkey)],
    ["GET", revokedKey(pubkey)],
  ]).catch(() => [null, null, null]);
  return readState(st, appr, revoked).state;
}

/**
 * Owner-only: add a wallet to the pilot allowlist and mark its state approved.
 *
 * The used-slot counter is created at 0 only when it does not exist yet (SET ... NX). No approval
 * path refills slots a wallet already spent: a second tap on the emailed link, a re-approval after
 * a revoke, and a re-run of `pilot approve --file` over wallets already in all used to SET it back
 * to 0 and hand out a fresh allowance silently.
 */
export async function approvePilot(pubkey: string): Promise<void> {
  const kv = kvConfigFromEnv();
  if (!kv) throw new Error("pilot store not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  await pipe(kv, [
    ["SET", apprKey(pubkey), "1"],
    ["SET", txKey(pubkey), "0", "NX"],
    ["SET", statusKey(pubkey), "approved"],
    ["DEL", revokedKey(pubkey)],
    // The approval answers the ask that was mailed, so the next one (more sends) mails at once.
    ["DEL", mailedKey(pubkey)],
  ]);
}

/**
 * Owner-only: put a wallet's used-slot counter back to 0, and say what it was. Approval no longer
 * refills spent slots (approvePilot writes the counter with NX), so refilling is now a deliberate act
 * of its own: for the owner's own wallet after a rehearsal or a demo, never as a side effect.
 */
export async function resetPilotBudget(pubkey: string): Promise<number> {
  const kv = kvConfigFromEnv();
  if (!kv) throw new Error("pilot store not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  const [old] = await pipe(kv, [["GET", txKey(pubkey)]]);
  // A refill answers an ask for more sends, so the next one mails at once.
  await pipe(kv, [["SET", txKey(pubkey), "0"], ["DEL", mailedKey(pubkey)]]);
  return Number(old ?? 0);
}

/**
 * Owner-only: decline a wallet (state rejected, allowlist flag removed, not revoked). They can be
 * re-approved later.
 */
export async function rejectPilot(pubkey: string): Promise<void> {
  const kv = kvConfigFromEnv();
  if (!kv) throw new Error("pilot store not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  await pipe(kv, [
    ["SET", statusKey(pubkey), "rejected"],
    ["DEL", apprKey(pubkey)],
    ["DEL", revokedKey(pubkey)],
  ]);
}

/**
 * Remember a pilot applicant's contact email so approval can notify them. Best-effort and
 * separate from the allowlist flag: a missing store just means the owner acts on the
 * notification email by hand. Namespaced by network like everything else here, and written
 * under the same retention bound as the application itself.
 */
export async function storePilotEmail(pubkey: string, email: string): Promise<void> {
  const kv = kvConfigFromEnv();
  if (!kv) return;
  await pipe(kv, [["SET", emailKey(pubkey), email, "EX", PILOT_EMAIL_RETENTION_SECONDS]]).catch(() => {});
}

/**
 * Erase a wallet's stored contact address. The retention TTL is the backstop for an application
 * nobody answers; this is the deliberate erase, for when there is no longer anything to tell them.
 */
export async function forgetPilotEmail(pubkey: string): Promise<void> {
  const kv = kvConfigFromEnv();
  if (!kv) return;
  await pipe(kv, [["DEL", emailKey(pubkey)]]).catch(() => {});
}

/** The applicant's stored email, if any — used to send the "you're in" mail on approval. */
export async function getPilotEmail(pubkey: string): Promise<string | null> {
  const kv = kvConfigFromEnv();
  if (!kv) return null;
  const [v] = await pipe(kv, [["GET", emailKey(pubkey)]]).catch(() => [null]);
  return typeof v === "string" && v ? v : null;
}

/**
 * Owner-only: remove a wallet from the pilot allowlist (its counter is left as an audit trail).
 * The contact address goes with it — there is no outcome left to mail, so keeping an email beside a
 * mainnet address would be keeping it for nothing. A wallet revoked and later re-approved is
 * approved silently; both callers already say so when there is no stored address.
 */
export async function revokePilot(pubkey: string): Promise<void> {
  const kv = kvConfigFromEnv();
  if (!kv) throw new Error("pilot store not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  // The email's latest-wallet marker goes too when it names this wallet: it is the last place the
  // address and this wallet are tied together. It is keyed by the email's hash, so read the stored
  // contact first, before it is erased below.
  const [email] = await pipe(kv, [["GET", emailKey(pubkey)]]);
  let seenDel: (string | number)[][] = [];
  if (typeof email === "string" && email !== "") {
    const seenKey = await seenEmailKey(email);
    const [seen] = await pipe(kv, [["GET", seenKey]]);
    if (seen === pubkey) seenDel = [["DEL", seenKey]];
  }
  // The status follows the allowlist: a revoked wallet reads as declined, never as "approved"
  // with no allowlist flag behind it (which told the web "you're approved" for a wallet the value
  // routes refuse). Declined is also a state a fresh request does not reopen by itself. The revoked
  // flag is what lets the client say "we took this account off real money" instead of "not approved".
  await pipe(kv, [
    ["DEL", apprKey(pubkey)],
    ["DEL", emailKey(pubkey)],
    ["SET", statusKey(pubkey), "rejected"],
    ["SET", revokedKey(pubkey), "1"],
    ...seenDel,
  ]);
}

/**
 * Every wallet that ever asked for (or was put on) this network's pilot, with its recorded state.
 *
 * Walks the status keys with SCAN. The set is tens of entries, so a full walk costs one or two
 * round trips, and it is the only way to answer "who is still waiting" that does not depend on
 * the owner's inbox: the request mails carry the same wallets, but a mail can be missed, and the
 * signed links in them expire after a week. Owner CLI only; no route exposes this.
 *
 * `hasEmail` says whether an approval mail can still be sent (the contact expires after
 * PILOT_EMAIL_RETENTION_SECONDS), so the owner knows whom to tell by hand.
 */
export interface PilotListRow {
  pubkey: string;
  state: PilotState;
  hasEmail: boolean;
  /** Taken off real money by `revokePilot` (state "rejected"). */
  revoked: boolean;
  /** Where it last asked from, when it asked with a signed request. */
  src: PilotSource | null;
}

export async function listPilot(filter: PilotState | "all" = "all"): Promise<PilotListRow[]> {
  const kv = kvConfigFromEnv();
  if (!kv) throw new Error("pilot store not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  const prefix = `pilot:${net()}:status:`;
  const keys: string[] = [];
  let cursor = "0";
  let rounds = 0;
  do {
    const [page] = (await pipe(kv, [["SCAN", cursor, "MATCH", `${prefix}*`, "COUNT", 500]])) as [
      [string | number, string[]],
    ];
    cursor = String(page[0]);
    keys.push(...page[1]);
    // A store answering with a cursor that never returns to 0 would loop forever; bound the walk.
    if (++rounds > 1000) throw new Error("pilot store SCAN did not terminate");
  } while (cursor !== "0");
  const pubkeys = [...new Set(keys.map((k) => k.slice(prefix.length)))];
  if (pubkeys.length === 0) return [];
  const per = 5;
  const rows = await pipe(
    kv,
    pubkeys.flatMap((pk) => [
      ["GET", statusKey(pk)],
      ["GET", emailKey(pk)],
      ["GET", apprKey(pk)],
      ["GET", revokedKey(pk)],
      ["GET", srcKey(pk)],
    ]),
  );
  const all = pubkeys.map((pk, i): PilotListRow => {
    const [st, email, appr, revoked, src] = rows.slice(i * per, i * per + per);
    const view = readState(st, appr, revoked);
    return {
      pubkey: pk,
      state: view.state,
      hasEmail: typeof email === "string" && email !== "",
      revoked: view.revoked,
      src: src === "web" || src === "ext" ? src : null,
    };
  });
  return all
    .filter((r) => filter === "all" || r.state === filter)
    .sort((a, b) => a.pubkey.localeCompare(b.pubkey));
}

/**
 * Read a wallet's pilot status, for the client status endpoint, owner CLI and audits. `revoked`
 * separates "we took this account off real money" from "not approved for now" (both state
 * "rejected"). Throws on a store error: the route answers that 503, never "not approved".
 */
export async function pilotStatus(
  pubkey: string,
): Promise<{ state: PilotState; approved: boolean; used: number; limit: number; revoked: boolean }> {
  const kv = kvConfigFromEnv();
  if (!kv) throw new Error("pilot store not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  const [appr, tx, st, revoked] = await pipe(kv, [
    ["GET", apprKey(pubkey)],
    ["GET", txKey(pubkey)],
    ["GET", statusKey(pubkey)],
    ["GET", revokedKey(pubkey)],
  ]);
  const view = readState(st, appr, revoked);
  return { state: view.state, approved: view.approved, used: Number(tx ?? 0), limit: maxTx(), revoked: view.revoked };
}
