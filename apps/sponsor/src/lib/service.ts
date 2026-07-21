/**
 * Shared service wiring used by BOTH adapters (the local node:http server and the
 * Vercel function handlers). Config + signer + Horizon are built once per instance
 * from the environment, so the two adapters never diverge.
 */
import type { Horizon } from "@stellar/stellar-sdk";
import { loadConfig, type SponsorConfig } from "./config.js";
import { signerFromSecret, type SponsorSigner } from "./signer.js";
import { horizon } from "./stellar.js";
import { checkRateLimitDurable, rateLimitConfigFromEnv, type RateLimitVerdict } from "./rate-limit.js";

export interface Service {
  config: SponsorConfig;
  signer: SponsorSigner;
  /** Test-USDC faucet signer — null when FAUCET_SECRET is unset (faucet disabled). */
  faucet: SponsorSigner | null;
  server: Horizon.Server;
}

let cached: Service | null = null;

export function getService(): Service {
  if (!cached) {
    const config = loadConfig();
    cached = {
      config,
      signer: signerFromSecret(config.sponsorSecret),
      faucet: config.faucetSecret ? signerFromSecret(config.faucetSecret) : null,
      server: horizon(config),
    };
  }
  return cached;
}

export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": process.env.ALLOWED_ORIGIN ?? "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
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
