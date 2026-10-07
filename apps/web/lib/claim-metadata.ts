/**
 * What a v2 claim link tells a chat app's preview fetcher, and what its card image may paint.
 *
 * Every chat app fetches a pasted link to build its preview, and it builds it from this metadata and
 * from the image it points at. So these two decide what a stranger's phone shows about somebody
 * else's money before anyone has opened anything:
 *
 *   - a PRIVATE link (the default): the fixed card from lib/link-preview.ts, the same words for every
 *     link. Nothing in the URL can reach it, so a forwarded link with `?a=999&s=Mallory` appended
 *     still says only "Lumenia".
 *   - a RICH link (`preview=rich`, the sender's explicit choice): the sender's name from the query,
 *     and the amount READ FROM THE LEDGER on the server. Never from `a=`: a figure anyone can edit in
 *     a URL is not proof of anything, and this card carries our domain.
 *
 * The ledger read is bounded (LEDGER_READ_TIMEOUT_MS). A preview fetcher gives up after a few seconds
 * and then shows nothing at all, so a slow RPC degrades the title to "<name> sent you money" instead
 * of costing the whole card. A read that throws, a network this deployment cannot serve, or an
 * escrow that holds nothing all degrade the same way, and none of them may crash the page.
 *
 * The readers are injectable (`deps`) so lib/claim-metadata.selftest.ts can hold every branch
 * without a network.
 */
import type { Metadata } from "next";
import { formatUsd } from "./money";
import { RICH_PREVIEW_PARAM, RICH_PREVIEW_VALUE, readClaimQuery } from "./link-fragment";
import { PRIVATE_PREVIEW_IMAGE, privateClaimMetadata } from "./link-preview";
import { loadDrop, loadPool } from "./lumendrop";
import { resolveNetwork, type NetworkConfig } from "./network";

/** How long a preview may wait on the ledger before it settles for "sent you money". */
export const LEDGER_READ_TIMEOUT_MS = 2500;

/**
 * The description of a rich card. Fixed: the title is the only line that carries the name and the
 * amount, so there is exactly one place a reviewer has to look to know what a card can say.
 */
export const RICH_PREVIEW_DESCRIPTION =
  "Open the link to claim it. No app, no sign-up, and the recipient pays no gas.";

/** The name a card prints when the link carries none. */
const NO_NAME = "Someone";

/** A link id is the 32-byte link public key, hex. Anything else is not a drop in any escrow. */
const LINK_HEX = /^[0-9a-f]{64}$/i;

/** The ledger readers, swappable for the self-test. Defaults are the real ones. */
export interface LedgerDeps {
  loadDrop: (linkHex: string, opts: { net: NetworkConfig }) => Promise<{ amount: string } | null>;
  loadPool: (linkHex: string, opts: { net: NetworkConfig }) => Promise<{ perShare: string } | null>;
  resolveNetwork: (param?: string | null) => NetworkConfig;
  timeoutMs: number;
}

const DEFAULT_DEPS: LedgerDeps = {
  loadDrop: (linkHex, opts) => loadDrop(linkHex, opts),
  loadPool: (linkHex, opts) => loadPool(linkHex, opts),
  resolveNetwork,
  timeoutMs: LEDGER_READ_TIMEOUT_MS,
};

type Search = URLSearchParams | Record<string, string | string[] | undefined>;

/**
 * The amount the escrow holds behind a link, as 7dp USDC, or null for every answer that is not one:
 * a malformed id, a network this deployment cannot serve, an unreachable escrow, no record, a
 * non-positive amount, or no answer inside the timeout.
 *
 * `group` asks the pool and returns ONE share (`perShare`): that is what a claimant receives, and
 * the pot is not carried anywhere on the ledger.
 */
async function readLedgerAmount(
  linkHex: string,
  where: { group: boolean; mainnet: boolean },
  deps: LedgerDeps,
): Promise<string | null> {
  if (!LINK_HEX.test(linkHex)) return null;
  let net: NetworkConfig;
  try {
    // Throws for a mainnet link on a deployment with no mainnet configured. No amount, no crash.
    net = deps.resolveNetwork(where.mainnet ? "public" : null);
  } catch {
    return null;
  }
  let read: Promise<string | null>;
  try {
    read = where.group
      ? deps.loadPool(linkHex, { net }).then((p) => p?.perShare ?? null)
      : deps.loadDrop(linkHex, { net }).then((d) => d?.amount ?? null);
  } catch {
    return null; // a reader that throws before it even returns a promise
  }
  const amount = await withTimeout(read, deps.timeoutMs);
  return amount !== null && Number.parseFloat(amount) > 0 ? amount : null;
}

/** `p`'s value, or null when it throws or has not settled after `ms`. Never rejects. */
async function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    // The read keeps running after a timeout; its rejection is caught here so it can never surface
    // as an unhandled one in the server log.
    return await Promise.race([p.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The rich card's image URL. Only the id, the name and the public markers: never an amount. */
function richImageUrl(linkHex: string, name: string, slots: number | null, mainnet: boolean): string {
  const parts = [
    `${RICH_PREVIEW_PARAM}=${RICH_PREVIEW_VALUE}`,
    `l=${encodeURIComponent(linkHex)}`,
    `s=${encodeURIComponent(name)}`,
    ...(slots !== null ? [`g=${slots}`] : []),
    ...(mainnet ? ["n=public"] : []),
  ];
  return `/c/x/og?${parts.join("&")}`;
}

/**
 * The metadata of /v2/c/[linkHex].
 *
 * Private (the default, and every link without `preview=rich`): `privateClaimMetadata()`, untouched
 * by anything in the query. Rich: "<name> sent you <amount>" with the amount from the ledger, or
 * "<name> sent you money" when the ledger did not answer with one; a fixed description; the card
 * image from the OG route, which reads the ledger itself; and no indexing either way.
 */
export async function v2ClaimMetadata(
  linkHex: string,
  searchParams: Search,
  deps?: Partial<LedgerDeps>,
): Promise<Metadata> {
  const q = readClaimQuery(searchParams);
  if (!q.rich) return privateClaimMetadata();
  const d = { ...DEFAULT_DEPS, ...deps };
  const name = q.queryName ?? NO_NAME;
  const amount = await readLedgerAmount(linkHex, { group: q.slots !== null, mainnet: q.mainnet }, d);
  const title = amount ? `${name} sent you ${formatUsd(amount)}` : `${name} sent you money`;
  const image = {
    url: richImageUrl(linkHex, name, q.slots, q.mainnet),
    width: PRIVATE_PREVIEW_IMAGE.width,
    height: PRIVATE_PREVIEW_IMAGE.height,
    alt: title,
  };
  return {
    title: { absolute: title },
    description: RICH_PREVIEW_DESCRIPTION,
    openGraph: { title, description: RICH_PREVIEW_DESCRIPTION, images: [image] },
    twitter: { card: "summary_large_image", title, description: RICH_PREVIEW_DESCRIPTION, images: [image] },
    robots: { index: false, follow: false },
  };
}

/** What the OG route at /c/[id]/og may draw. */
export type OgDecision =
  | { kind: "static" }
  | { kind: "rich"; linkHex: string; name: string; slots: number | null; mainnet: boolean };

/**
 * Paint, or send the fixed card? Only `preview=rich` with a 64-hex `l` is painted. Everything else,
 * a pre-D2 `?a=..&s=..` card URL included, is the static image: the route never draws a name or a
 * figure that only a query string vouches for.
 */
export function ogDecision(search: Search): OgDecision {
  const q = readClaimQuery(search);
  const raw = search instanceof URLSearchParams ? search.get("l") : search.l;
  const l = Array.isArray(raw) ? raw[0] : raw;
  if (!q.rich || typeof l !== "string" || !LINK_HEX.test(l)) return { kind: "static" };
  return { kind: "rich", linkHex: l.toLowerCase(), name: q.queryName ?? NO_NAME, slots: q.slots, mainnet: q.mainnet };
}

/** The words on a rich card: the name, and the ledger amount formatted, or null when unread. */
export async function richCard(
  decision: Extract<OgDecision, { kind: "rich" }>,
  deps?: Partial<LedgerDeps>,
): Promise<{ name: string; usd: string | null; group: boolean }> {
  const group = decision.slots !== null;
  const amount = await readLedgerAmount(
    decision.linkHex,
    { group, mainnet: decision.mainnet },
    { ...DEFAULT_DEPS, ...deps },
  );
  return { name: decision.name, usd: amount ? formatUsd(amount) : null, group };
}
