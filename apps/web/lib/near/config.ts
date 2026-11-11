/**
 * The NEAR rail's configuration: build-time NEXT_PUBLIC_ values with testnet defaults, so a
 * checkout runs against the live testnet contract with no env file at all.
 *
 * Every name is spelled out in full: Next inlines a NEXT_PUBLIC_ value only where its whole name is
 * written, so `process.env[name]` would read undefined in the browser.
 *
 * The pure modules next to this one never read the environment themselves; they take these values
 * as parameters, which is what keeps them usable from the self-test under plain Node.
 */

const trimmed = (v: string | undefined): string => (v ?? "").trim();

/** "testnet" today. The whole rail is testnet-only until the escrow has been reviewed. */
export const NEAR_NETWORK = trimmed(process.env.NEXT_PUBLIC_NEAR_NETWORK) || "testnet";
export const NEAR_IS_TESTNET = NEAR_NETWORK !== "mainnet";

/** The LumenDrop escrow on NEAR: drops keyed by a link's public key, claimed by the link key. */
export const NEAR_CONTRACT_ID = trimmed(process.env.NEXT_PUBLIC_NEAR_CONTRACT_ID) || "lumenia-near.testnet";

/** Circle's testnet USDC on NEAR (NEP-141, 6 decimals). */
export const NEAR_USDC_ID =
  trimmed(process.env.NEXT_PUBLIC_NEAR_USDC_ID) || "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

/**
 * One RPC URL, or several separated by commas, tried in order. rpc.testnet.near.org is deprecated
 * and answers 429 without CORS headers after a few calls, so FastNEAR is the default.
 */
export const NEAR_RPC = trimmed(process.env.NEXT_PUBLIC_NEAR_RPC) || "https://test.rpc.fastnear.com";

/**
 * The relayer that pays the gas of a pay-forward link or a relayed take-back. A BASE url: the client
 * posts to `${base}/relay` and reads `${base}/health` and `${base}/policy`, so the same code serves
 * the standalone Worker of the hackathon build and the sponsor's `/near` mount that replaces it.
 */
export const NEAR_RELAYER_URL = (
  trimmed(process.env.NEXT_PUBLIC_NEAR_RELAYER_URL) || "https://lumenia-near-relayer.avakit.workers.dev"
).replace(/\/+$/, "");

/**
 * The shared demo sender: a throwaway testnet account whose key is public by design, so a judge
 * can make a link without owning a NEAR account. Both values come from the deployment; the button
 * appears only when both are set (lib/near/demo.ts demoSenderAvailable).
 */
export const NEAR_DEMO_FUNDER_ID = trimmed(process.env.NEXT_PUBLIC_NEAR_DEMO_FUNDER_ID);
export const NEAR_DEMO_FUNDER_KEY = trimmed(process.env.NEXT_PUBLIC_NEAR_DEMO_FUNDER_KEY);

export const NEAR_EXPLORER = NEAR_NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

/** The largest link this client will create outside demo mode, in USDC units (100 USDC). */
export const NEAR_MAX_LINK_UNITS = "100000000";

/** Where a NEAR link opens. A static segment beside the Stellar claim routes. */
export const NEAR_CLAIM_PATH = "/c/near";

/**
 * The origin a link is written with: the deployed site, so a link made on a preview or a laptop
 * still opens on the real domain; the page's own origin when no site URL is configured.
 */
export function nearLinkOrigin(): string {
  const site = trimmed(process.env.NEXT_PUBLIC_SITE_URL);
  if (site) {
    try {
      const u = new URL(site);
      if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
    } catch {
      /* not a URL: fall through to the page's own origin */
    }
  }
  return typeof window === "undefined" ? "https://getlumenia.com" : window.location.origin;
}

export function explorerTxUrl(hash: string, base = NEAR_EXPLORER): string {
  return `${base}/txns/${hash}`;
}

export function explorerAccountUrl(accountId: string, base = NEAR_EXPLORER): string {
  return `${base}/address/${accountId}`;
}
