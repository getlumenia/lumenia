/**
 * Shared service wiring used by BOTH adapters (the local node:http server and the
 * Vercel function handlers). Config + signer + Horizon are built once per instance
 * from the environment, so the two adapters never diverge.
 */
import type { Horizon } from "@stellar/stellar-sdk";
import { loadConfig, type SponsorConfig } from "./config.js";
import { signerFromSecret, type SponsorSigner } from "./signer.js";
import { kmsSignerFromEnv } from "./kms-signer.js";
import { horizon } from "./stellar.js";
import { ChannelManager } from "./channels.js";
import { checkRateLimitDurable, rateLimitConfigFromEnv, type RateLimitVerdict } from "./rate-limit.js";

/** Which signer the service was built with: the env hot key, or the AWS KMS raw-Ed25519 signer. */
export type SignerKind = "env" | "kms";

/**
 * Where `config.sponsorAccountId` came from: the `SPONSOR_ACCOUNT_ID` variable, or the signer's own
 * key (the env hot key's address, the shape both Workers ran before the KMS cutover). KMS mode is
 * only ever the first: without the variable it does not start.
 */
export type AccountSource = "SPONSOR_ACCOUNT_ID" | "signer";

export interface Service {
  config: SponsorConfig;
  signer: SponsorSigner;
  /** Reported on /health so an operator can see from outside which key is doing the signing. */
  signerKind: SignerKind;
  /** Reported on /health next to the account, so a forgotten SPONSOR_ACCOUNT_ID shows from outside. */
  accountSource: AccountSource;
  /** Test-USDC faucet signer — null when FAUCET_SECRET is unset (faucet disabled). */
  faucet: SponsorSigner | null;
  server: Horizon.Server;
  /** Channel-account pool (C1 fix). Disabled (enabled=false) when CHANNEL_SECRETS is unset. */
  channels: ChannelManager;
}

let cached: Service | null = null;
/** The KMS bootstrap in flight, so a burst of requests on a fresh isolate makes one GetPublicKey. */
let pending: Promise<Service> | null = null;

/**
 * Env-key mode only: an empty account id is filled from the env signer's own address, which is
 * the same key the id would have been derived from. KMS mode never comes here: its account is
 * `SPONSOR_ACCOUNT_ID` or the service does not start (`serviceConfigFromEnv`).
 */
export function withAccount(config: SponsorConfig, signer: SponsorSigner): SponsorConfig {
  if (config.sponsorAccountId) return config;
  return { ...config, sponsorAccountId: signer.publicKey() };
}

/**
 * The config, where its account came from, and whether this is KMS mode, built WITHOUT a signer and
 * without a single KMS call. Anything that needs only the account (the watchdog, a health read)
 * can use this and keep working while KMS is unreachable.
 *
 * KMS mode (`KMS_KEY_ID` set) REQUIRES `SPONSOR_ACCOUNT_ID` and throws without it. Each fallback is
 * the wrong account at some point of the cutover: while `SPONSOR_SECRET` is still a Worker secret
 * the id would be derived from it and look right on /health, and the moment the runbook deletes
 * that secret every new isolate would act as the KMS key's own, unfunded address, which anyone can
 * create on-ledger. A refusal at boot is visible at the first /health read instead.
 */
export function serviceConfigFromEnv(): { config: SponsorConfig; accountSource: AccountSource; kms: boolean } {
  const kms = Boolean(process.env.KMS_KEY_ID);
  const explicit = process.env.SPONSOR_ACCOUNT_ID;
  if (kms && !explicit) {
    throw new Error(
      "KMS_KEY_ID is set but SPONSOR_ACCOUNT_ID is not: in KMS mode the sponsor account must be named explicitly (the existing sponsor address)",
    );
  }
  const base = loadConfig(); // validates SPONSOR_ACCOUNT_ID's format when it is set
  if (kms) {
    // The hot secret may still be a Worker secret (runbook steps 4-6); nothing reads it in KMS mode.
    return { config: { ...base, sponsorSecret: "" }, accountSource: "SPONSOR_ACCOUNT_ID", kms };
  }
  return { config: base, accountSource: explicit ? "SPONSOR_ACCOUNT_ID" : "signer", kms };
}

/** The env hot-key service (the local node:http server, and the Worker while KMS is not configured). */
export function getService(): Service {
  if (!cached) {
    const { config: base, accountSource, kms } = serviceConfigFromEnv();
    if (kms) {
      // Signing through KMS is async; this sync path could only ever sign with the hot key.
      throw new Error("KMS_KEY_ID is set: the sponsor signs through KMS, which only getServiceAsync() builds");
    }
    const signer = signerFromSecret(base.sponsorSecret);
    const config = withAccount(base, signer);
    cached = {
      config,
      signer,
      signerKind: "env",
      accountSource,
      faucet: config.faucetSecret ? signerFromSecret(config.faucetSecret) : null,
      server: horizon(config),
      channels: new ChannelManager(config.channelSecrets),
    };
  }
  return cached;
}

/**
 * Async service bootstrap for the LIVE host (the Cloudflare Worker): when `KMS_KEY_ID` is set,
 * the sponsor signer is the AWS-KMS raw-Ed25519 signer (one GetPublicKey at boot, Sign-only
 * after) and the env hot-key is never constructed; otherwise identical to `getService()`.
 * Activating KMS is one on-chain SetOptions (cli/add-signer.ts adds the KMS key's address as a
 * signer of the existing account) plus config: KMS_KEY_ID, KMS_REGION, the AWS pair and
 * SPONSOR_ACCOUNT_ID. See ops/RUNBOOK_SPONSOR_KEY.md section 2.
 */
export async function getServiceAsync(): Promise<Service> {
  if (cached) return cached;
  // The config is checked before KMS is asked anything: a missing SPONSOR_ACCOUNT_ID costs no call.
  const { config, accountSource, kms: kmsMode } = serviceConfigFromEnv();
  if (!kmsMode) return getService();
  pending ??= (async () => {
    const kms = await kmsSignerFromEnv();
    if (!kms) throw new Error("KMS_KEY_ID is set but no KMS signer was built");
    cached = {
      config,
      signer: kms, // the env hot-key is never constructed in KMS mode
      signerKind: "kms",
      accountSource,
      faucet: config.faucetSecret ? signerFromSecret(config.faucetSecret) : null,
      server: horizon(config),
      channels: new ChannelManager(config.channelSecrets),
    };
    return cached;
  })().finally(() => {
    pending = null; // a failed bootstrap is retried by the next request, never cached
  });
  return pending;
}

/** Test seam: forget the built service so the next call reads the environment again. */
export function resetServiceCache(): void {
  cached = null;
  pending = null;
}

/**
 * CORS. `ALLOWED_ORIGIN` is set in both deployed environments, but the `*` fallback meant a deploy
 * that simply forgot the var would silently open every value route to any site on the internet —
 * a missing variable should not be a security decision. On mainnet the fallback is the app's own
 * origin instead of a wildcard; elsewhere `*` stays, because local dev and the CLI spikes call
 * these endpoints from arbitrary origins.
 *
 * `Vary: Origin` because this header depends on configuration a shared cache cannot see.
 */
export function corsHeaders(): Record<string, string> {
  const configured = process.env.ALLOWED_ORIGIN;
  const fallback = process.env.STELLAR_NETWORK === "mainnet" ? "https://getlumenia.com" : "*";
  return {
    "access-control-allow-origin": configured || fallback,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

/**
 * Minimal shape of Vercel's Node request/response (a subset of `@vercel/node`'s
 * VercelRequest/VercelResponse). Declared locally so the sponsor keeps no
 * platform-specific dependency — only these adapter files know about Vercel.
 */
export interface VercelReq {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Vercel parses the JSON body when content-type is application/json. */
  body?: unknown;
  /** Vercel's Node launcher (shouldAddHelpers) parses the query string. */
  query?: Record<string, string | string[] | undefined>;
}
export interface VercelRes {
  setHeader(key: string, value: string): void;
  status(code: number): VercelRes;
  json(body: unknown): void;
  end(): void;
}

export function applyCors(res: VercelRes): void {
  for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);
}

/** Parse a Vercel request body that may arrive pre-parsed or as a raw string. */
export function parseBody(body: unknown): Record<string, unknown> {
  if (body == null) return {};
  if (typeof body === "string") return body.length ? (JSON.parse(body) as Record<string, unknown>) : {};
  return body as Record<string, unknown>;
}

/** Best-effort client IP from proxy headers (Vercel/Node put it in x-forwarded-for). */
export function clientIpFrom(headers: Record<string, string | string[] | undefined>): string {
  const fwd = headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  if (raw && raw.length) return raw.split(",")[0]!.trim();
  return "unknown";
}

/**
 * Enforce per-IP + per-account rate limits (env-configured) for this request.
 * Durable (KV/Upstash) when the store env is set; in-memory otherwise.
 */
export function enforceRateLimit(ip: string, account?: string): Promise<RateLimitVerdict> {
  return checkRateLimitDurable(ip, account, rateLimitConfigFromEnv(), Date.now());
}
