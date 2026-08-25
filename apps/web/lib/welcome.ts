"use client";

/**
 * Has this device been through the welcome once?
 *
 * A per-device flag, deliberately not account state: onboarding is a thing that happens to a
 * person on a phone, and asking the server would mean a network round trip on /home to decide
 * whether to show a nudge. It fails in the harmless direction — if storage is blocked, the nudge
 * shows again, which costs a tap.
 */
const SEEN_KEY = "lumenia.welcome.seen";

export function markWelcomeSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* storage blocked — the nudge simply shows again */
  }
}

export function welcomeSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}
