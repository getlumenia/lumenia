/**
 * USD→TRY for DISPLAY ONLY — a clearly-labeled estimate, never a quote and never
 * fabricated ledger data. Two tiers:
 *
 *   indicativeRate() — synchronous fallback constant. The FROZEN claim route
 *   /c/[id] renders against this (SSR, no fetch), so it stays sync and its
 *   semantics never change; keep the constant roughly current when touching this
 *   file (value below refreshed 2026-07-17 from the ECB reference rate).
 *
 *   getLiveRate() — the real ECB reference rate, fetched from OUR OWN
 *   /api/rate proxy (app/api/rate/route.ts) so the browser never opens a
 *   third-party connection from a money surface; the proxy caches upstream for
 *   1h. Browser-only callers (both consumers are client components) — the
 *   relative URL does not resolve on the server. Falls back to the constant on
 *   any failure, flagged { live: false } so the UI keeps the honest
 *   "indicative" label instead of implying freshness it doesn't have.
 */
const INDICATIVE_USD_TRY = 47.1; // ECB reference, as of 2026-07-17

export function indicativeRate(): number {
  return INDICATIVE_USD_TRY;
}

/** The upstream ECB reference feed. No key; updates once each ECB business day. */
const ECB_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=TRY";
const REVALIDATE_SEC = 3600;

/**
 * The rate, read SERVER-side. Used by `/api/rate` (the browser's proxy) and directly by the
 * server-rendered claim page.
 *
 * The claim page used to render `indicativeRate()` — a constant edited by hand — so every
 * recipient saw a lira figure that was however stale the last commit left it. It is the product's
 * highest-traffic screen and the first number a new person sees, and there is a real feed one
 * function call away. Next's fetch cache keeps this to one upstream request an hour across all
 * renders, and any failure returns the labeled constant with `live: false`, so the UI never
 * implies freshness it doesn't have.
 */
export async function getServerRate(): Promise<RateResult> {
  try {
    const res = await fetch(ECB_URL, { next: { revalidate: REVALIDATE_SEC } });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { rates?: { TRY?: number } };
    const rate = data.rates?.TRY;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) throw new Error("bad rate");
    return { rate, live: true };
  } catch {
    return { rate: INDICATIVE_USD_TRY, live: false };
  }
}

export interface RateResult {
  rate: number;
  /** true = the ECB reference feed answered; false = the labeled fallback constant */
  live: boolean;
}

export async function getLiveRate(): Promise<RateResult> {
  try {
    const res = await fetch("/api/rate");
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as Partial<RateResult>;
    if (typeof data.rate !== "number" || !Number.isFinite(data.rate) || data.rate <= 0) {
      throw new Error("bad rate");
    }
    return { rate: data.rate, live: data.live === true };
  } catch {
    return { rate: INDICATIVE_USD_TRY, live: false };
  }
}
