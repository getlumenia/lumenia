/**
 * Sponsor kill-switch — halts every VALUE-MOVING endpoint in one flip (incident response for
 * hot-key compromise / anomalous spend; see ops/RUNBOOK_SPONSOR_KEY.md). Three triggers, OR'd:
 *
 *   - env `SPONSOR_HALT=1`: static hard stop (needs a `wrangler deploy` / var change); the only
 *     stop that needs no store at all, and the one that is per Worker by construction;
 *   - the KV key `sponsor:halt:<network>` set to `"1"` in the SAME Upstash store the rate-limiter
 *     uses: INSTANT, no deploy, and the key the WATCHDOG writes when it auto-halts (lib/watchdog.ts):
 *       curl -H "authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/set/sponsor:halt:mainnet/1"
 *     (and `/del/sponsor:halt:mainnet` plus `/del/sponsor:halt:mainnet:reason` to resume);
 *   - the legacy global key `sponsor:halt`, still honoured so the runbook's older command keeps
 *     working. It is NOT namespaced: the two Workers very likely share one Upstash store (every
 *     counter in lib/caps.ts is namespaced by network for exactly that reason), so flipping the
 *     bare key halts BOTH networks. That is acceptable for an operator who means "stop everything"
 *     and unacceptable for a testnet rehearsal or a testnet watchdog, which is why those use the
 *     namespaced key (SOW 2, D3 item f).
 *
 * Every function that WRITES a halt, or names a key, takes the network explicitly. The watchdog
 * used to halt whatever `STELLAR_NETWORK` its process held: a local run configured for testnet,
 * started from a shell that exported mainnet, wrote `sponsor:halt:mainnet` while its own page told
 * the operator to clear `sponsor:halt:testnet`. The READ that guards the routes still defaults to
 * the environment's network, because a Worker serves exactly the network its environment names
 * (loadConfig reads the same variable) and that is the halt it has to obey.
 *
 * Store errors fail OPEN (an outage of the limiter store must never take the product down by
 * itself; halt also blocks the EXIT routes, and a recipient must not lose access to escrowed money
 * because a counter store had a bad minute): the env flag is the guaranteed hard stop that needs no
 * store. This is a decided, disclosed posture (evidence/SOW2_READINESS_REPORT.md, the honest list),
 * not an oversight. The verdict is cached for a few seconds per isolate so the steady-state
 * per-request cost is ~zero, and a read already in flight is SHARED: a burst of requests that
 * finds the cache stale costs one store read per isolate and network, not one per request.
 */
import type { StellarNetwork } from "./config.js";
import { kvConfigFromEnv } from "./rate-limit.js";

const CACHE_MS = 5_000;

/** The legacy Redis key an operator flips to halt BOTH sponsors instantly. */
export const HALT_KEY = "sponsor:halt";

export type HaltSource = "env" | "store" | "store-legacy" | null;

export interface HaltVerdict {
  halted: boolean;
  source: HaltSource;
  reason: string | null;
}

/* Cached per network, so a process that reads both halts (a test, an operator's script) can never
 * answer one network's question with the other network's verdict. */
const cache = new Map<StellarNetwork, HaltVerdict & { at: number }>();
/** The store read in flight per network, which every caller arriving meanwhile awaits. */
const inflight = new Map<StellarNetwork, Promise<HaltVerdict>>();
/** Bumped by every write of a verdict (setHalt, clearHalt, a reset): a read that started before
 *  the bump is older than what was written and must not replace it in the cache. Timestamps could
 *  not tell: the watchdog stamps its halt with the time its RUN started, seconds before a read
 *  that left during the run, which then overwrote the halt with "not halted" (a review showed it). */
let generation = 0;
/** A halt read that does not answer in time fails open like any other store error, instead of
 *  holding every value request of the isolate behind it. */
const READ_TIMEOUT_MS = 2_000;

/** The network this process serves according to its environment: the halt the request path obeys. */
function envNetwork(): StellarNetwork {
  return process.env.STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

/** The per-network halt key: `sponsor:halt:<network>`. No default: a default is how the wrong network gets halted. */
export function haltKey(network: StellarNetwork): string {
  return `${HALT_KEY}:${network}`;
}

/** Where the reason for a halt is kept, so /health and an operator can read why without a log. */
export function haltReasonKey(network: StellarNetwork): string {
  return `${haltKey(network)}:reason`;
}

async function kvPipeline(kv: { url: string; token: string }, commands: string[][], timeoutMs?: number): Promise<unknown[]> {
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (!res.ok) throw new Error(`halt store returned ${res.status}`);
  const rows = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  for (const r of rows) if (r?.error) throw new Error(`halt store error: ${r.error}`);
  return rows.map((r) => r.result);
}

/** Read both keys (and the reason) in one round trip; throws on a store error. */
async function readHalt(kv: { url: string; token: string }, network: StellarNetwork): Promise<HaltVerdict> {
  const [scoped, legacy, reason] = await kvPipeline(
    kv,
    [
      ["GET", haltKey(network)],
      ["GET", HALT_KEY],
      ["GET", haltReasonKey(network)],
    ],
    READ_TIMEOUT_MS,
  );
  if (scoped === "1") return { halted: true, source: "store", reason: typeof reason === "string" ? reason : null };
  if (legacy === "1") return { halted: true, source: "store-legacy", reason: null };
  return { halted: false, source: null, reason: null };
}

export async function isHalted(now = Date.now(), network: StellarNetwork = envNetwork()): Promise<boolean> {
  return (await haltStatus(now, network)).halted;
}

/**
 * The full verdict: halted or not, by which trigger, and why (when the store knows). /health
 * reports it so an operator can tell a watchdog auto-halt from a hand-flipped key from a deploy
 * with SPONSOR_HALT=1 without opening three dashboards.
 */
export async function haltStatus(now = Date.now(), network: StellarNetwork = envNetwork()): Promise<HaltVerdict> {
  if (process.env.SPONSOR_HALT === "1") return { halted: true, source: "env", reason: "SPONSOR_HALT=1 in the Worker environment" };
  const kv = kvConfigFromEnv();
  if (!kv) return { halted: false, source: null, reason: null };
  const hit = cache.get(network);
  if (hit && now - hit.at < CACHE_MS) return { halted: hit.halted, source: hit.source, reason: hit.reason };
  const pending = inflight.get(network);
  if (pending) return pending;
  const startedAt = generation;
  const read = (async (): Promise<HaltVerdict> => {
    let verdict: HaltVerdict;
    try {
      verdict = await readHalt(kv, network);
    } catch {
      verdict = { halted: false, source: null, reason: null }; // fail open: SPONSOR_HALT=1 is the hard stop
    }
    // A verdict written by this isolate while the read was out (setHalt, clearHalt) wins.
    if (generation === startedAt) cache.set(network, { ...verdict, at: now });
    return verdict;
  })().finally(() => inflight.delete(network));
  inflight.set(network, read);
  return read;
}

/**
 * Whether `sponsor:halt:<network>` is set in the store right now, read past the cache; null when
 * there is no store or it cannot answer. The watchdog asks just before it writes a halt, so a halt
 * that is NEW (the key was absent, for instance because an operator has just deleted it) is
 * emailed at once instead of waiting out the alert cooldown left by the halt before it.
 */
export async function storeHaltIsSet(network: StellarNetwork): Promise<boolean | null> {
  const kv = kvConfigFromEnv();
  if (!kv) return null;
  try {
    const [scoped] = await kvPipeline(kv, [["GET", haltKey(network)]]);
    return scoped === "1";
  } catch {
    return null;
  }
}

/**
 * Halt the given network's sponsor through the store: what the watchdog calls on a key-compromise
 * tripwire (with the network of the config it was handed, never the shell's), and what an operator
 * may call from a script. No TTL on purpose: a halt ends when a person ends it. The reason is
 * stored next to it with a timestamp, so the person who finds the sponsor paused learns why from
 * /health instead of from a log that may have rolled.
 */
export async function setHalt(network: StellarNetwork, reason: string, now = Date.now()): Promise<boolean> {
  const kv = kvConfigFromEnv();
  if (!kv) return false;
  const stamped = `${new Date(now).toISOString()} ${reason}`;
  await kvPipeline(kv, [
    ["SET", haltKey(network), "1"],
    ["SET", haltReasonKey(network), stamped],
  ]);
  generation++;
  cache.set(network, { halted: true, source: "store", reason: stamped, at: Date.now() });
  return true;
}

/** Resume the given network's sponsor: both the flag and its reason are deleted. Never touches the legacy key. */
export async function clearHalt(network: StellarNetwork): Promise<boolean> {
  const kv = kvConfigFromEnv();
  if (!kv) return false;
  await kvPipeline(kv, [
    ["DEL", haltKey(network)],
    ["DEL", haltReasonKey(network)],
  ]);
  generation++;
  cache.delete(network);
  return true;
}

/** Test seam: forget the cached verdicts so the next read hits the store. */
export function resetHaltCache(): void {
  generation++;
  cache.clear();
  inflight.clear();
}
