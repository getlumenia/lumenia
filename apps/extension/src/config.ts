/**
 * Build-time facts the extension runs on. Every value here is either a public endpoint or a rule the
 * sponsor enforces on its own side; the extension repeats a rule only to say it out loud BEFORE the
 * user signs, never as the gate itself.
 */
import { mainnetConfig, testnetConfig, type NetworkConfig, type NetworkId } from "./core";

declare const __EXT_VERSION__: string;
declare const __LINK_TTL_S__: number;

/** The extension's own version, from package.json at build time ("dev" under tsx). */
export const VERSION: string = typeof __EXT_VERSION__ === "string" ? __EXT_VERSION__ : "dev";

/** Where every link opens. The recipient's flow lives on the website and never changes. */
export const WEB_ORIGIN = "https://getlumenia.com";

/**
 * The public marker every link made here carries in its query (`&src=ext`), and the source the
 * usage counters are filed under. A label, not a proof: anyone can type it.
 */
export const SRC = "ext" as const;

/** Real money is a capped pilot: the mainnet sponsor's MAX_DROP_USDC and MAX_DAY_USDC (wrangler.toml). */
export const TX_CAP_USD = "5";
export const DAY_CAP_USD = "50";
/** The testnet sponsor's own per-link ceiling (MAX_DROP_USDC = 100). Practice money, but still a rule. */
export const TESTNET_MAX_USD = "100";
/** The escrow's floor (MIN_DROP_USDC on both Workers). */
export const MIN_USD = "0.01";

/**
 * How long a single link waits before its sender may take it back: seven days, the web's default.
 * Only the local end-to-end build (`node build.mjs --e2e-ttl=N`, written to dist/e2e-*, never zipped)
 * shortens it, so the take-back can be proven within one session.
 */
export const LINK_TTL_S: number = typeof __LINK_TTL_S__ === "number" && __LINK_TTL_S__ > 0 ? __LINK_TTL_S__ : 7 * 24 * 3600;

/**
 * The pilot answer is cached for a minute: the mainnet Worker meters /pilot-status in the SAME
 * per-account bucket as /v2-deposit (5 a minute), so a popup that asked on every open could 429
 * its own send.
 */
export const PILOT_CACHE_MS = 60_000;

export const AUTOLOCK_CHOICES = [5, 15, 60] as const;
export type AutolockMin = (typeof AUTOLOCK_CHOICES)[number];
export const DEFAULT_AUTOLOCK_MIN: AutolockMin = 15;

/** How long a "paste it into the box I right-clicked" request stays valid. */
export const PENDING_INSERT_MS = 10 * 60_000;

/**
 * The only hosts the extension talks to: the two sponsor Workers and Stellar's public Horizon and
 * RPC on each network. Must equal host_permissions in both manifests (build.mjs refuses a drift).
 * Firefox lets the user withhold host permissions, so the popup asks for exactly these.
 */
export const API_HOSTS = [
  "https://lumenia-sponsor.avakit.workers.dev/*",
  "https://lumenia-sponsor-mainnet.avakit.workers.dev/*",
  "https://horizon-testnet.stellar.org/*",
  "https://horizon.stellar.org/*",
  "https://soroban-testnet.stellar.org/*",
  "https://mainnet.sorobanrpc.com/*",
] as const;

export const URLS = {
  /**
   * Where a password backup is made. The plan said /settings, but the backup form lives on /account
   * (apps/web/app/(app)/settings/page.tsx sends people there: "Looking for your balance or your
   * backup?"), so the extension points straight at it.
   */
  backup: `${WEB_ORIGIN}/account`,
  settings: `${WEB_ORIGIN}/settings`,
  pilot: `${WEB_ORIGIN}/pilot`,
  privacy: `${WEB_ORIGIN}/privacy`,
} as const;

/** The network a stored choice names. Mainnet is configured at build time; a missing one throws. */
export function netConfig(id: NetworkId): NetworkConfig {
  if (id === "public") {
    const m = mainnetConfig();
    if (!m) throw new Error("real money is not configured in this build");
    return m;
  }
  return testnetConfig();
}
