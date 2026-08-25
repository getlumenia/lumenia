/**
 * A small stock of ready demo links, so /try answers in milliseconds instead of a ledger.
 *
 * THE PROBLEM IS NOT OUR CODE. Minting a demo link creates a Claimable Balance, and a transaction
 * is not real until a ledger closes — about five seconds on Stellar, measured 4.9–7.3s end to end
 * against the live sponsor. That is the entire wait behind "Making your link…", and no amount of
 * tightening this service removes it: it is the network's heartbeat, not our latency.
 *
 * So the wait moves off the visitor's tap. A handful of links are minted in advance and handed out
 * instantly; the ledger wait then happens in the background, refilling the stock for the next
 * person. A cold or empty pool falls back to minting inline — the old behaviour exactly — because
 * a slow link is still far better than an error.
 *
 * WHAT IS STORED, AND WHY THAT IS ACCEPTABLE HERE. A pooled entry contains the bearer secret: the
 * key to $5 of TEST-USDC. Everywhere else in this product a spendable key never touches a server,
 * and that rule does not bend — but this endpoint's entire purpose is to hand that key to whoever
 * presses the button, on testnet, from a faucet, with the faucet able to reclaim it after an hour.
 * Nothing here is anyone's money. Two guards keep it that way:
 *   - the pool refuses to operate on anything but testnet;
 *   - entries expire well before the faucet's own reclaim window, so a forgotten link cannot sit in
 *     the store indefinitely.
 * This machinery must never be pointed at the real send path.
 */
import { kvConfigFromEnv } from "./rate-limit.js";
import type { DemoLinkResult } from "./demo-link.js";

const KEY = "lumenia:demo-pool";
/** How many ready links to keep. Each one parks a faucet reserve, so this is deliberately small. */
const TARGET = 3;
/** Entries older than this are dropped rather than served — the faucet reclaims at 1h. */
const MAX_AGE_MS = 40 * 60 * 1000;
/** A bound on how many stale entries one request will discard before giving up and minting. */
const MAX_DISCARD = 5;

interface PooledLink extends DemoLinkResult {
  /** When it was minted, so a link that has been sitting too long is never handed out. */
  mintedAt: number;
}

async function pipeline(commands: string[][]): Promise<Array<{ result?: unknown; error?: string }>> {
  const kv = kvConfigFromEnv();
  if (!kv) return [];
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`demo pool store returned ${res.status}`);
  return (await res.json()) as Array<{ result?: unknown; error?: string }>;
}

/** Testnet only, and only with a store to keep the stock in. */
function poolUsable(network: string): boolean {
  return network === "testnet" && kvConfigFromEnv() !== null;
}

/**
 * Take one ready link, or null when the stock is empty (or too stale to trust). Discarding is
 * bounded: a pool full of expired entries must not turn one request into a long loop.
 */
export async function takeDemoLink(network: string): Promise<DemoLinkResult | null> {
  if (!poolUsable(network)) return null;
  for (let i = 0; i < MAX_DISCARD; i++) {
    let raw: unknown;
    try {
      [{ result: raw }] = await pipeline([["RPOP", KEY]]);
    } catch {
      return null; // a store hiccup is not a reason to fail the request — mint inline instead
    }
    if (typeof raw !== "string") return null;
    let entry: PooledLink;
    try {
      entry = JSON.parse(raw) as PooledLink;
    } catch {
      continue; // unreadable row: drop it and look at the next
    }
    if (!entry.balanceId || !entry.bearerSecret) continue;
    if (Date.now() - (entry.mintedAt ?? 0) > MAX_AGE_MS) continue; // too close to the reclaim window
    const { mintedAt: _mintedAt, ...link } = entry;
    return link;
  }
  return null;
}

/**
 * Top the stock back up to TARGET, one mint at a time.
 *
 * Called from `ctx.waitUntil`, so it runs AFTER the visitor already has their link and its ledger
 * waits cost them nothing. Failures are swallowed on purpose: the pool is an optimisation, and a
 * faucet that is out of XLM should slow the demo down, not break it.
 */
export async function refillDemoPool(
  network: string,
  mint: () => Promise<DemoLinkResult>,
): Promise<number> {
  if (!poolUsable(network)) return 0;
  let have = 0;
  try {
    const [{ result }] = await pipeline([["LLEN", KEY]]);
    have = Number(result ?? 0);
  } catch {
    return 0;
  }
  let added = 0;
  for (let i = have; i < TARGET; i++) {
    try {
      const link = await mint();
      await pipeline([["LPUSH", KEY, JSON.stringify({ ...link, mintedAt: Date.now() } satisfies PooledLink)]]);
      added++;
    } catch (e) {
      console.warn(`[demo-pool] refill stopped: ${(e as Error).message}`);
      break;
    }
  }
  return added;
}
