/**
 * The public numbers and identifiers that more than one page prints: the mainnet pilot's figures,
 * the escrow contract id, the extension version, the group-link limits, the take-back window and
 * the public site. One module, so the pitch deck (/pitch), the hackathon deck (/pro-hackathon-deck)
 * and the event board (/event) cannot drift apart from each other or from the repository.
 *
 * Rules (CLAUDE.md): a transfer count never appears without its value; every figure here carries
 * the date it was measured and names where the truth lives. When the truth moves, change the
 * source first, then this file, then nothing else.
 *
 * Client components import this module. Keep it free of anything that would pull the Stellar SDK
 * into their bundles: lib/network.ts and lib/lumendrop.ts both import the SDK, lib/link-fragment.ts
 * imports nothing.
 */
import { MAX_POOL_SLOTS } from "./link-fragment";

/**
 * The public site. The QR code on the pitch deck is scanned off a projector or a printout, so it
 * points at production on purpose and not at NEXT_PUBLIC_SITE_URL (a preview deployment would
 * otherwise print its own host on the slide).
 */
export const PUBLIC_SITE = "https://getlumenia.com";
export const TRY_URL = `${PUBLIC_SITE}/try`;

/**
 * The mainnet escrow contract (LumenDrop v2), created 2026-07-26. Truth: apps/sponsor/wrangler.toml,
 * [env.mainnet.vars] LUMENDROP_CONTRACT, and the Vercel production variable
 * NEXT_PUBLIC_LUMENDROP_CONTRACT_MAINNET, which lib/network.ts reads and which is empty in a local
 * build; that is why the id is spelled out here. Copied 2026-11-10.
 */
export const MAINNET_ESCROW_CONTRACT = "CAC5JYQ2XEEVJ54EXC7KCG6MTARO5CSUQ2WNKSOM6FALCCU5UTEIWGR4";

/** "CAC5JYQ2...WGR4": the first eight and the last four characters, the way explorers abbreviate. */
export function shortId(id: string): string {
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}

/**
 * The browser extension's version. Truth: apps/extension/package.json "version", which
 * apps/extension/build.mjs stamps into both manifests at build time (the manifests on disk say
 * 0.0.0). Both stores listed 0.1.4 when last checked, 2026-11-08 (docs/PROJECT_STATE_2026-11-08.md,
 * section 4.5). Not imported from there: the web app's production build does not see files outside
 * apps/web (next.config.ts), so it is copied here by hand, 2026-11-10.
 */
export const EXTENSION_VERSION = "0.1.4";

/**
 * Group links: the most equal shares one link may hold. Testnet: MAX_POOL_SLOTS in
 * lib/link-fragment.ts, re-exported here. Mainnet: MAINNET_MAX_POOL_SLOTS in lib/lumendrop.ts (6),
 * which mirrors MAINNET_DEFAULT_POOL_SLOTS in apps/sponsor/src/lib/soroban-relay.ts, where the
 * Worker's MAX_POOL_SLOTS variable can only lower it (ceiling 8). Copied rather than imported
 * because lib/lumendrop.ts pulls the Stellar SDK into any bundle that imports it. 2026-11-10.
 */
export const GROUP_SHARES_TESTNET = MAX_POOL_SLOTS;
export const GROUP_SHARES_MAINNET = 6;

/**
 * The sender's take-back window in days. A v2 drop is created with expiry now + 7 days (the default
 * in lib/lumendrop.ts, createDrop) and the v1 Claimable Balance carries a 7-day sender-reclaim
 * claimant (README, decision 3). 2026-11-10.
 */
export const TAKE_BACK_DAYS = 7;

/**
 * The mainnet pilot: hand-approved wallets, July to August 2026, with no sponsor-paid transfer
 * since 2026-08-30. The count and the accounts come from the project's own records on 2026-08-28
 * (docs/SOW2.md section 5.2); the value, the median and the maximum from a Horizon recount on
 * 2026-09-06; the operation breakdown from the Horizon read of 2026-09-18 in
 * docs/HACKATHON_MAINNET_EVENT_CONFIG.md: 92 USDC-moving operations in sponsor-paid transactions,
 * of which 69 direct payments, 4 escrow deposits, 7 escrow payouts, 6 v1 claimable balances created
 * and 6 claimed; 65 of the 69 payments, $0.26 in all, came from one scripted run on 2026-08-24.
 * What the ledger shows after 2026-08-30 is inbound only (a top-up, dust and a few unsolicited
 * sub-cent claimable balances from outside accounts; docs/PROJECT_REVIEW_2026-10-20.md,
 * docs/PROJECT_STATE_2026-11-08.md section 4.2). Never print `transfers` without `totalUsd`.
 */
export const PILOT = {
  transfers: 109,
  transfersCountedOn: "28 Aug 2026",
  accountsOpened: 69,
  totalUsd: "about $4.40",
  medianUsd: "$0.002",
  maxUsd: "$1.00",
  valueRecountedOn: "6 Sept 2026",
  capPerLinkUsd: "$5",
  capPerDayUsd: "$50",
  lastTransfer: "30 Aug 2026",
  usdcOperations: 92,
  directPayments: 69,
  escrowOperations: 11,
  scriptedRunValueUsd: "$0.26",
} as const;
