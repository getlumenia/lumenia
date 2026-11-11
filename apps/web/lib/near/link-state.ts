// What a stored link is in plain words, from the last thing the chain said about it. Shared by
// the sender's list, the pay-forward list and the link-ready card.

import type { DropView } from "./drops";
import { reclaimable } from "./drops";
import { expiresAtMs, formatRemaining, isExpired, nsToMs, toIso } from "./expiry";
import { upsertLink, type StoredLink } from "./store";

export type LinkState = "waiting" | "claimed" | "expired" | "returned";

/** When the link stops paying out: the chain's figure once read, the record's estimate before. */
export function linkExpiresAt(l: StoredLink): number {
  return l.expiresAtNs ? nsToMs(l.expiresAtNs) : expiresAtMs(Date.parse(l.createdAt), l.expiresInS);
}

/** null until the chain has confirmed the drop at all. */
export function linkStateOf(l: StoredLink, now: number): LinkState | null {
  if (!l.lastStatus) return null;
  if (l.lastStatus === "Claimed") return "claimed";
  if (l.lastStatus === "Reclaimed") return "returned";
  return isExpired(linkExpiresAt(l), now) ? "expired" : "waiting";
}

/** Rebuild the chain view a stored record last saw, for the reclaim rule. */
export function lastSeenDrop(l: StoredLink): DropView | null {
  if (!l.lastStatus || !l.expiresAtNs) return null;
  return {
    status: l.lastStatus,
    amount: l.amountUnits,
    funder: l.funder,
    created_at_ns: "0",
    expires_at_ns: l.expiresAtNs,
    claimed_to: l.claimedTo ?? null,
    memo: l.memo,
    status_changed_at_ns: l.statusChangedAtNs,
  };
}

/** Whether the funder may take the money back now, by what this device last read from the chain. */
export function canTakeBack(l: StoredLink, now: number): boolean {
  const seen = lastSeenDrop(l);
  return seen !== null && reclaimable(seen, now);
}

/** Write what the chain said about a drop onto its record. */
export function recordDrop(publicKey: string, d: DropView): void {
  upsertLink({
    publicKey,
    lastStatus: d.status,
    lastReadAt: toIso(Date.now()),
    claimedTo: d.claimed_to,
    expiresAtNs: String(d.expires_at_ns),
    statusChangedAtNs: d.status_changed_at_ns === undefined ? undefined : String(d.status_changed_at_ns),
    createError: undefined,
  });
}

/** The one line under a link: where it stands, in words a sender reads at a glance. */
export function linkStatusLine(l: StoredLink, now: number): string {
  const status = l.lastStatus;
  const expiresAt = linkExpiresAt(l);
  const expired = isExpired(expiresAt, now);
  if (!status) return l.createError ? `Not confirmed yet (${l.createError})` : "Not confirmed yet";
  if (status === "Open") return expired ? "Expired. You can take the money back." : `Waiting. Expires in ${formatRemaining(expiresAt - now)}.`;
  if (status === "Claiming") return canTakeBack(l, now) ? "A claim got stuck. You can take the money back." : "Being claimed right now.";
  if (status === "Claimed") return l.claimedTo ? `Claimed by ${l.claimedTo}.` : "Claimed.";
  return "Returned to you.";
}
