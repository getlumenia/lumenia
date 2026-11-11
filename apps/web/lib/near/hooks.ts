// The small hooks the NEAR screens share: a ticking clock, an interval that always sees the latest
// callback, and a network read with explicit loading and error states (never a silent default).
import { useEffect, useRef, useState } from "react";

/** Runs `fn` every `ms` while `ms` is a number; pass null to stop. The latest `fn` is always used. */
export function useInterval(fn: () => void, ms: number | null): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useNow(tickMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), tickMs);
  return now;
}

export type Loadable<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; message: string };

/**
 * A value read from the network with explicit loading and error states. `deps` restarts the read;
 * `refreshMs` re-reads on a timer (null for once). A read that fails keeps its last good value
 * out of the way: the state says "error" and the screen decides what to show.
 */
export function useLoadable<T>(load: () => Promise<T>, deps: unknown[], refreshMs: number | null = null) {
  const [v, setV] = useState<Loadable<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let alive = true;
    loadRef
      .current()
      .then((value) => alive && setV({ state: "ready", value }))
      .catch((e: unknown) => alive && setV({ state: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
    // The caller names its dependencies; `tick` is the refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  useInterval(() => setTick((t) => t + 1), refreshMs);
  return { value: v, reload: () => setTick((t) => t + 1) } as const;
}
