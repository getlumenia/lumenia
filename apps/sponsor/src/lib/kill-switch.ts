/**
 * Sponsor kill-switch — halts every VALUE-MOVING endpoint in one flip (incident response for
 * hot-key compromise / anomalous spend; see ops/RUNBOOK_SPONSOR_KEY.md). Two triggers, OR'd:
 *
 *   - env `SPONSOR_HALT=1` — static hard stop (needs a `wrangler deploy` / var change);
 *   - the KV key `sponsor:halt` set to `"1"` in the SAME Upstash store the rate-limiter uses —
 *     INSTANT, no deploy:  curl -H "authorization: Bearer $KV_REST_API_TOKEN" \
 *                               "$KV_REST_API_URL/set/sponsor:halt/1"
 *     (and `/del/sponsor:halt` to resume).
 *
 * Store errors fail OPEN (an outage of the limiter store must never take the product down by
 * itself) — the env flag is the guaranteed hard stop that needs no store. The verdict is cached
 * for a few seconds per isolate so the steady-state per-request cost is ~zero.
 */
import { kvConfigFromEnv } from "./rate-limit.js";

const CACHE_MS = 5_000;
let cache = { halted: false, at: 0 };

/** The Redis key an operator flips to halt the sponsor instantly. */
export const HALT_KEY = "sponsor:halt";

export async function isHalted(now = Date.now()): Promise<boolean> {
  if (process.env.SPONSOR_HALT === "1") return true;
  const kv = kvConfigFromEnv();
  if (!kv) return false;
  if (now - cache.at < CACHE_MS) return cache.halted;
  try {
    const res = await fetch(`${kv.url}/get/${HALT_KEY}`, {
      headers: { authorization: `Bearer ${kv.token}` },
    });
    if (!res.ok) throw new Error(`halt store returned ${res.status}`);
    const body = (await res.json()) as { result?: unknown };
    cache = { halted: body.result === "1", at: now };
  } catch {
    cache = { halted: false, at: now }; // fail open — SPONSOR_HALT=1 is the hard stop
  }
  return cache.halted;
}
