import { NextResponse } from "next/server";
import { getServerRate } from "../../../lib/rate";

/**
 * GET /api/rate — server-side proxy for the indicative USD→TRY reference rate
 * (ECB, via api.frankfurter.dev — no key, updates each ECB business day).
 *
 * The proxy exists so the BROWSER only ever talks to our own origin: /home is a
 * money surface, and it should not open a third-party connection (with the
 * user's IP) just to decorate the balance with an indicative ₺ line. Server-side,
 * Next's fetch cache + the route's revalidate keep the upstream call to at most
 * once an hour. On any failure the labeled fallback constant is returned with
 * live:false so the UI keeps the honest "indicative" wording.
 *
 * The fetch itself lives in lib/rate.ts so the server-rendered claim page can read
 * the same cached value without going through HTTP.
 */
export const revalidate = 3600;

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await getServerRate());
}
