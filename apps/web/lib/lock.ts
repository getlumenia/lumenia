/**
 * Two small, pure rules about locking (W11, W12). Pure so the self-tests hold them.
 */

/** How long the website stays unlocked without use, in minutes. localStorage "lumenia.autolock". */
export type AutoLockMinutes = 5 | 15 | 60;
export const AUTO_LOCK_CHOICES: readonly AutoLockMinutes[] = [5, 15, 60];
export const DEFAULT_AUTO_LOCK: AutoLockMinutes = 15;
const AUTO_LOCK_KEY = "lumenia.autolock";

export function readAutoLock(): AutoLockMinutes {
  try {
    const n = Number(localStorage.getItem(AUTO_LOCK_KEY));
    return AUTO_LOCK_CHOICES.find((c) => c === n) ?? DEFAULT_AUTO_LOCK;
  } catch {
    return DEFAULT_AUTO_LOCK;
  }
}

export function writeAutoLock(minutes: AutoLockMinutes): void {
  try {
    localStorage.setItem(AUTO_LOCK_KEY, String(minutes));
  } catch {
    /* storage blocked: the default applies */
  }
}

/**
 * Is it time to drop the unlocked key? After `minutes` without input, or after `minutes` with the
 * tab hidden: a hidden tab gets no input, and its timers may be throttled, so the moment it comes
 * back is also checked against when it was hidden. `hiddenSinceMs` is null while the tab is visible.
 */
export function idleLockDue(lastActiveMs: number, hiddenSinceMs: number | null, minutes: number, now: number): boolean {
  const limit = minutes * 60_000;
  if (now - lastActiveMs >= limit) return true;
  return hiddenSinceMs !== null && now - hiddenSinceMs >= limit;
}

/**
 * Locking an account that Face ID just brought back (W12). The box it came from may hold a
 * password copy, and the person may type the password that copy opens with:
 *
 *   lock-verified  the typed password opens the email backup to this same account. Lock with it
 *                  even below the strength floor: it is a password that already guards the backup,
 *                  not a newly chosen one, and refusing it would push them to a second password.
 *   lock-new-warn  it does not open the backup, and it is strong enough: lock, and say the email
 *                  backup still opens with the OLD password (then offer to back up again).
 *   lock-new       there is no password copy to compare with, and it is strong enough: lock.
 *   too-weak       a new password below the floor: refuse, as before.
 *
 * `opensBox` is null when the box has no password copy.
 */
export type LockPasswordPlan = "lock-verified" | "lock-new-warn" | "lock-new" | "too-weak";

export function lockPasswordPlan(opensBox: boolean | null, strong: boolean): LockPasswordPlan {
  if (opensBox === true) return "lock-verified";
  if (!strong) return "too-weak";
  return opensBox === false ? "lock-new-warn" : "lock-new";
}

/** What lock-new-warn says. */
export const OLD_BACKUP_PASSWORD_NOTE =
  "Your email backup still opens with your old password. Use that one, or choose a new one and back up again.";
