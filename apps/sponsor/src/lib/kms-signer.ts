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
 * Cloudflare-documented path. FAIL CLOSED: any KMS error throws (the caller 5xxes); there is
 * deliberately NO fallback to an env hot-key.
 *
 * NOT live yet: provisioning the key + least-privilege key policy + Worker env is a HUMAN
 * step (ops/RUNBOOK_SPONSOR_KEY.md §2). This module is code-complete + unit-tested against a
 * local raw-Ed25519 stand-in (test-kms-signer.ts) so the human step is config-only.
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
}

function realKmsFetch(opts: KmsSignerOptions): KmsFetch {
  const aws = new AwsClient({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    region: opts.region,
    service: "kms",
  });
  const endpoint = `https://kms.${opts.region}.amazonaws.com/`;
  return async (target, body) => {
    const res = await aws.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": target },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Fail closed with the KMS error type surfaced (DisabledException etc. = incident signal).
      const text = await res.text().catch(() => "");
      throw new Error(`KMS ${target} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  };
}

export class KmsSponsorSigner implements SponsorSigner {
  private constructor(
    private readonly keyId: string,
    private readonly kms: KmsFetch,
    private readonly rawPub: Buffer,
  ) {}

  /** One `GetPublicKey` at boot pins the account address; everything after is Sign-only. */
  static async create(opts: KmsSignerOptions): Promise<KmsSponsorSigner> {
    const kms = opts.kmsFetch ?? realKmsFetch(opts);
    const res = await kms("TrentService.GetPublicKey", { KeyId: opts.keyId });
    const der = Buffer.from(String(res.PublicKey ?? ""), "base64");
    if (der.length !== 44 || !der.subarray(0, 12).equals(Buffer.from(ED25519_SPKI_PREFIX, "hex"))) {
      throw new Error(
        `KMS key ${opts.keyId} is not an Ed25519 key (want 44-byte RFC 8410 SPKI, got ${der.length} bytes)`,
      );
    }
    return new KmsSponsorSigner(opts.keyId, kms, der.subarray(12));
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
 */
export async function kmsSignerFromEnv(): Promise<KmsSponsorSigner | null> {
  const keyId = process.env.KMS_KEY_ID;
  if (!keyId) return null;
  const region = process.env.KMS_REGION ?? process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error("KMS_KEY_ID is set but KMS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are not");
  }
  return KmsSponsorSigner.create({ keyId, region, accessKeyId, secretAccessKey });
}
