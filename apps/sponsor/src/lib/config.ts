/**
 * Sponsor service configuration.
 *
 * The sponsor is a SEPARATE service holding a hot Ed25519 signing key (its own
 * env/IAM boundary — never a Next API route). For the Instawards testnet sprint
 * the signer is an env hot-key; a KMS raw-signer drops in behind the same
 * `SponsorSigner` seam (see lib/signer.ts, proven mechanically by Spike #1b).
 */
import { Asset, Keypair, Networks, StrKey } from "@stellar/stellar-sdk";

export type StellarNetwork = "testnet" | "mainnet";

/**
 * The USDC each network uses, in ONE place.
 *
 * These were pasted as literals into thirteen files, which is how a repoint becomes a half-day of
 * grep instead of a one-line change. The live services read `USDC_ISSUER` from the environment;
 * these constants are the default and the value every operator script and spike should import
 * rather than restate.
 *
 * TESTNET moved on 2026-09-06 from the project's own practice issuer (GDO7HI2W…) to **Circle's own
 * testnet USDC** (home_domain centre.io, verified on Horizon: auth_revocable true, clawback
 * disabled, the same posture as the mainnet asset). The reason is interoperability: the Turkish
 * sandbox ramp used at the September 2026 hackathon settles this asset and no other, so a dollar
 * from that anchor could not travel through a Lumenia link while the two sides named different
 * assets. Circle's faucet also becomes a valid funding source. (That ramp integration was removed
 * on 2026-10-03. The asset stays: it is also the USDC that Circle CCTP mints here.)
 *
 * Anything holding the old asset keeps working: the superseded escrow stays in
 * LUMENDROP_LEGACY_CONTRACTS, which is exit-only by design.
 */
export const USDC_ISSUERS: Record<StellarNetwork, string> = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

/** The superseded practice asset. Kept named so old testnet records stay readable. */
export const LEGACY_TESTNET_USDC_ISSUER = "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC";

export interface SponsorConfig {
  network: StellarNetwork;
  networkPassphrase: string;
  horizonUrl: string;
  /** Hot sponsor secret (S...). KMS key id replaces this later — see lib/signer.ts. */
  sponsorSecret: string;
  /**
   * The sponsor ACCOUNT (G...): the address that sources operations, pays fee-bumps and owns the
   * sponsored reserves. It is NOT necessarily the signing key's address. Before the KMS cutover the
   * two were the same thing, and every handler read `signer.publicKey()` for both, so moving the
   * signer into KMS would have made the Worker act as a brand-new, unfunded account. Now the KMS
   * public key is ADDED as a signer (weight 1) on the EXISTING sponsor account, this field names
   * that account, and signing is whatever `SponsorSigner` is wired. `SPONSOR_ACCOUNT_ID` in the
   * environment sets it; unset, it defaults to the signer's own address (the pre-cutover shape).
   */
  sponsorAccountId: string;
  /**
   * Test-USDC faucet secret (S...) — a SEPARATE key from the sponsor (two blast
   * radii). Optional: if unset, the /faucet endpoint is disabled. Testnet only.
   */
  faucetSecret?: string;
  /** The one USDC asset the sponsor will open a trustline to. */
  usdc: Asset;
  /**
   * Channel-account pool secrets (S…, comma-separated in CHANNEL_SECRETS). Each is a
   * sponsor-controlled account that LENDS its sequence number to a concurrent onboarding
   * so the sponsor's single sequence no longer serializes claims (C1 fix). Empty ⇒ the
   * pool is disabled and the sponsor-sourced path is used (backward compatible).
   */
  channelSecrets: string[];
  /** Hard cap (stroops) on the fee the sponsor will pay for a single fee-bump. */
  feeBumpMaxStroops: string;
  /** Soroban RPC url (v2 relayer). */
  sorobanRpcUrl: string;
  /** The deployed v2 LumenDrop escrow contract id (C...). Unset = the v2 relayer is disabled. */
  lumendropContract?: string;
  /**
   * SUPERSEDED LumenDrop contract ids that still hold live drops. New escrow NEVER goes here —
   * these are relayed for EXITS ONLY (claim / claim_share / reclaim / reclaim_pool) so links
   * already in the wild keep working after a contract upgrade. Both are our own contracts and
   * both enforce the same in-contract signature check, so widening the exit allowlist to them
   * grants the relayer no new power.
   */
  lumendropLegacyContracts: string[];
  port: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

export function passphraseFor(network: StellarNetwork): string {
  return network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

export function defaultHorizon(network: StellarNetwork): string {
  return network === "mainnet" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";
}

export function defaultSorobanRpc(network: StellarNetwork): string {
  return network === "mainnet" ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org";
}

/** Parse a comma/whitespace-separated list of channel secrets (empty ⇒ []). */
export function parseChannelSecrets(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Build a config from explicit parts (used by the CLI when bootstrapping a demo). */
export function makeConfig(parts: {
  network: StellarNetwork;
  sponsorSecret: string;
  /** The sponsor account (G...). Defaults to the address of `sponsorSecret` when that is set. */
  sponsorAccountId?: string;
  faucetSecret?: string;
  usdcIssuer: string;
  usdcCode?: string;
  horizonUrl?: string;
  feeBumpMaxStroops?: string;
  sorobanRpcUrl?: string;
  lumendropContract?: string;
  lumendropLegacyContracts?: string[];
  channelSecrets?: string[];
  port?: number;
}): SponsorConfig {
  const network = parts.network;
  return {
    network,
    networkPassphrase: passphraseFor(network),
    horizonUrl: parts.horizonUrl ?? defaultHorizon(network),
    sponsorSecret: parts.sponsorSecret,
    sponsorAccountId: resolveSponsorAccountId(parts.sponsorAccountId, parts.sponsorSecret),
    faucetSecret: parts.faucetSecret,
    usdc: new Asset(parts.usdcCode ?? "USDC", parts.usdcIssuer),
    feeBumpMaxStroops: parts.feeBumpMaxStroops ?? "10000", // 0.001 XLM per tx
    sorobanRpcUrl: parts.sorobanRpcUrl ?? defaultSorobanRpc(network),
    lumendropContract: parts.lumendropContract,
    lumendropLegacyContracts: parts.lumendropLegacyContracts ?? [],
    channelSecrets: parts.channelSecrets ?? [],
    port: parts.port ?? 8787,
  };
}

/**
 * The sponsor account id: the explicit one when given (it must be a valid G... address, because a
 * typo here would source every operation from an account that does not exist), otherwise the
 * address of the hot secret, otherwise empty: the service fills an empty id from the live signer
 * (lib/service.ts), which is the only place a KMS-derived address is known.
 */
export function resolveSponsorAccountId(explicit: string | undefined, sponsorSecret: string | undefined): string {
  if (explicit) {
    if (!StrKey.isValidEd25519PublicKey(explicit)) {
      throw new Error("SPONSOR_ACCOUNT_ID must be a valid Stellar account address (G...)");
    }
    return explicit;
  }
  if (sponsorSecret) {
    try {
      return Keypair.fromSecret(sponsorSecret).publicKey();
    } catch {
      /* an unparseable secret fails later, at the signer, with its own message */
    }
  }
  return "";
}

/** Parse a comma/whitespace-separated list of contract ids (empty ⇒ []). */
export function parseContractList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Load config from the environment (used by the deployed HTTP service). */
export function loadConfig(): SponsorConfig {
  const network = (process.env.STELLAR_NETWORK as StellarNetwork) ?? "testnet";
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`STELLAR_NETWORK must be 'testnet' or 'mainnet', got '${network}'`);
  }
  return makeConfig({
    network,
    // In KMS mode (KMS_KEY_ID set) the sponsor signs via AWS KMS and no hot secret exists —
    // see lib/kms-signer.ts + service.getServiceAsync(). Otherwise the env hot-key is required.
    sponsorSecret: process.env.KMS_KEY_ID ? (process.env.SPONSOR_SECRET ?? "") : required("SPONSOR_SECRET"),
    sponsorAccountId: process.env.SPONSOR_ACCOUNT_ID,
    faucetSecret: process.env.FAUCET_SECRET,
    usdcIssuer: required("USDC_ISSUER"),
    usdcCode: process.env.USDC_CODE,
    horizonUrl: process.env.HORIZON_URL,
    feeBumpMaxStroops: process.env.FEE_BUMP_MAX_STROOPS,
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL,
    lumendropContract: process.env.LUMENDROP_CONTRACT,
    lumendropLegacyContracts: parseContractList(process.env.LUMENDROP_LEGACY_CONTRACTS),
    channelSecrets: parseChannelSecrets(process.env.CHANNEL_SECRETS),
    port: process.env.PORT ? Number.parseInt(process.env.PORT, 10) : undefined,
  });
}
