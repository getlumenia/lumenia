/**
 * /stats data — aggregated SERVER-SIDE from the public ledger, no DB, no mock.
 *
 * The sponsor's operation history is the source: every account the service funds
 * is a `create_account` op, every payment link is a `create_claimable_balance` op,
 * both attached to the sponsor because it pays their reserves + fees. We paginate
 * that feed and reduce it to plain COUNTS before anything leaves this module — the
 * feed carries recipient addresses, and none of them may reach the client (a
 * directory/leaderboard of money users was explicitly rejected; aggregates only).
 *
 * Honest scope (no-overclaim rule): `accountsCreated` counts every account the
 * service funded on the TEST network — including our own testing — NOT unique
 * people. There is no identity here, so a real user count is not something we can
 * prove, and we don't claim one. Claims-completed and the request funnel are NOT
 * derivable from this feed (a claim executes on the recipient account and the
 * sponsor only fee-bumps it, so it isn't a participant of that op) — they are
 * deliberately omitted rather than estimated.
 *
 * Server-only: called from the /stats server component with `revalidate = 300`, so
 * the ledger walk runs at most once every 5 minutes regardless of traffic.
 */
import { ACTIVE } from "./network";

const HORIZON_URL = ACTIVE.horizonUrl;
const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
const REVALIDATE = 300;
/** Safety cap on pagination (200 ops/page → 4000 ops). Logged if ever hit. */
const MAX_PAGES = 20;

export interface Stats {
  /** create_account ops — accounts the service funded (test network, incl. testing). */
  accountsCreated: number;
  /** create_claimable_balance ops in USDC — payment links created. */
  linksSent: number;
  /** sum of those link amounts. Computed but deliberately NOT shown on the test
   *  network (free-minted play money, all our own testing → a dollar figure would
   *  imply economic volume that doesn't exist). Wired for mainnet, where it means
   *  something. */
  dollarsSent: number;
  /** newest op timestamp — liveness. */
  lastActivityAt: string | null;
}

async function sponsorIdentity(): Promise<{ pubkey: string; issuer: string; code: string } | null> {
  try {
    const r = await fetch(`${SPONSOR_URL}/health`, { next: { revalidate: REVALIDATE } });
    if (!r.ok) return null;
    const d = (await r.json()) as { sponsorPublicKey?: string; usdcIssuer?: string; usdcCode?: string };
    if (!d.sponsorPublicKey || !d.usdcIssuer || !d.usdcCode) return null;
    return { pubkey: d.sponsorPublicKey, issuer: d.usdcIssuer, code: d.usdcCode };
  } catch {
    return null;
  }
}

interface HorizonOp {
  type: string;
  created_at: string;
  transaction_successful?: boolean;
  asset?: string;
  amount?: string;
}

/**
 * Returns the aggregates, or null if the ledger/sponsor is unreachable — the page
 * shows an honest "refreshing" state on null, never fabricated zeros.
 */
export async function loadStats(): Promise<Stats | null> {
  const id = await sponsorIdentity();
  if (!id) return null;

  const usdcAsset = `${id.code}:${id.issuer}`;
  let accountsCreated = 0;
  let linksSent = 0;
  let dollarsSent = 0;
  let lastActivityAt: string | null = null;

  let url: string | null = `${HORIZON_URL}/accounts/${id.pubkey}/operations?limit=200&order=desc`;
  let pages = 0;
  try {
    while (url && pages < MAX_PAGES) {
      const res: Response = await fetch(url, { next: { revalidate: REVALIDATE } });
      if (!res.ok) {
        // A 404 = the sponsor account has no history yet (fresh key): honest zeros.
        if (res.status === 404) break;
        return null; // transient upstream error → honest "refreshing", not zeros
      }
      const data = (await res.json()) as {
        _embedded?: { records?: HorizonOp[] };
        _links?: { next?: { href?: string } };
      };
      const records = data._embedded?.records ?? [];
      if (records.length === 0) break;
      for (const op of records) {
        if (op.transaction_successful === false) continue;
        if (lastActivityAt === null) lastActivityAt = op.created_at; // desc → first is newest
        if (op.type === "create_account") {
          accountsCreated++;
        } else if (op.type === "create_claimable_balance" && op.asset === usdcAsset) {
          linksSent++;
          dollarsSent += Number.parseFloat(op.amount ?? "0") || 0;
        }
      }
      pages++;
      if (records.length < 200) break; // short page = last page
      url = data._links?.next?.href ?? null;
    }
    if (pages >= MAX_PAGES) {
      console.log(`[stats] hit MAX_PAGES (${MAX_PAGES}) — totals are a floor, add cursoring`);
    }
  } catch {
    return null;
  }

  return { accountsCreated, linksSent, dollarsSent, lastActivityAt };
}
