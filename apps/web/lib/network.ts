/**
 * Network selection for the v2 (LumenDrop) money path.
 *
 * The app is a TESTNET product. A small number of MAINNET links exist as evidence that the flow
 * works with real money, so a single deployment has to serve both — a claim link carries its own
 * network in the URL (`?n=public`), which also makes a mainnet link visibly different from a
 * testnet one rather than something you have to take on trust.
 *
 * Testnet is the default everywhere. Nothing here touches the frozen v1 claim route (`/c/[id]`),
 * which stays testnet-only.
 */
import { Networks } from "@stellar/stellar-sdk";

export type NetworkId = "testnet" | "public";

export interface NetworkConfig {
  id: NetworkId;
  passphrase: string;
  horizonUrl: string;
  rpcUrl: string;
  /** The LumenDrop escrow that receives NEW deposits on this network. */
  contract: string;
  /** Superseded escrows, read + exit only (a drop is released only by the contract holding it). */
  legacyContracts: string[];
  /** The sponsor service that relays and pays fees for this network. */
  sponsorUrl: string;
  isMainnet: boolean;
}

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const TESTNET: NetworkConfig = {
  id: "testnet",
  passphrase: Networks.TESTNET,
  horizonUrl: process.env.NEXT_PUBLIC_HORIZON ?? "https://horizon-testnet.stellar.org",
  rpcUrl: process.env.NEXT_PUBLIC_SOROBAN_RPC ?? "https://soroban-testnet.stellar.org",
  contract:
    process.env.NEXT_PUBLIC_LUMENDROP_CONTRACT ?? "CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S",
  legacyContracts: list(
    process.env.NEXT_PUBLIC_LUMENDROP_LEGACY ??
      "CDYEDHBPMDOOZSJGB2Z6JVK7GS3S5CWNXNGTEPMJFS25TAWSYHTXA2RF,CAKEJAGCATVMJB6CMB6LM736DHUJ37YOTOER23SWRNDHPLTU2ZJUDIAB",
  ),
  sponsorUrl: process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev",
  isMainnet: false,
};

/**
 * Mainnet is only usable once its env vars are set; until then `MAINNET.contract` is empty and
 * `resolveNetwork` refuses to hand back a half-configured network rather than silently sending a
 * user at the wrong chain.
 */
const MAINNET: NetworkConfig = {
  id: "public",
  passphrase: Networks.PUBLIC,
  horizonUrl: process.env.NEXT_PUBLIC_HORIZON_MAINNET ?? "https://horizon.stellar.org",
  rpcUrl: process.env.NEXT_PUBLIC_SOROBAN_RPC_MAINNET ?? "https://mainnet.sorobanrpc.com",
  contract: process.env.NEXT_PUBLIC_LUMENDROP_CONTRACT_MAINNET ?? "",
  legacyContracts: list(process.env.NEXT_PUBLIC_LUMENDROP_LEGACY_MAINNET),
  sponsorUrl: process.env.NEXT_PUBLIC_SPONSOR_URL_MAINNET ?? "",
  isMainnet: true,
};

/** The USDC each network escrows: Circle's on mainnet, our own test asset on testnet. */
export const USDC_ISSUER: Record<NetworkId, string> = {
  testnet: "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC",
  public: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

/**
 * Resolve a link's network. Anything other than an explicit, fully-configured `public` falls back
 * to testnet — a misconfigured mainnet must never degrade into "quietly use the wrong chain".
 */
export function resolveNetwork(param?: string | null): NetworkConfig {
  if (param !== "public") return TESTNET;
  if (!MAINNET.contract || !MAINNET.sponsorUrl) {
    throw new Error("this link is a mainnet link, but mainnet is not configured in this deployment");
  }
  return MAINNET;
}

/** Is a mainnet link servable by this deployment at all? (for UI that wants to hide/label it) */
export const MAINNET_CONFIGURED = Boolean(MAINNET.contract && MAINNET.sponsorUrl);

/** The mainnet config IF this deployment is configured for it, else null (used to ask "am I approved?"). */
export function mainnetConfig(): NetworkConfig | null {
  return MAINNET_CONFIGURED ? MAINNET : null;
}

/**
 * The network the v1 CLASSIC value path (link-send / claim / sweep / cash-out) and the
 * home/stats ledger reads operate on for THIS deployment. Testnet by default; a mainnet
 * deployment sets `NEXT_PUBLIC_STELLAR_NETWORK=mainnet`. This is a build-wide choice, not a
 * per-link one — unlike the v2 (LumenDrop) claim route, which carries its network in the URL
 * (`?n=public`) and resolves it with `resolveNetwork`. Value libs read `ACTIVE.horizonUrl` /
 * `ACTIVE.passphrase` from here instead of hardcoding testnet.
 */
export const ACTIVE: NetworkConfig =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet" ? MAINNET : TESTNET;

const NETWORK_KEY = "lumenia.network";

/**
 * The network the classic value path uses RIGHT NOW on THIS device. The product is testnet for
 * everyone by default; a whitelisted user the owner has approved may switch to mainnet. This
 * client flag only decides which network the UI builds and signs for — the real gate is the
 * sponsor's pilot allowlist, so a user who flips this by hand still cannot move mainnet money
 * without an approval. Server-side reads (e.g. /stats) fall back to the build-time ACTIVE.
 */
export function activeNetwork(): NetworkConfig {
  if (typeof window === "undefined") return ACTIVE;
  try {
    if (window.localStorage.getItem(NETWORK_KEY) === "public" && MAINNET_CONFIGURED) return MAINNET;
  } catch {
    /* storage blocked — stay on the safe testnet default */
  }
  return TESTNET;
}

/** Switch this device's active network. Mainnet only sticks if this deployment is configured for it. */
export function setActiveNetwork(id: NetworkId): void {
  try {
    if (id === "public" && !MAINNET_CONFIGURED) return;
    window.localStorage.setItem(NETWORK_KEY, id);
  } catch {
    /* storage blocked — no-op */
  }
}

/** stellar.expert transaction link on the active network. */
export function explorerTx(hash: string): string {
  return `https://stellar.expert/explorer/${activeNetwork().id}/tx/${hash}`;
}

/** stellar.expert account link on the active network. */
export function explorerAccount(address: string): string {
  return `https://stellar.expert/explorer/${activeNetwork().id}/account/${address}`;
}
