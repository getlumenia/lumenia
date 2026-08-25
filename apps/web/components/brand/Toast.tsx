"use client";

/**
 * The app's one toast — a short confirmation that something happened.
 *
 * IT HAS TO SURVIVE A RELOAD. The thing most worth confirming here is switching between practice
 * and real money, and that switch deliberately reloads the page: every money module reads the
 * active network at call time, so a soft change would leave one screen on a different chain from
 * the next. A toast held in React state would be destroyed by exactly the event it exists to
 * announce. So the message is handed over in sessionStorage and picked up on the other side of the
 * reload — which is also why `toast()` can be called from a function that is about to navigate.
 *
 * Deliberately small: no queue, no stacking, no actions. One message at a time, announced to screen
 * readers via role="status", gone after a few seconds, dismissible by tap. Anything more belongs to
 * a component that has a reason to be more.
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const KEY = "lumenia.toast";
const EVENT = "lumenia:toast";
const VISIBLE_MS = 4200;

/**
 * Show a message on THIS page, now.
 *
 * Deliberately does not touch storage. The first version of this did both — dispatch and store —
 * and the two fought each other: a caller that toasts and then reloads would light the toast on the
 * page that is about to be destroyed, and that render's own "clear it once it is on screen" step
 * wiped the copy meant for the page arriving next. The switch between practice and real money
 * therefore reloaded in silence, which is the exact thing the toast was added to fix.
 *
 * So the two situations are two functions, and the call site says which one it is in.
 */
export function toast(message: string): void {
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: message }));
  } catch {
    /* pre-hydration or a non-browser context: nothing to announce to yet */
  }
}

/**
 * Show a message on the page that comes AFTER a reload or a full navigation.
 *
 * Stores only. The host drains it when it next mounts, which is on the other side of the reload —
 * the only place a confirmation of "you switched networks" can survive, because that switch throws
 * this page away on purpose (every money module reads the active network at call time).
 */
export function toastAfterReload(message: string): void {
  try {
    sessionStorage.setItem(KEY, message);
  } catch {
    /* storage blocked — the switch still happens, it just goes unannounced */
  }
}

export function ToastHost() {
  const [message, setMessage] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const dismiss = useCallback(() => {
    setMessage(null);
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* nothing to clear */
    }
  }, []);

  useEffect(() => {
    setMounted(true);
    // Drain anything left for us by the page that reloaded.
    try {
      const stored = sessionStorage.getItem(KEY);
      if (stored) setMessage(stored);
    } catch {
      /* storage blocked */
    }
    const onToast = (e: Event) => setMessage((e as CustomEvent<string>).detail);
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, []);

  // The message is cleared from storage as soon as it is on screen: a toast that reappeared on
  // every subsequent navigation would stop meaning "this just happened".
  useEffect(() => {
    if (!message) return;
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* nothing to clear */
    }
    const t = setTimeout(() => setMessage(null), VISIBLE_MS);
    return () => clearTimeout(t);
  }, [message]);

  if (!mounted || !message) return null;

  return createPortal(
    <div className="app-toast" role="status" aria-live="polite">
      <span className="app-toast-text">{message}</span>
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="app-toast-x">
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>,
    document.body,
  );
}
