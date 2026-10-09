/**
 * The subrequest budget of one Worker invocation, MEASURED rather than estimated.
 *
 * A Worker on the Workers Free plan may make 50 subrequests per invocation, and "a subrequest is any
 * request a Worker makes using the Fetch API" (developers.cloudflare.com/workers/platform/limits):
 * every Upstash pipeline, Horizon read, Soroban RPC call, Circle read and, once the sponsor signs
 * through KMS, every KMS call and its retry. The 51st fails with "Too many subrequests". A live
 * testnet run hit that on /create-account (the channel pool's probes, since collapsed into one round
 * trip). The relays are where it bites now: after its send a relay polls getTransaction up to 40
 * times, and a worst-case relayed deposit has made about fifteen subrequests before its first poll
 * (a cold isolate's KMS GetPublicKey and its retry, the halt read, two rate-limit windows, the pilot
 * slot, the simulation, the cap, the fee charge, a KMS Sign and its retry, the send).
 *
 * So the Worker runs every request under a meter: an AsyncLocalStorage store opened around the
 * request (`withSubrequestMeter`, worker.ts) and a wrapper on the global fetch that counts each call
 * made inside it. A relay asks `subrequestsLeft()` before each poll and stops while it still has
 * room for what must follow the poll (the fee settle, a cap or pilot release, a channel release).
 * A poll skipped for the budget leaves the transaction where an unanswered poll window leaves it:
 * undecided, answered 202 with the hash, and settled by the client against the ledger.
 *
 * The ceiling is SUBREQUEST_BUDGET, five under the platform's limit. Outside a metered request (the
 * node server, a script, a suite that calls a handler directly) nothing is counted and the budget is
 * unlimited, which is the behaviour from before this module. The env signer and the KMS signer pass
 * through the same meter, so each poll window is as long as that signer's own spend allows.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Cloudflare's subrequest limit per invocation on the Workers Free plan. */
export const WORKER_SUBREQUEST_LIMIT = 50;

/** What this service lets one request spend: five under the platform's limit, as headroom. */
export const SUBREQUEST_BUDGET = 45;

interface Meter {
  used: number;
  limit: number;
}

const meter = new AsyncLocalStorage<Meter>();

/** Marks the counting wrapper, so a request never wraps a fetch that already counts. */
const METERED = Symbol.for("lumenia.sponsor.meteredFetch");

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type MeteredFetch = FetchFn & { [METERED]?: true };

/**
 * Wrap the global fetch so every call made inside a metered request is counted, once. Checked per
 * request rather than once per isolate: a test that replaces the global fetch gets its replacement
 * counted by the next request instead of silently dropping out of the meter.
 */
function ensureMeteredFetch(): void {
  const current = globalThis.fetch as MeteredFetch;
  if (current[METERED]) return;
  const counted: MeteredFetch = (input, init) => {
    const m = meter.getStore();
    if (m) m.used += 1;
    return current.call(globalThis, input, init);
  };
  counted[METERED] = true;
  globalThis.fetch = counted as typeof fetch;
}

/** Run one request under a fresh meter. Every fetch it makes, waitUntil work included, counts. */
export function withSubrequestMeter<T>(run: () => Promise<T>, limit = SUBREQUEST_BUDGET): Promise<T> {
  ensureMeteredFetch();
  return meter.run({ used: 0, limit }, run);
}

/** How many more subrequests this request may make; Infinity outside a metered request. */
export function subrequestsLeft(): number {
  const m = meter.getStore();
  return m ? m.limit - m.used : Number.POSITIVE_INFINITY;
}

/** How many subrequests this request has made so far (0 outside a metered request). */
export function subrequestsUsed(): number {
  return meter.getStore()?.used ?? 0;
}
