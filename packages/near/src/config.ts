// Configuration comes from the environment only. The funder's private key is
// read at the moment a transaction needs signing, from FUNDER_PRIVATE_KEY or
// from a near-cli legacy keychain file, and is never written anywhere.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatUsdc, parseUsdcAmount } from "./amount.js";
import { ed25519KeyBytes } from "./base58.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const DEFAULTS = {
  network: "testnet",
  rpcUrl: "https://rpc.testnet.near.org",
  contractId: "lumenia-near.testnet",
  usdcContractId: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  funderAccountId: "lumenia-funder.testnet",
  webOrigin: "http://localhost:5173",
  dailyBudgetUsdc: "50",
  maxLinkUsdc: "20",
  oneClickUrl: "https://1click.chaindefuser.com",
  explorerUrl: "https://testnet.nearblocks.io",
} as const;

export interface LumeniaConfig {
  network: "testnet";
  rpcUrls: string[];
  contractId: string;
  usdcContractId: string;
  funderAccountId: string;
  funderPrivateKey: string | null;
  funderKeyFile: string;
  webOrigin: string;
  dailyBudgetUnits: bigint;
  maxLinkUnits: bigint;
  dataDir: string;
  oneClickUrl: string;
  explorerUrl: string;
}

export type Env = Record<string, string | undefined>;

const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function accountId(name: string, value: string): string {
  const v = value.trim();
  if (v.length < 2 || v.length > 64 || !ACCOUNT_ID_RE.test(v)) {
    throw new ConfigError(`${name}="${v}" is not a valid NEAR account id`);
  }
  return v;
}

function usdcSetting(name: string, value: string): bigint {
  try {
    return parseUsdcAmount(value);
  } catch (e) {
    throw new ConfigError(`${name}="${value}": ${(e as Error).message}`);
  }
}

export function loadConfig(env: Env = process.env): LumeniaConfig {
  const network = (env.NEAR_NETWORK ?? DEFAULTS.network).trim();
  if (network !== "testnet") {
    throw new ConfigError(
      `NEAR_NETWORK="${network}" is not supported: this build is testnet-only and refuses to run against mainnet.`,
    );
  }
  const rpcUrls = (env.NEAR_RPC_URL ?? DEFAULTS.rpcUrl)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (rpcUrls.length === 0) throw new ConfigError("NEAR_RPC_URL is empty");
  for (const u of rpcUrls) {
    if (!/^https?:\/\//.test(u)) throw new ConfigError(`NEAR_RPC_URL entry "${u}" must be an http(s) URL`);
  }
  const funderAccountId = accountId("FUNDER_ACCOUNT_ID", env.FUNDER_ACCOUNT_ID ?? DEFAULTS.funderAccountId);
  const funderPrivateKey = env.FUNDER_PRIVATE_KEY?.trim() || null;
  const funderKeyFile = expandHome(
    env.FUNDER_KEY_FILE?.trim() || join(homedir(), ".near-credentials", network, `${funderAccountId}.json`),
  );
  const webOrigin = (env.WEB_ORIGIN ?? DEFAULTS.webOrigin).trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(webOrigin)) {
    throw new ConfigError(`WEB_ORIGIN="${webOrigin}" must be an origin like https://example.com (no path)`);
  }
  return {
    network: "testnet",
    rpcUrls,
    contractId: accountId("LUMENIA_CONTRACT_ID", env.LUMENIA_CONTRACT_ID ?? DEFAULTS.contractId),
    usdcContractId: accountId("USDC_CONTRACT_ID", env.USDC_CONTRACT_ID ?? DEFAULTS.usdcContractId),
    funderAccountId,
    funderPrivateKey,
    funderKeyFile,
    webOrigin,
    dailyBudgetUnits: usdcSetting("DAILY_BUDGET_USDC", env.DAILY_BUDGET_USDC ?? DEFAULTS.dailyBudgetUsdc),
    maxLinkUnits: usdcSetting("MAX_LINK_USDC", env.MAX_LINK_USDC ?? DEFAULTS.maxLinkUsdc),
    dataDir: expandHome(env.LUMENIA_DATA_DIR?.trim() || join(homedir(), ".lumenia-near")),
    oneClickUrl: (env.ONECLICK_URL ?? DEFAULTS.oneClickUrl).trim().replace(/\/+$/, ""),
    explorerUrl: DEFAULTS.explorerUrl,
  };
}

function validateSecret(secret: string, source: string): string {
  const s = secret.trim();
  if (ed25519KeyBytes(s) !== 64) {
    throw new ConfigError(`${source} does not hold an ed25519 secret key in near-api-js text form (ed25519:<base58>)`);
  }
  return s;
}

/** Resolve the funder's secret key: env var first, then the keychain file. Throws before anything is signed. */
export function resolveFunderKey(config: LumeniaConfig): string {
  if (config.funderPrivateKey) return validateSecret(config.funderPrivateKey, "FUNDER_PRIVATE_KEY");
  if (!existsSync(config.funderKeyFile)) {
    throw new ConfigError(
      `No funder key: set FUNDER_PRIVATE_KEY, or point FUNDER_KEY_FILE at a near-cli keychain JSON ` +
        `(looked for ${config.funderKeyFile}). Nothing was spent.`,
    );
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(config.funderKeyFile, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`${config.funderKeyFile} is not valid JSON: ${(e as Error).message}`);
  }
  const secret = json.private_key ?? json.secret_key;
  if (typeof secret !== "string") throw new ConfigError(`${config.funderKeyFile} has no "private_key" field`);
  if (typeof json.account_id === "string" && json.account_id !== config.funderAccountId) {
    throw new ConfigError(`${config.funderKeyFile} belongs to ${json.account_id}, not FUNDER_ACCOUNT_ID=${config.funderAccountId}`);
  }
  return validateSecret(secret, config.funderKeyFile);
}

/** The effective configuration with no secret in it, for logs and the CLI. */
export function describeConfig(config: LumeniaConfig): Record<string, unknown> {
  return {
    network: config.network,
    rpcUrls: config.rpcUrls,
    contractId: config.contractId,
    usdcContractId: config.usdcContractId,
    funderAccountId: config.funderAccountId,
    funderKey: config.funderPrivateKey ? "FUNDER_PRIVATE_KEY (env)" : `file ${config.funderKeyFile}${existsSync(config.funderKeyFile) ? "" : " (missing)"}`,
    webOrigin: config.webOrigin,
    dailyBudgetUsdc: formatUsdc(config.dailyBudgetUnits),
    maxLinkUsdc: formatUsdc(config.maxLinkUnits),
    dataDir: config.dataDir,
    oneClickUrl: config.oneClickUrl,
    explorerUrl: config.explorerUrl,
  };
}
