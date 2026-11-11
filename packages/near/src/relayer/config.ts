// Configuration from environment variables (Worker vars or .env). No secrets
// are read here except the relayer key, which stays in memory.
import { DEFAULT_CAPS, type CapLimits } from "./caps.js";

export interface RelayerConfig {
  network: "testnet";
  rpcUrl: string;
  relayerAccountId: string;
  escrowId: string;
  usdcId: string;
  corsOrigin: string;
  caps: CapLimits;
}

export type EnvLike = Record<string, string | undefined>;

export const DEFAULTS = {
  NETWORK: "testnet",
  NEAR_RPC_URL: "https://test.rpc.fastnear.com",
  RELAYER_ACCOUNT_ID: "lumenia-relayer.testnet",
  ESCROW_ID: "lumenia-near.testnet",
  USDC_ID: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  CORS_ORIGIN: "*",
} as const;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function configFromEnv(env: EnvLike): RelayerConfig {
  const network = (env.NETWORK ?? DEFAULTS.NETWORK).trim();
  if (network !== "testnet") {
    throw new ConfigError(`NETWORK=${network} is refused: this relayer runs on testnet only`);
  }
  const rpcUrl = (env.NEAR_RPC_URL ?? DEFAULTS.NEAR_RPC_URL).trim();
  if (!/^https?:\/\//.test(rpcUrl)) throw new ConfigError("NEAR_RPC_URL must be an http(s) URL");
  const relayerAccountId = (env.RELAYER_ACCOUNT_ID ?? DEFAULTS.RELAYER_ACCOUNT_ID).trim();
  const escrowId = (env.ESCROW_ID ?? DEFAULTS.ESCROW_ID).trim();
  const usdcId = (env.USDC_ID ?? DEFAULTS.USDC_ID).trim();
  for (const [name, value] of [
    ["RELAYER_ACCOUNT_ID", relayerAccountId],
    ["ESCROW_ID", escrowId],
    ["USDC_ID", usdcId],
  ] as const) {
    if (!value) throw new ConfigError(`${name} is empty`);
  }
  if (escrowId === usdcId) throw new ConfigError("ESCROW_ID and USDC_ID must differ");
  return {
    network: "testnet",
    rpcUrl,
    relayerAccountId,
    escrowId,
    usdcId,
    corsOrigin: (env.CORS_ORIGIN ?? DEFAULTS.CORS_ORIGIN).trim() || "*",
    caps: {
      perSenderPerDay: intOr(env.MAX_RELAYS_PER_SENDER_PER_DAY, DEFAULT_CAPS.perSenderPerDay),
      globalPerDay: intOr(env.MAX_RELAYS_PER_DAY, DEFAULT_CAPS.globalPerDay),
      senderCooldownS: intOr(env.SENDER_COOLDOWN_S, DEFAULT_CAPS.senderCooldownS),
    },
  };
}

function intOr(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`expected a non-negative integer, got "${v}"`);
  return n;
}
