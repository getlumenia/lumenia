/**
 * KmsSponsorSigner — the sponsor's Ed25519 key held in AWS KMS, never in the Worker env.
 *
 * Mechanics (proven by Spike #1b with a Node-crypto stand-in): KMS raw-signs the 32-byte
 * Stellar tx hash with pure Ed25519 (`ECC_NIST_EDWARDS25519` key, `ED25519_SHA_512` +
 * `MessageType=RAW` — the PH/prehash variant would produce signatures Stellar rejects) and
 * returns a raw 64-byte signature; we wrap it as a `DecoratedSignature` whose hint is the
 * LAST 4 BYTES of the raw public key. `GetPublicKey` returns a 44-byte DER SPKI (RFC 8410,
 * prefix `302a300506032b6570032100`) — the raw 32-byte key is its tail.
 *
 * Transport: aws4fetch (SigV4 over SubtleCrypto) straight to the KMS JSON API —
 * `@aws-sdk/client-kms` breaks on workerd (fs config loading, DOMParser), aws4fetch is the
 * Cloudflare-documented path. FAIL CLOSED: any KMS error throws, and there is deliberately NO
 * fallback to an env hot-key. The Worker answers that throw as HTTP 400: redacted to
 * "request failed" plus a log reference on mainnet, verbatim on testnet. "Verbatim" is why the
 * thrown message carries only the operation, the HTTP status and the AWS error type: a KMS error
 * body names the IAM principal and the key ARN, which is the AWS account id, so the body goes to
 * the Worker's own log and never into an answer. Each call is bounded too (one retry, one
 * deadline): aws4fetch retries ten times by default, about 25 s for a call that keeps failing,
 * and every fresh isolate makes one GetPublicKey before it can answer anything at all.
 *
 * NOT live yet: activation is a HUMAN step (ops/RUNBOOK_SPONSOR_KEY.md section 2): the key and
 * its least-privilege policy, ONE on-chain SetOptions that adds the key's address as a signer of
 * the EXISTING sponsor account (cli/add-signer.ts), and the Worker config (the key id, the AWS
 * pair, SPONSOR_ACCOUNT_ID). This module is code-complete and unit-tested against a local
 * raw-Ed25519 stand-in and a stubbed KMS endpoint (test-kms-signer.ts).
 */
import { AwsClient } from "aws4fetch";
import { StrKey, xdr, type Transaction, type FeeBumpTransaction } from "@stellar/stellar-sdk";
import type { SponsorSigner } from "./signer.js";

/** The two KMS operations the sponsor's IAM identity is allowed (plus DescribeKey). */
type KmsTarget = "TrentService.Sign" | "TrentService.GetPublicKey";

/** A SigV4-signed POST to the KMS JSON API. Injectable so tests can fake the wire. */
export type KmsFetch = (target: KmsTarget, body: Record<string, unknown>) => Promise<Record<string, unknown>>;

const ED25519_SPKI_PREFIX = "302a300506032b6570032100";

export interface KmsSignerOptions {
  keyId: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Test seam — replaces the real SigV4 transport. */
  kmsFetch?: KmsFetch;
  /** Retries after a 5xx or 429 (aws4fetch's own loop). Default KMS_RETRIES. */
  retries?: number;
  /** One deadline per KMS call, its retry included. Default KMS_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * At most one retry. aws4fetch defaults to ten, with a random backoff of up to 50 * 2^i ms, so a
 * call that keeps failing (a KMS outage, a throttled key) held the request for about 25 s on
 * average and up to about 51 s. One retry still absorbs a single transient 5xx.
 */
export const KMS_RETRIES = 1;

/**
 * The deadline for one KMS call, retry included. Sign and GetPublicKey answer in tens of
 * milliseconds, so a call this slow is an outage, and the request it holds is a person waiting on
 * a claim. /send-link signs twice, so its worst case is twice this.
 */
export const KMS_TIMEOUT_MS = 5_000;

/**
 * The error type of an AWS JSON 1.1 error, reduced the way the protocol tells clients to
 * (smithy.io, AWS JSON 1.1, "Operation error serialization"): the type travels in the
 * `X-Amzn-Errortype` header or the body's `__type` (or `code`); keep only what is before the first
 * ':' and then only what is after the first '#'. Anything that is still not a plain identifier
 * comes back as "unknown", so nothing else from the body can ride along into an error message.
 */
export function kmsErrorType(header: string | null, body: string): string {
  let raw = header ?? "";
  if (!raw) {
    try {
      const parsed = JSON.parse(body) as { __type?: unknown; code?: unknown };
      if (typeof parsed.__type === "string") raw = parsed.__type;
      else if (typeof parsed.code === "string") raw = parsed.code;
    } catch {
      /* not JSON: no type to report */
    }
  }
  const colon = raw.indexOf(":");
  if (colon >= 0) raw = raw.slice(0, colon);
  const hash = raw.indexOf("#");
  if (hash >= 0) raw = raw.slice(hash + 1);
  return /^[A-Za-z][A-Za-z0-9_.]{0,99}$/.test(raw) ? raw : "unknown";
}

/**
 * Run one KMS call under a deadline. The abort reaches the request itself (aws4fetch builds a
 * Request from this init, and `signal` is part of RequestInit); the race is what bounds the wait
 * for the caller even if a runtime were to ignore the abort.
 */
async function withDeadline<T>(target: KmsTarget, ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`KMS ${target} failed: no answer within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work(ctrl.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function realKmsFetch(opts: KmsSignerOptions): KmsFetch {
  const aws = new AwsClient({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    region: opts.region,
    service: "kms",
    retries: opts.retries ?? KMS_RETRIES,
  });
  const endpoint = `https://kms.${opts.region}.amazonaws.com/`;
  const timeoutMs = opts.timeoutMs ?? KMS_TIMEOUT_MS;
  return (target, body) =>
    withDeadline(target, timeoutMs, async (signal) => {
      let res: Response;
      try {
        res = await aws.fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": target },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        // A transport failure (DNS, a reset): the detail is for the log only. An abort is the
        // deadline above, which has already answered the caller with its own message.
        if (!signal.aborted) console.error(`[kms] ${target}: transport error: ${(e as Error).message}`);
        throw new Error(`KMS ${target} failed: network error`);
      }
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        // Fail closed with the KMS error TYPE surfaced (DisabledException, AccessDeniedException,
        // KMSInvalidStateException: the incident signal) and the body kept in the Worker's log.
        const type = kmsErrorType(res.headers.get("x-amzn-errortype"), text);
        console.error(`[kms] ${target}: HTTP ${res.status} ${type}: ${text.slice(0, 500)}`);
        throw new Error(`KMS ${target} failed: HTTP ${res.status} ${type}`);
      }
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(`KMS ${target} failed: unreadable response (HTTP ${res.status})`);
      }
    });
}

export class KmsSponsorSigner implements SponsorSigner {
  private constructor(
    private readonly keyId: string,
    private readonly region: string,
    private readonly kms: KmsFetch,
    private readonly rawPub: Buffer,
  ) {}

  /** What an operator may know about this signer: the key's ARN and Region (no credential), and its address. */
  describe(): { keyId: string; region: string; publicKey: string } {
    return { keyId: this.keyId, region: this.region, publicKey: this.publicKey() };
  }

  /** One `GetPublicKey` at boot pins the account address; everything after is Sign-only. */
  static async create(opts: KmsSignerOptions): Promise<KmsSponsorSigner> {
    const kms = opts.kmsFetch ?? realKmsFetch(opts);
    const res = await kms("TrentService.GetPublicKey", { KeyId: opts.keyId });
    const der = Buffer.from(String(res.PublicKey ?? ""), "base64");
    if (der.length !== 44 || !der.subarray(0, 12).equals(Buffer.from(ED25519_SPKI_PREFIX, "hex"))) {
      // The key id names the AWS account, and this message can reach a caller (verbatim on testnet):
      // it stays in the log, as the AWS error bodies do.
      console.error(`[kms] the configured key ${opts.keyId} is not an Ed25519 key (${der.length} bytes)`);
      throw new Error(`the configured KMS key is not an Ed25519 key (want a 44-byte RFC 8410 SPKI, got ${der.length} bytes)`);
    }
    return new KmsSponsorSigner(opts.keyId, opts.region, kms, der.subarray(12));
  }

  publicKey(): string {
    return StrKey.encodeEd25519PublicKey(this.rawPub);
  }

  async sign(tx: Transaction | FeeBumpTransaction): Promise<void> {
    const hash = tx.hash(); // 32-byte tx hash — the exact bytes Stellar verifies
    const res = await this.kms("TrentService.Sign", {
      KeyId: this.keyId,
      Message: Buffer.from(hash).toString("base64"),
      MessageType: "RAW",
      SigningAlgorithm: "ED25519_SHA_512",
    });
    const sig = Buffer.from(String(res.Signature ?? ""), "base64");
    if (sig.length !== 64) throw new Error(`KMS returned a ${sig.length}-byte signature (want 64)`);
    tx.signatures.push(
      new xdr.DecoratedSignature({ hint: this.rawPub.subarray(28), signature: sig }),
    );
  }
}

/**
 * Env-driven factory. Returns null when KMS is not configured (the service then falls back to
 * the env hot-key signer — the explicit testnet default, never a silent runtime fallback).
 *
 * The Worker needs, per network: `KMS_KEY_ID` (the key ARN), `AWS_ACCESS_KEY_ID` and
 * `AWS_SECRET_ACCESS_KEY` as secrets (`wrangler secret put`; the ARN is not a credential, but it
 * names the AWS account, and wrangler.toml is public), `KMS_REGION` as a plain var, and a long-term
 * IAM user key (aws4fetch here sends no session token). `SPONSOR_ACCOUNT_ID` names the EXISTING
 * sponsor account the KMS key was added to as a signer (lib/config.ts). It is REQUIRED in KMS mode:
 * lib/service.ts refuses to start without it, because every fallback it could take (the hot
 * secret's address, the KMS key's own unfunded address) is the wrong account sooner or later.
 *
 * `kmsFetch` is a test seam only: the Worker never passes one.
 */
export async function kmsSignerFromEnv(kmsFetch?: KmsFetch): Promise<KmsSponsorSigner | null> {
  const keyId = process.env.KMS_KEY_ID;
  if (!keyId) return null;
  const region = process.env.KMS_REGION ?? process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error("KMS_KEY_ID is set but KMS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are not");
  }
  return KmsSponsorSigner.create({ keyId, region, accessKeyId, secretAccessKey, kmsFetch });
}
