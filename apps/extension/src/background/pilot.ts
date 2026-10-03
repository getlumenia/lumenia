/**
 * "Is this account approved for real money?", asked of the MAINNET sponsor and cached for a minute.
 *
 * The cache is not an optimisation. The mainnet Worker meters /pilot-status in the same per-account
 * bucket as /v2-deposit (5 requests a minute), so asking on every popup open would rate-limit the
 * very send the answer was for. A failed ask is never read as "not approved": the last known answer
 * is kept and marked by its age, and with none the caller is told the answer is unknown.
 */
import { PILOT_CACHE_MS } from "../config";
import { mainnetConfig } from "../core";
import { fail } from "../lib/errors";
import { K, session } from "../lib/storage";
import type { PilotInfo } from "../lib/types";

/** A forced ask still waits this long after the last one, so a nervous double tap costs one request. */
const FORCE_FLOOR_MS = 10_000;
/**
 * The oldest cached answer that may stand in for a failed ask. Past it, an approval the sponsor may
 * since have withdrawn is not used to sign anything: the answer is "unknown" until the sponsor can
 * be asked again. (The sponsor still refuses an unapproved deposit itself; this only stops the
 * extension from signing on a stale yes.)
 */
export const PILOT_STALE_MAX_MS = 5 * 60_000;

export async function cachedPilot(pubkey: string): Promise<PilotInfo | null> {
  return (await session().get<PilotInfo>(K.pilot(pubkey))) ?? null;
}

export async function pilotStatus(pubkey: string, opts: { force?: boolean; now?: number } = {}): Promise<PilotInfo> {
  const now = opts.now ?? Date.now();
  const cached = await cachedPilot(pubkey);
  if (cached && now - cached.at < (opts.force ? FORCE_FLOOR_MS : PILOT_CACHE_MS)) return cached;

  const mainnet = mainnetConfig();
  if (!mainnet) throw fail("pilot-unknown", "Real money is not available in this build.");
  const fallback = cached && now - cached.at <= PILOT_STALE_MAX_MS ? cached : null;
  let res: Response;
  try {
    res = await fetch(`${mainnet.sponsorUrl.replace(/\/$/, "")}/pilot-status?pubkey=${encodeURIComponent(pubkey)}`);
  } catch {
    if (fallback) return fallback;
    throw fail("pilot-unknown");
  }
  if (res.status === 429) {
    if (fallback) return fallback;
    throw fail("rate-limited");
  }
  if (!res.ok) {
    if (fallback) return fallback;
    throw fail("pilot-unknown");
  }
  const d = (await res.json().catch(() => null)) as Partial<PilotInfo> | null;
  // A 200 that is not the sponsor's answer (a captive portal, a proxy page) is "could not ask",
  // never "not approved": nothing is cached, and the last real answer stands.
  if (!d || typeof d !== "object" || typeof d.approved !== "boolean") {
    if (fallback) return fallback;
    throw fail("pilot-unknown");
  }
  const info: PilotInfo = {
    pilot: d.pilot === true,
    approved: d.approved === true,
    state: typeof d.state === "string" ? d.state : d.approved ? "approved" : "none",
    used: Number.isFinite(Number(d.used)) ? Number(d.used) : 0,
    limit: Number.isFinite(Number(d.limit)) ? Number(d.limit) : 0,
    at: now,
  };
  await session().set({ [K.pilot(pubkey)]: info });
  return info;
}

/** Real money is open for this account right now: approved, with a send left. */
export function canSendRealMoney(p: PilotInfo): boolean {
  return p.approved && (p.limit <= 0 || p.used < p.limit);
}
