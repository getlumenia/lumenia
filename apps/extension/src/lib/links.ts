/**
 * The life of one link record, as pure functions of (record, answer, now).
 *
 * Every transition here is a decision about money that a person will read as a fact, so each one
 * is written to be unable to say more than the ledger said:
 *
 *   - "it went through" only after the sponsor's 200 or the escrow holding the drop;
 *   - "it did not go through" only after the signed deposit can no longer land AND the escrow is
 *     empty, because before that moment an empty escrow is merely "not yet";
 *   - an escrow that could not be read changes nothing but `lastError`. It is never "claimed",
 *     never "waiting", never "failed";
 *   - "failed" is checked once more an hour later, and a deposit found in the escrow then is
 *     confirmed after all, so a wrong "nothing moved" cannot leave money with no way back;
 *   - "claimed" and "taken back" look the same in the escrow, so a link whose take-back outcome
 *     was never known reads "closed" (one of the two), never a guess.
 *
 * Nothing here retries a deposit. An uncertain record is re-READ until it settles; a second POST
 * would mint a second link under a fresh key with the money escrowed twice.
 */
import type { NetworkConfig, PreparedDeposit } from "../core";
import type { LinkRecord, NetId, Pill } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** storage.local key of one record. A link id is a 32-byte public key and unique on its own. */
export const linkKey = (net: NetId, linkHex: string): string => `links:${net}:${linkHex.toLowerCase()}`;
export const isLinkKey = (k: string): boolean => /^links:(testnet|public):[0-9a-f]{64}$/.test(k);

/**
 * The record that is written in the deposit's `onPrepared` hook: signed, not yet posted.
 *
 * `retrySafeAfter` is Infinity for a transaction without an upper time bound, and JSON turns
 * Infinity into null. createV2Link always sets one (120 s), but the record must not quietly turn
 * "never provably failed" into "failed at time zero", so a missing bound is stored as never.
 */
export function fromPrepared(
  p: PreparedDeposit,
  ctx: { net: NetId; sender: string; from: string; locked: boolean; now: number; contract?: string },
): LinkRecord {
  return {
    v: 1,
    net: ctx.net,
    ...(ctx.contract ? { contract: ctx.contract } : {}),
    linkHex: p.linkHex.toLowerCase(),
    sender: ctx.sender,
    amount: p.amount,
    from: ctx.from,
    locked: ctx.locked,
    createdAt: ctx.now,
    expiry: p.expiry,
    retrySafeAfter: Number.isFinite(p.retrySafeAfter) ? p.retrySafeAfter : Number.MAX_SAFE_INTEGER,
    innerHash: p.innerHash,
    phase: "submitted",
    nextCheckAt: ctx.now + MIN,
  };
}

/** The sponsor answered 200, or the escrow holds the drop. */
export function confirm(r: LinkRecord, hash: string | undefined, now: number): LinkRecord {
  const { lastError: _e, failReason: _f, emptyReads: _n, recheckAt: _c, ...rest } = r;
  return { ...rest, phase: "confirmed", status: "pending", ...(hash || r.hash ? { hash: hash || r.hash } : {}), lastCheckedAt: now, nextCheckAt: now + MIN };
}

/** Posted, outcome unknown. Re-read until it settles; never re-sent. */
export function markUncertain(r: LinkRecord, now: number, why?: string): LinkRecord {
  return { ...r, phase: "uncertain", nextCheckAt: now + MIN, ...(why ? { lastError: why } : {}) };
}

/**
 * Provably nothing moved: refused before submission, or past the deadline with an empty escrow.
 * One more read is still owed an hour past the deadline (onRecheck): if the proof was wrong, the
 * deposit is in the escrow then, and the link must come back as a link, not stay a failure.
 */
export function markFailed(r: LinkRecord, reason: string, now: number): LinkRecord {
  const { nextCheckAt: _n, emptyReads: _e, ...rest } = r;
  return { ...rest, phase: "failed", failReason: reason, lastCheckedAt: now, recheckAt: Math.max(now, r.retrySafeAfter) + HOUR };
}

/** Empty reads past the deadline (plus margin) it takes to call a deposit failed: one could be a lagging node. */
export const EMPTY_READS_TO_FAIL = 2;

/**
 * How long past the deadline an empty escrow must stay empty before it counts as proof. The deadline
 * is the transaction's upper time bound, judged by the LEDGER's clock; this device's clock is what
 * reads it here, and a clock a few minutes fast would otherwise say "nothing moved, send it again"
 * while the deposit can still land. Five minutes of margin costs a rare failure five minutes.
 */
export const CLOCK_MARGIN_MS = 5 * MIN;

/** The escrow's answer to "did this deposit land?", for a submitted or uncertain record. */
export function onLanded(r: LinkRecord, landed: boolean | "unknown", now: number): LinkRecord {
  if (r.phase !== "submitted" && r.phase !== "uncertain") return r;
  if (landed === true) return confirm(r, undefined, now);
  const pastDeadline = now >= r.retrySafeAfter + CLOCK_MARGIN_MS;
  const emptyReads = landed === false && pastDeadline ? (r.emptyReads ?? 0) + 1 : r.emptyReads;
  if (landed === false && pastDeadline && (emptyReads ?? 0) >= EMPTY_READS_TO_FAIL) {
    return markFailed(r, "It did not go through. Nothing moved, so you can send it again.", now);
  }
  // "not yet" before the deadline, a first empty read after it, or a read that did not finish:
  // still uncertain, ask again in a minute.
  const { lastError: _stale, emptyReads: _n, ...rest } = r;
  return {
    ...rest,
    phase: "uncertain",
    lastCheckedAt: now,
    nextCheckAt: now + MIN,
    ...(emptyReads ? { emptyReads } : {}),
    ...(landed === "unknown" ? { lastError: "could not read the escrow" } : {}),
  };
}

/**
 * The one read a FAILED link is still owed (markFailed). Found in the escrow: it went through after
 * all, and is confirmed. Empty: the failure stands for good. Unreadable: try again in ten minutes,
 * for at most a day past the deadline.
 */
export function onRecheck(r: LinkRecord, landed: boolean | "unknown", now: number): LinkRecord {
  if (r.phase !== "failed" || r.recheckAt === undefined) return r;
  if (landed === true) return confirm(r, undefined, now);
  const { recheckAt: _c, ...rest } = r;
  if (landed === "unknown" && now < r.retrySafeAfter + DAY) return { ...r, lastCheckedAt: now, recheckAt: now + 10 * MIN };
  return { ...rest, lastCheckedAt: now };
}

/**
 * The escrow's answer for a CONFIRMED record, from loadV2DropStatus.
 *
 * "settled" means no escrow holds an unclaimed drop for this link any more. The contract marks a
 * claim and a take-back the same way (lumen-drop: both set `claimed`), so the record decides:
 * Reclaimed only with this extension's confirmed take-back (onReclaimed), Claimed only when no
 * take-back of ours can be involved, and Closed when one was asked for and never answered.
 */
export function onDropRead(r: LinkRecord, read: "pending" | "settled" | "unknown", now: number): LinkRecord {
  if (r.phase !== "confirmed" || isFinal(r)) return r;
  if (read === "unknown") return { ...r, lastCheckedAt: now, lastError: "could not read the escrow", nextCheckAt: now + backoff(r, now) };
  if (read === "pending") {
    const { lastError: _e, ...rest } = r;
    return { ...rest, status: "pending", lastCheckedAt: now, nextCheckAt: now + backoff(r, now) };
  }
  const { lastError: _e, nextCheckAt: _n, ...rest } = r;
  const status = r.reclaimHash ? "reclaimed" : r.reclaimAttemptAt !== undefined || r.reclaimOpenAt !== undefined ? "closed" : "claimed";
  return { ...rest, status, lastCheckedAt: now };
}

/** A take-back is being asked for. Cleared when its answer is known (onReclaimed, onReclaimFailed). */
export function onReclaimAttempt(r: LinkRecord, now: number): LinkRecord {
  return { ...r, reclaimAttemptAt: now };
}

/** The sponsor relayed the take-back and the ledger took it. */
export function onReclaimed(r: LinkRecord, hash: string, now: number): LinkRecord {
  const { nextCheckAt: _n, lastError: _e, ...rest } = r;
  return { ...rest, status: "reclaimed", reclaimHash: hash, lastCheckedAt: now };
}

/**
 * A take-back that failed. When the failure is definite (refused before anything was submitted),
 * this attempt is forgotten, so a recipient who claims afterwards is shown as a claim. When it is
 * not definite, the take-back may have landed: `reclaimOpenAt` is set and never cleared, and a
 * settled link then reads Closed. A later definite refusal does not erase it (the earlier attempt
 * may be exactly why the later one was refused).
 */
export function onReclaimFailed(r: LinkRecord, definite: boolean, now: number): LinkRecord {
  const { reclaimAttemptAt: _a, ...rest } = r;
  if (definite) return rest;
  return { ...rest, reclaimOpenAt: r.reclaimOpenAt ?? now, nextCheckAt: now + MIN };
}

/** Nothing more will ever change about this record. */
export function isFinal(r: LinkRecord): boolean {
  if (r.phase === "failed") return r.recheckAt === undefined;
  return r.phase === "confirmed" && (r.status === "claimed" || r.status === "reclaimed" || r.status === "closed");
}

/** How long to wait before reading this record again: often while it is young, rarely after a day. */
export function backoff(r: LinkRecord, now: number): number {
  if (r.phase === "submitted" || r.phase === "uncertain") return MIN;
  const age = now - r.createdAt;
  if (age < 10 * MIN) return MIN;
  if (age < DAY) return 10 * MIN;
  return HOUR;
}

/** Is a read owed now? */
export function isDue(r: LinkRecord, now: number): boolean {
  if (isFinal(r)) return false;
  if (r.phase === "failed") return now >= (r.recheckAt ?? Infinity);
  return r.nextCheckAt === undefined || now >= r.nextCheckAt;
}

/** The sender may take it back: confirmed, unclaimed, and past its expiry. */
export function isReclaimable(r: LinkRecord, now: number): boolean {
  return r.phase === "confirmed" && r.status === "pending" && now >= r.expiry * 1000;
}

/** The pill shown for a record. Derived, never stored, so the expiry is always read against now. */
export function pillOf(r: LinkRecord, now: number): Pill {
  switch (r.phase) {
    case "failed":
      return "failed";
    case "uncertain":
      return "uncertain";
    case "submitted":
      return "checking";
    case "confirmed":
      if (r.status === "claimed") return "claimed";
      if (r.status === "reclaimed") return "reclaimed";
      if (r.status === "closed") return "closed";
      return now >= r.expiry * 1000 ? "reclaimable" : "waiting";
  }
}

export const PILL_LABEL: Record<Pill, string> = {
  waiting: "Waiting",
  reclaimable: "Reclaimable",
  claimed: "Claimed",
  reclaimed: "Reclaimed",
  closed: "Closed",
  uncertain: "Uncertain",
  checking: "Checking",
  failed: "Didn't go through",
};

/** How long a posted, unconfirmed send keeps asking for a second thought before another one. */
export const UNCONFIRMED_WINDOW_MS = 6 * HOUR;

/**
 * A send on this network that was posted and is not settled yet. While there is one, another send
 * needs an explicit "send a new one anyway": if the first went through, the second escrows the
 * money twice. The worker enforces it (send.ts); the popup asks the question.
 */
export function unconfirmedSend(records: LinkRecord[], net: NetId, now: number): LinkRecord | null {
  return records.find((r) => r.net === net && (r.phase === "uncertain" || r.phase === "submitted") && now - r.createdAt < UNCONFIRMED_WINDOW_MS) ?? null;
}

/**
 * Links whose money may still be in the escrow, where only this extension can take it back: being
 * made, unconfirmed, waiting or reclaimable, or failed with its last check still owed. "Forget this
 * account" deletes the only list of them, so it asks first (router.ts).
 */
export function openLinks(records: LinkRecord[]): LinkRecord[] {
  return records.filter(
    (r) =>
      r.phase === "submitted" ||
      r.phase === "uncertain" ||
      (r.phase === "confirmed" && r.status === "pending") ||
      (r.phase === "failed" && r.recheckAt !== undefined),
  );
}

/**
 * The network settings a record's reads and take-back use: the escrow it was made on first. A link
 * made before an escrow is replaced must still be read where its money is, or an empty answer from
 * the new escrow would read as "claimed".
 */
export function netForRecord(net: NetworkConfig, r: LinkRecord): NetworkConfig {
  if (!r.contract || r.contract === net.contract) return net;
  return { ...net, contract: r.contract, legacyContracts: [net.contract, ...net.legacyContracts.filter((c) => c !== r.contract)] };
}

/** Newest first. */
export function sortRecords(rs: LinkRecord[]): LinkRecord[] {
  return [...rs].sort((a, b) => b.createdAt - a.createdAt);
}

/** A record read back from storage, or null when it is not one of ours. */
export function asRecord(v: unknown): LinkRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Partial<LinkRecord>;
  if (r.v !== 1 || typeof r.linkHex !== "string" || !/^[0-9a-f]{64}$/.test(r.linkHex)) return null;
  if (r.net !== "testnet" && r.net !== "public") return null;
  if (typeof r.sender !== "string" || typeof r.amount !== "string" || typeof r.expiry !== "number") return null;
  if (r.phase !== "submitted" && r.phase !== "confirmed" && r.phase !== "uncertain" && r.phase !== "failed") return null;
  // A record without a real deadline would let an empty escrow read as "nothing moved" at once.
  if (typeof r.retrySafeAfter !== "number" || !Number.isFinite(r.retrySafeAfter)) return null;
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return null;
  return r as LinkRecord;
}
