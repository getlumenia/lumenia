/** Small hooks the screens share. */
import { useEffect, useRef, useState } from "preact/hooks";

/** The current time, refreshed on an interval, so a pill that depends on "now" ages on screen. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Whole seconds left until `untilMs`, counting down once a second; 0 when it has passed. */
export function useCountdown(untilMs: number): number {
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((untilMs - Date.now()) / 1000)));
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.ceil((untilMs - Date.now()) / 1000)));
    tick();
    const t = window.setInterval(tick, 500);
    return () => window.clearInterval(t);
  }, [untilMs]);
  return left;
}

/** A flag that turns on for a moment (the "Copied" confirmation) and turns itself off again. */
export function useFlash(ms = 1800): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = () => {
    setOn(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), ms);
  };
  return [on, flash];
}

/** True until the component unmounts: guards a setState that arrives after the screen is gone. */
export function useAlive(): { readonly current: boolean } {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));
