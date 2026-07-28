"use client";

/**
 * A light foreground poll for ledger reads.
 *
 * Nothing in this app re-read the ledger on an interval except the nav bell, so money that landed
 * — a paid request, or a transfer straight to your address from somewhere else — stayed invisible
 * until the user happened to reload. That is fine for a page you open on purpose and wrong for a
 * page whose whole job is "watch for it to arrive".
 *
 * Three properties, each there for a reason:
 *   - VISIBLE TAB ONLY, and it fires immediately on becoming visible again. A background tab
 *     polling Horizon burns battery and rate limit for a screen nobody is looking at.
 *   - BACKOFF on consecutive failures (x2 up to a ceiling, reset on success). Without it a Horizon
 *     wobble turns every open tab into a request storm at exactly the moment Horizon is unhappy.
 *   - It reports its own state (`checking`, `lastCheckedAt`, `lastError`) so a screen can say
 *     "Checked 12s ago" and offer "Check again" instead of pretending to be live. Same honesty
 *     rule as everywhere else: show what is actually known.
 *
 * Deliberately NOT Horizon's SSE streaming: that holds an open connection per account, and there
 * is no server here to fan one out.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface PollState {
  /** Run the callback now (a "Check again" button), regardless of the interval. */
  refreshNow: () => void;
  /** A read is in flight. */
  checking: boolean;
  /** epoch ms of the last completed read, or null before the first one. */
  lastCheckedAt: number | null;
  /** The last error, or null. Surfaced rather than swallowed. */
  lastError: Error | null;
}

export function usePolling(
  fn: () => Promise<void>,
  opts: { intervalMs?: number; maxIntervalMs?: number; enabled?: boolean } = {},
): PollState {
  const { intervalMs = 20_000, maxIntervalMs = 120_000, enabled = true } = opts;
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<Error | null>(null);

  // The callback usually closes over state, so keep it in a ref: the effect below must not
  // re-subscribe (and reset the backoff) on every render.
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const inFlight = useRef(false);
  const delay = useRef(intervalMs);

  const run = useCallback(async () => {
    if (inFlight.current) return; // never stack reads on a slow network
    inFlight.current = true;
    setChecking(true);
    try {
      await fnRef.current();
      delay.current = intervalMs; // healthy again
      setLastError(null);
    } catch (e) {
      delay.current = Math.min(delay.current * 2, maxIntervalMs);
      setLastError(e as Error);
    } finally {
      inFlight.current = false;
      setChecking(false);
      setLastCheckedAt(Date.now());
    }
  }, [intervalMs, maxIntervalMs]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: number | undefined;

    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState === "visible") await run();
      if (!alive) return;
      timer = window.setTimeout(tick, delay.current);
    };
    void tick();

    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, run]);

  return { refreshNow: () => void run(), checking, lastCheckedAt, lastError };
}

/** "just now" / "12s ago" / "3m ago" — for the honest "last checked" line. */
export function agoLabel(at: number | null): string {
  if (at === null) return "";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}
