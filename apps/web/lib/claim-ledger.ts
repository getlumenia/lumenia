/**
 * What the v2 claim screen may say about a link's amount, decided from what the escrow answered.
 *
 * A private link carries no amount (SOW 2, D2), so the figure on the claim screen is whatever the
 * escrow says, read after the page loads. These are the rules for turning that read into a screen,
 * kept pure so lib/claim-ledger.selftest.ts can hold them without a browser.
 * app/v2/c/[linkHex]/V2ClaimButton.tsx is the only caller.
 */

/**
 * What the escrow has said about the amount so far.
 *
 *   reading - asked, no answer yet (what the server renders, so hydration agrees)
 *   amount  - the escrow's figure: the whole drop, or ONE share of a pot
 *   unread  - we could not ask (an unreachable RPC is not an empty link)
 *   none    - every escrow answered and none holds it (right after a deposit, an RPC can lag)
 *   spent   - the link has settled; the settled screen speaks instead of the figure
 *   off     - there is no network to ask (this deployment cannot serve the link's network)
 */
export type LedgerRead =
  | { phase: "reading" }
  | { phase: "amount"; amount: string }
  | { phase: "unread" }
  | { phase: "none" }
  | { phase: "spent" }
  | { phase: "off" };

/** One look at a one-to-one drop: an error, an empty answer, or the record. */
export type DropLook =
  | { kind: "error" }
  | { kind: "none" }
  | { kind: "drop"; amount: string; claimed: boolean };

export interface DropDecision {
  ledger: LedgerRead;
  /** Show the settled "already used" screen now, naming this figure. */
  settle: { amount: string } | null;
  /** The escrow gave an answer worth keeping; stop asking. */
  answered: boolean;
}

/**
 * The screen one look decides.
 *
 * A record marked claimed settles the screen up front only when nobody on this page has tapped yet
 * (`touched`): once a tap is accepted the claim itself answers, and a read landing in the middle of
 * it must not swap the screen under the person. The contract sets `claimed` only in `claim` and
 * `reclaim`, and `deposit` refuses an existing key, so the flag is never a forger's.
 */
export function decideDrop(look: DropLook, touched: boolean): DropDecision {
  if (look.kind === "error") return { ledger: { phase: "unread" }, settle: null, answered: false };
  if (look.kind === "none") return { ledger: { phase: "none" }, settle: null, answered: false };
  if (look.claimed && !touched) return { ledger: { phase: "spent" }, settle: { amount: look.amount }, answered: true };
  return { ledger: { phase: "amount", amount: look.amount }, settle: null, answered: true };
}

/** A reading that is not an answer never replaces one that is. */
export function keepAnswer(prev: LedgerRead, next: LedgerRead): LedgerRead {
  return prev.phase === "amount" || prev.phase === "spent" ? prev : next;
}

/** An answer replaces anything except a settled screen: once the claim has settled, no late read brings the figure back. */
export function withAnswer(prev: LedgerRead, next: LedgerRead): LedgerRead {
  return prev.phase === "spent" ? prev : next;
}

/** Patience ran out with no answer at all: say so instead of reading forever. A later answer still wins. */
export function afterPatience(prev: LedgerRead): LedgerRead {
  return prev.phase === "reading" ? { phase: "unread" } : prev;
}

/**
 * The claim has settled (taken, expired, empty, or already this device's): the figure goes, so the
 * header never shows "$X, verified on the ledger" above "This link has already been used".
 */
export function afterSettled(): LedgerRead {
  return { phase: "spent" };
}
