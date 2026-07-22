/**
 * Notifications — NOT a server feed. Every item is DERIVED from the public ledger (the same Horizon
 * reads /home + /activity already use), plus a purely local "seen" set in localStorage. No backend,
 * no push subscription, no per-user database — which is exactly the product's privacy posture (money
 * lives on the public record; we hold nothing).
 *
 * Three kinds of item, all real:
 *   - "waiting"     — an open Claimable Balance you can collect right now (a paid request, or a
 *                     transfer straight to your account). Source: loadIncomingClaims.
 *   - "reclaimable" — money YOU sent that was never claimed and whose 7-day window is up, so it can
 *                     come back to you (gasless, via /feebump — proven). Source: loadReclaimableSends.
 *   - "received"    — money that already landed in your account. Source: loadActivity (incoming effects).
 *
 * Unread = an item whose id you have not marked seen on this device. There is deliberately no
 * cross-device sync: a notification is a hint derived from the ledger, not a record we keep for you.
 */
import { loadActivity, loadIncomingClaims, loadReclaimableSends, loadBalance } from "./horizon";
import { loadReclaimableV2 } from "./lumendrop";

export interface Notice {
  id: string;
  kind: "waiting" | "reclaimable" | "received";
  usd: string;
  at: string; // ISO ("" if the ledger didn't stamp one)
  /** for "waiting"/"reclaimable": the id to act on — a Claimable Balance id, or (via:"v2") a drop linkHex. */
  balanceId?: string;
  /** for "reclaimable": how to take it back — a classic CB (/feebump) or a v2 drop (/v2-reclaim). */
  via?: "classic" | "v2";
}

const SEEN_KEY = "lumenia.notif.seen";

function seenSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** Mark every current notice id as seen (called when the user opens /notifications). */
export function markAllSeen(ids: string[]): void {
  try {
    const merged = new Set([...seenSet(), ...ids]);
    // keep the set bounded — only the most recent ids matter for "unread"
    localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(merged).slice(-300)));
  } catch {
    /* localStorage blocked — unread just won't persist, which is a safe default */
  }
}

/** Build the full notice list from the ledger, newest first. */
export async function loadNotices(address: string): Promise<Notice[]> {
  const bal = await loadBalance(address);
  const [waiting, reclaimable, reclaimableV2, activity] = await Promise.all([
    bal?.issuer ? loadIncomingClaims(address, bal.issuer) : Promise.resolve([]),
    bal?.issuer ? loadReclaimableSends(address, bal.issuer) : Promise.resolve([]),
    loadReclaimableV2(address).catch(() => []), // v2 drops are local + on-chain; never block the feed
    loadActivity(address, 50),
  ]);
  const notices: Notice[] = [
    ...waiting.map((w) => ({
      id: `w:${w.balanceId}`,
      kind: "waiting" as const,
      usd: w.usd,
      at: w.at,
      balanceId: w.balanceId,
    })),
    ...reclaimable.map((r) => ({
      id: `rc:${r.balanceId}`,
      kind: "reclaimable" as const,
      usd: r.usd,
      at: r.at,
      balanceId: r.balanceId,
      via: "classic" as const,
    })),
    ...reclaimableV2.map((r) => ({
      id: `rc2:${r.linkHex}`,
      kind: "reclaimable" as const,
      usd: r.usd,
      at: new Date(r.expiry * 1000).toISOString(),
      balanceId: r.linkHex,
      via: "v2" as const,
    })),
    ...activity
      .filter((a) => a.direction === "in")
      .map((a) => ({ id: `r:${a.id}`, kind: "received" as const, usd: a.usd, at: a.at })),
  ];
  return notices.sort((a, b) => b.at.localeCompare(a.at));
}

/** How many of these notices are unread on this device. */
export function unreadCount(notices: Notice[]): number {
  const seen = seenSet();
  return notices.filter((n) => !seen.has(n.id)).length;
}

/** Just the unread count — a light call for the nav bell (one balance read + two ledger reads). */
export async function loadUnreadCount(address: string): Promise<number> {
  try {
    return unreadCount(await loadNotices(address));
  } catch {
    return 0;
  }
}
