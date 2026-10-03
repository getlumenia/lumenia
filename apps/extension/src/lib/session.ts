/**
 * The unlocked session, as pure functions of (state, event, now).
 *
 * The seed itself lives in storage.session next to this view; these rules decide whether it may be
 * used. A late alarm cannot keep a session open: `canSign` compares against `lockAt` on every
 * signature, so the auto-lock holds even if the browser delivered the alarm minutes late.
 */
export interface SessionView {
  /** the account the unlocked seed belongs to, or null when locked */
  pubkey: string | null;
  /** unix ms after which the session is locked whatever else happened */
  lockAt: number | null;
}

export const LOCKED: SessionView = { pubkey: null, lockAt: null };

export type SessionEvent =
  | { type: "unlock"; pubkey: string; now: number; autolockMin: number }
  /** activity (a popup open, a send) pushes the lock back to a full idle period from now */
  | { type: "touch"; now: number; autolockMin: number }
  | { type: "lock" }
  /** the clock moved: an expired session becomes a locked one */
  | { type: "tick"; now: number };

export function lockAtFor(now: number, autolockMin: number): number {
  return now + autolockMin * 60_000;
}

export function isUnlocked(s: SessionView, now: number): boolean {
  return typeof s.pubkey === "string" && s.pubkey.length > 0 && typeof s.lockAt === "number" && now < s.lockAt;
}

export function reduce(s: SessionView, e: SessionEvent): SessionView {
  switch (e.type) {
    case "unlock":
      return { pubkey: e.pubkey, lockAt: lockAtFor(e.now, e.autolockMin) };
    case "touch":
      return isUnlocked(s, e.now) ? { ...s, lockAt: lockAtFor(e.now, e.autolockMin) } : LOCKED;
    case "lock":
      return LOCKED;
    case "tick":
      return isUnlocked(s, e.now) ? s : LOCKED;
  }
}

/** May the worker sign for `pubkey` right now? Only an unexpired session for that same account. */
export function canSign(s: SessionView, now: number, pubkey: string): boolean {
  return isUnlocked(s, now) && s.pubkey === pubkey;
}
