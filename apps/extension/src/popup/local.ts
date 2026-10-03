/**
 * The popup's own per-browser memory: which "link ready" screen the person already moved past. It is
 * a convenience only (nothing about money), it may be unavailable, and "Forget this account" clears
 * it with everything else.
 */
const DISMISSED_KEY = "lumenia.ready.dismissed";

export const readDismissed = (): string => {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) ?? "";
  } catch {
    return "";
  }
};

export const writeDismissed = (linkHex: string): void => {
  try {
    window.localStorage.setItem(DISMISSED_KEY, linkHex);
  } catch {
    /* storage blocked: the link simply shows again on the next open */
  }
};

/** Everything the popup itself keeps, removed ("Forget this account"). */
export const forgetPopupState = (): void => {
  try {
    window.localStorage.removeItem(DISMISSED_KEY);
  } catch {
    /* nothing kept */
  }
};
