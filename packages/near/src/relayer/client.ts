// Browser-usable helper for the web app (import it by relative path). It only
// depends on near-api-js and the Fetch API: no Node modules, no other files.
//
//   const built = await buildSignedDelegateForPayForward({ senderId, senderKeyPair, usdcId, escrowId, amountUnits, msg, provider });
//   const result = await relay(relayerUrl, built.base64);
//
// The sender signs a NEP-366 DelegateAction (one ft_transfer_call into the
// escrow with 1 yoctoNEAR and 100 Tgas); the relayer wraps it and pays. The
// sender's key must be a full-access key on an existing account (a claim
// creates exactly that), with no NEAR needed.
import {
  KeyPair,
  KeyPairSigner,
  actions,
  base64Encode,
  buildDelegateAction,
  encodeSignedDelegate,
  teraToGas,
  type Action,
  type KeyPairString,
  type Provider,
} from "near-api-js";

export type LinkMsg =
  | { public_key: string; expires_in_s: number; memo?: string }
  | { drops: Array<string | { public_key: string; amount?: string; memo?: string }>; expires_in_s: number; memo?: string };

export interface BuildSignedDelegateCommon {
  /** The paying-forward account (it must exist on chain). */
  senderId: string;
  /** Its full-access key: a KeyPair or the "ed25519:..." secret string. */
  senderKeyPair: KeyPair | KeyPairString;
  /** Any near-api-js Provider (JsonRpcProvider, FailoverRpcProvider). */
  provider: Provider;
  /** Blocks of validity from the current height (the relayer accepts at most 600). Default 300. */
  blockHeightTtl?: number;
  /** Gas attached to the call, in Tgas (the relayer accepts at most 100). Default 100. */
  gasTgas?: number;
}

export interface BuildPayForwardArgs extends BuildSignedDelegateCommon {
  usdcId: string;
  escrowId: string;
  /** USDC units (6 decimals): 100000 is 0.10 USDC. */
  amountUnits: bigint | string | number;
  /** The link message, as an object or already-serialized JSON. */
  msg: LinkMsg | string;
}

export interface BuildReclaimArgs extends BuildSignedDelegateCommon {
  escrowId: string;
  /** The link key ("ed25519:...") of the expired drop to take back. */
  linkPublicKey: string;
}

export interface BuiltSignedDelegate {
  /** What POST /relay wants: {signedDelegate: base64}. */
  base64: string;
  bytes: Uint8Array;
  senderId: string;
  receiverId: string;
  method: string;
  publicKey: string;
  nonce: bigint;
  maxBlockHeight: bigint;
  delegateHash: Uint8Array;
}

export async function buildSignedDelegateForPayForward(a: BuildPayForwardArgs): Promise<BuiltSignedDelegate> {
  const amount = BigInt(a.amountUnits);
  if (amount <= 0n) throw new Error("amountUnits must be positive");
  const msg = typeof a.msg === "string" ? a.msg : JSON.stringify(a.msg);
  const args = { receiver_id: a.escrowId, amount: amount.toString(), msg };
  const action = actions.functionCall("ft_transfer_call", args, teraToGas(a.gasTgas ?? 100), 1n);
  return buildAndSign(a, a.usdcId, "ft_transfer_call", action);
}

export async function buildSignedDelegateForReclaim(a: BuildReclaimArgs): Promise<BuiltSignedDelegate> {
  if (!a.linkPublicKey.startsWith("ed25519:")) throw new Error('linkPublicKey must start with "ed25519:"');
  const action = actions.functionCall("reclaim", { public_key: a.linkPublicKey }, teraToGas(a.gasTgas ?? 100), 0n);
  return buildAndSign(a, a.escrowId, "reclaim", action);
}

async function buildAndSign(
  a: BuildSignedDelegateCommon,
  receiverId: string,
  method: string,
  action: Action,
): Promise<BuiltSignedDelegate> {
  const keyPair = typeof a.senderKeyPair === "string" ? KeyPair.fromString(a.senderKeyPair) : a.senderKeyPair;
  const publicKey = keyPair.getPublicKey();
  const ttl = a.blockHeightTtl ?? 300;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 600) throw new Error("blockHeightTtl must be 1..600 blocks");
  const [accessKey, block] = await Promise.all([
    a.provider.viewAccessKey({ accountId: a.senderId, publicKey, finalityQuery: { finality: "final" } }),
    a.provider.viewBlock({ finality: "final" }),
  ]);
  const nonce = BigInt(String(accessKey.nonce)) + 1n;
  const maxBlockHeight = BigInt(block.header.height) + BigInt(ttl);
  const delegateAction = buildDelegateAction({
    senderId: a.senderId,
    receiverId,
    actions: [action],
    nonce,
    maxBlockHeight,
    publicKey,
  });
  const signer = new KeyPairSigner(keyPair);
  const { signedDelegate, delegateHash } = await signer.signDelegateAction(delegateAction);
  const bytes = encodeSignedDelegate(signedDelegate);
  return {
    base64: base64Encode(bytes),
    bytes,
    senderId: a.senderId,
    receiverId,
    method,
    publicKey: publicKey.toString(),
    nonce,
    maxBlockHeight,
    delegateHash,
  };
}

// ---------------------------------------------------------------------------
// Talking to the relayer
// ---------------------------------------------------------------------------

export interface RelayOk {
  txHash: string;
  explorerUrl: string;
  outcome: {
    status: "success" | "failure";
    kind: "create_link" | "reclaim";
    summary: string;
    linkCreated?: boolean;
    usedAmount?: string;
    reclaimed?: boolean;
    failures: string[];
    events: unknown[];
    logs: string[];
    finalStatus: unknown;
  };
}

/** Thrown by relay() for any non-2xx answer: 403 refused by policy, 429 capped, 400 bad input, 5xx relayer trouble. */
export class RelayRequestError extends Error {
  override name = "RelayRequestError";
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
    readonly retryAfterS?: number,
  ) {
    super(`relayer answered ${status} (${code}): ${reason}`);
  }
}

export async function relay(
  relayerUrl: string,
  signedDelegateBase64: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayOk> {
  const base = relayerUrl.replace(/\/+$/, "");
  const url = base.endsWith("/relay") ? base : `${base}/relay`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedDelegate: signedDelegateBase64 }),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const b = (body ?? {}) as { reason?: unknown; code?: unknown; retryAfterS?: unknown };
    throw new RelayRequestError(
      response.status,
      typeof b.code === "string" ? b.code : "http_error",
      typeof b.reason === "string" ? b.reason : text || response.statusText,
      typeof b.retryAfterS === "number" ? b.retryAfterS : undefined,
    );
  }
  return body as RelayOk;
}
