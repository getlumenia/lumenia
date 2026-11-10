/**
 * ONE deadline for every request to the shared Upstash store.
 *
 * The rate limiter, the escrow caps, the onboarding budget, the pilot allowlist, the channel
 * leases, the event counters, the kill switch and the watchdog's cursors all reach the same REST
 * store, and each of them documents what it does when the store FAILS: the limiter drops to its
 * in-memory buckets, the caps fail open or closed as configured, the pilot gate refuses, the
 * channel pool falls back to the sponsor-sourced path, the halt read fails open. Until 2026-11-10
 * only the halt read had a deadline; every other request waited as long as the platform let it,
 * so a store that accepted connections and then stalled held /v2-claim and /feebump open instead
 * of degrading, and the documented postures never triggered because no error ever arrived.
 *
 * `storeFetch` is `fetch` with that deadline. A request that does not answer in time rejects with
 * a `StoreTimeoutError`, an ordinary store error to every caller, so the posture a module
 * documents for "the store failed" is the posture it takes for "the store stalled". The value is
 * generous against the store's real latency (tens of milliseconds, a few hundred across regions)
 * and short against a Worker's wall clock; it is the same 2 s the halt read had.
 *
 * Node's `AbortSignal.timeout` timer does not keep the event loop alive and a Worker request does,
 * so nothing here holds a process open.
 */

/** How long one store request may take before it counts as a store failure. */
export const STORE_TIMEOUT_MS = 2_000;

/** The store did not answer within STORE_TIMEOUT_MS. */
export class StoreTimeoutError extends Error {
  constructor() {
    super(`the store did not answer within ${STORE_TIMEOUT_MS} ms`);
    this.name = "StoreTimeoutError";
  }
}

/** True for the rejection `fetch` produces when its signal was `AbortSignal.timeout`. */
function isTimeout(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * `fetch(url, init)` against the store, bounded by STORE_TIMEOUT_MS. Any `signal` in `init` is
 * replaced: the deadline is the store's, not the caller's. Rejects with StoreTimeoutError on the
 * deadline and with whatever `fetch` threw otherwise; an HTTP error status is still an answer and
 * is left to the caller, as before.
 */
export async function storeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(STORE_TIMEOUT_MS) });
  } catch (e) {
    if (isTimeout(e)) throw new StoreTimeoutError();
    throw e;
  }
}
