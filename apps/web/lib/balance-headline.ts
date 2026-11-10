/**
 * What the balance headline on /home may say, decided from the state of the Horizon read.
 *
 * The number at the top of /home is the one figure the whole product is about, and it used to be
 * rendered from `usd ?? "0"`: a read that had not finished yet and a read that failed both printed
 * $0.00 under "Your money", above "No activity yet". A person whose Horizon read failed was told
 * they had nothing, which is the one mock figure this product ever showed. The reader behind it
 * (lib/horizon.ts loadTotalUsd) has three outcomes in practice: it has not answered yet, it
 * answered with a dollar figure, or it threw. These are the three, and a figure is rendered only
 * when the ledger gave one; "0" is reserved for the case the ledger actually said so.
 *
 * Pure, so the self-test (lib/horizon.selftest.ts) can walk every combination without React.
 */
export type BalanceHeadline =
  /** No figure has been read on this visit and a read is on its way (or about to be). */
  | { kind: "loading" }
  /** No figure has been read on this visit, the last attempt failed, and none is in flight. */
  | { kind: "unreadable" }
  /** A figure the ledger gave. `stale` when a later re-read failed and this is the last one that landed. */
  | { kind: "amount"; usd: string; stale: boolean };

export function balanceHeadline(input: {
  /** The last total the ledger gave, or null when none has been read on this visit. */
  usd: string | null;
  /** Whether the most recent read attempt failed. */
  failed: boolean;
  /** Whether a read is in flight right now. */
  reading: boolean;
}): BalanceHeadline {
  if (input.usd !== null) {
    return { kind: "amount", usd: input.usd, stale: input.failed && !input.reading };
  }
  if (input.reading || !input.failed) return { kind: "loading" };
  return { kind: "unreadable" };
}
