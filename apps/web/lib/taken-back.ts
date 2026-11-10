/**
 * The sender's own record of a take-back, and what a settled send may say because of it.
 *
 * The escrow keeps ONE flag for a one-to-one link, `claimed`, and sets it whether the recipient
 * claimed the money or the sender took it back; a closed pool reads with every slot claimed whether
 * the shares went to people or the leftover went home; and a classic payment to an address simply
 * disappears from Horizon when it is collected or reclaimed. So the ledger cannot tell /sent which
 * of the two happened, and both readers answer "settled" for both. The device that did the
 * take-back can tell, because it did it: it writes the amount onto its own `lumenia.sent` record,
 * and /sent reads that record before it chooses its words. Everywhere else the words hedge.
 *
 * Lifted out of /notifications, which used to mark pools only: a one-to-one link the sender took
 * back read "Received" on /sent, a sentence about the recipient that was simply false.
 */
import { formatUsd } from "./money";
import { netKey } from "./scoped-store";

/** The slice of a `lumenia.sent` record this module reads and writes. */
export interface TakeBackRecord {
  balanceId?: string;
  tookBackUsd?: string;
}

/**
 * Mark every record for `linkHex` as taken back for `usd`. Returns whether any record matched, so
 * the caller can skip a write that would change nothing. Pure; the storage wrapper is below.
 */
export function markTakenBackIn(all: Record<string, TakeBackRecord>, linkHex: string, usd: string): boolean {
  let touched = false;
  for (const rec of Object.values(all)) {
    if (rec && rec.balanceId === linkHex) {
      rec.tookBackUsd = usd;
      touched = true;
    }
  }
  return touched;
}

/**
 * Remember, on this phone, that the money came back here. `linkHex` is whatever the sent record
 * keeps as its `balanceId`: a v2 drop's link key, or a classic Claimable Balance id.
 */
export function markTakenBack(linkHex: string, usd: string): void {
  try {
    const key = netKey("lumenia.sent");
    const all = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, TakeBackRecord>;
    if (markTakenBackIn(all, linkHex, usd)) localStorage.setItem(key, JSON.stringify(all));
  } catch {
    /* storage blocked: the take-back still happened on chain, and /sent falls back to the hedged
       words a settled send licenses on its own */
  }
}

/** What /sent shows for a one-to-one send whose money is no longer held: a pill and a sentence. */
export interface SettledWords {
  pill: { status: "received" | "returned"; label: string };
  body: string;
}

/**
 * The words for a settled one-to-one send. "Received" is said by nobody: the ledger read only says
 * the held money is GONE, and that is "claimed by them" or "taken back by you", which it cannot
 * tell apart. Only this device's own take-back mark licenses a definite sentence, and that sentence
 * is about the sender, not the recipient.
 */
export function settledWords(rec: { toName?: string; tookBackUsd?: string }): SettledWords {
  if (rec.tookBackUsd) {
    return {
      pill: { status: "returned", label: "Taken back" },
      body: rec.toName
        ? `You took back ${formatUsd(rec.tookBackUsd)}. ${rec.toName} can no longer collect it.`
        : `You took back ${formatUsd(rec.tookBackUsd)}. The link is closed.`,
    };
  }
  if (rec.toName) {
    return {
      pill: { status: "received", label: "Settled" },
      body: `This is settled. ${rec.toName} collected it, or you took it back after 7 days. Nothing more to do.`,
    };
  }
  return {
    pill: { status: "received", label: "Settled" },
    body: "This is settled. Whoever had the link claimed it, or you took it back. Nothing more to do.",
  };
}
