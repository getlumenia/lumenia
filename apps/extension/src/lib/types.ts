/**
 * The shapes the popup, the background worker and the tests agree on. Nothing here does anything;
 * it is the contract (docs/EXTENSION_BUILD_PLAN.md sections 4 and 5, local).
 */
import type { AutolockMin } from "../config";

export type NetId = "testnet" | "public";

/**
 * Where a link is in its life. `submitted` is written BEFORE the deposit is posted, so a worker
 * that dies mid-request leaves a record the settle loop can finish; `uncertain` is never retried
 * by anything automatically, because a retry mints a second link under a fresh key.
 */
export type LinkPhase = "submitted" | "confirmed" | "uncertain" | "failed";

/**
 * What the escrow says about a CONFIRMED link. A single link past its expiry is still `pending`
 * on chain (the recipient can claim until the sender takes it back); the popup shows it as
 * Reclaimable from the expiry on.
 *
 * The escrow marks a claim and a take-back the same way, so `reclaimed` needs this extension's own
 * confirmed take-back (a hash), and `claimed` needs no take-back of ours to be possibly involved.
 * When one was asked for and its outcome never became known, a settled link is `closed`: claimed or
 * taken back, and we say we cannot tell which rather than pick one.
 */
export type LinkStatus = "pending" | "claimed" | "reclaimed" | "closed";

export interface LinkRecord {
  v: 1;
  net: NetId;
  /** the 32-byte link public key, hex: the drop's id in the escrow */
  linkHex: string;
  /** the account that paid for it (G...) */
  sender: string;
  /** dollars as sent, two decimals ("1.00") */
  amount: string;
  /** the display name on the claim screen, "" for none */
  from: string;
  /** the recipient must know a password before the money moves */
  locked: boolean;
  /** unix ms */
  createdAt: number;
  /** unix seconds: from here on the sender may take an unclaimed link back */
  expiry: number;
  /** unix ms: after this the signed deposit can no longer land, so an empty escrow means nothing moved */
  retrySafeAfter: number;
  /** hex hash of the signed inner transaction (Horizon also finds a fee-bump by its inner hash) */
  innerHash: string;
  /** the sponsor's transaction hash, when it reported one */
  hash?: string;
  phase: LinkPhase;
  status?: LinkStatus;
  /** why a failed link failed, in words a person can act on */
  failReason?: string;
  /** unix ms of the last escrow read, and of the next one the settle loop owes */
  lastCheckedAt?: number;
  nextCheckAt?: number;
  /** the last read that could not finish; it never changes the status */
  lastError?: string;
  /** a take-back THIS extension is asking for right now (cleared when its answer is known) */
  reclaimAttemptAt?: number;
  /** a take-back whose outcome never became known; never cleared, so a settled link reads Closed */
  reclaimOpenAt?: number;
  reclaimHash?: string;
  /** reads past the deadline (plus margin) that found the escrow empty; two are needed to fail */
  emptyReads?: number;
  /** a failed link is read once more at this time, in case it landed after all (then it is confirmed) */
  recheckAt?: number;
  /** the escrow contract the deposit was made on; reads and take-backs go to this one */
  contract?: string;
  /** unix ms the link was pasted into a page for the user */
  insertedAt?: number;
}

/** The pill a record shows, derived (never stored). */
export type Pill = "waiting" | "reclaimable" | "claimed" | "reclaimed" | "closed" | "uncertain" | "checking" | "failed";

export interface Settings {
  net: NetId;
  autolockMin: AutolockMin;
  /** the default "from" name; "" means "Someone" on the claim screen */
  from: string;
  /** the one-time real-money warning was read and acknowledged */
  mainnetAck: boolean;
  /** the first-run data disclosure was agreed to (nothing leaves the device before it) */
  consentAt: number | null;
}

export interface PilotInfo {
  /** the mainnet sponsor runs the pilot gate at all */
  pilot: boolean;
  approved: boolean;
  state: string;
  used: number;
  limit: number;
  /** unix ms the answer was read */
  at: number;
}

export interface WorkerState {
  account: { pubkey: string } | null;
  unlocked: boolean;
  /** unix ms the session locks itself, while unlocked */
  lockAt: number | null;
  settings: Settings;
  restore: { step: "code" | "password"; email: string; codeSentAt: number } | null;
  /** the cached pilot answer for this account, possibly stale; null = never asked */
  pilot: PilotInfo | null;
  sending: { startedAt: number; linkHex?: string } | null;
  pendingInsert: { host: string; at: number } | null;
  backup: BackupView;
  /** Firefox: the six API hosts are granted (Chrome grants them at install) */
  hostAccess: boolean;
  version: string;
}

export type ErrorCode =
  | "locked"
  | "no-account"
  | "needs-consent"
  | "needs-password"
  /** real money, and this account lives only in this browser: back it up first */
  | "needs-backup"
  | "not-approved"
  | "pilot-unknown"
  | "slots-used"
  | "over-cap"
  | "rate-limited"
  | "halted"
  /** the network declined to queue it: nothing moved, try again shortly */
  | "network-busy"
  /** a published day limit is spent (the fee budget, ...): nothing moved, try again tomorrow */
  | "day-limit"
  | "offline"
  | "uncertain"
  | "bad-amount"
  | "bad-email"
  | "bad-code"
  | "no-backup"
  | "no-password-copy"
  | "bad-password"
  | "weak-link-password"
  | "weak-password"
  | "backup-refused"
  | "not-backed-up"
  | "unsupported-backup"
  | "account-not-found"
  | "not-enough-money"
  | "busy"
  | "open-send"
  | "open-links"
  | "simulation-failed"
  | "sponsor-refused"
  | "not-found"
  | "not-reclaimable"
  | "insert-failed"
  | "host-access"
  | "internal";

export type Result<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string };

/** What a send hands back to the popup the moment it is settled one way or the other. */
export interface SendOutcome {
  linkHex: string;
  record: LinkRecord;
  /** the full link, only when confirmed (the popup copies it on a click) */
  link?: string;
  /** the link was pasted into the page the user right-clicked */
  inserted?: boolean;
}

export interface BalanceInfo {
  /** USDC held, pinned to Circle's issuer on that network; null when it could not be read */
  usd: string | null;
  /** the account does not exist on that network yet */
  missing: boolean;
  /** the account can hold these dollars (it has the pinned issuer's line); undefined when unknown */
  line?: boolean;
}

/** Where this account's backup stands. */
export interface BackupView {
  /** the account was made in this extension and is not backed up yet: it exists only here */
  needed: boolean;
  /** a backup in progress: the code was mailed to `email` at `codeSentAt` */
  step: "code" | null;
  email: string;
  codeSentAt: number | null;
}
