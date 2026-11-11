// "Pay it forward": a claimed account creates a new link from its own USDC without holding NEAR.
// The account signs a NEP-366 delegate with its full-access key; the relayer pays the gas.
// Pure orchestration with injected effects so the order of operations can be tested:
// the link record and its secret are written to storage BEFORE anything is built, signed or sent.

import { RelayRequestError, type RelayOk } from "@lumenia/near/relayer/client";
import { buildDropMsg } from "./drops";
import type { LinkKey } from "./keys";
import type { StoredLink } from "./store";

/** The relayer's policy accepts link lives from 1 hour to 7 days (seconds). */
export const RELAYER_MIN_EXPIRY_S = 3600;
export const RELAYER_MAX_EXPIRY_S = 604_800;

export interface PayForwardInput {
  senderId: string;
  amountUnits: string;
  memo: string;
  expiresInS: number;
  network: string;
  usdcId: string;
  escrowId: string;
}

export interface PayForwardDeps {
  newKey(): LinkKey;
  /** Keeps the record AND the secret. May be async (the secret goes to IndexedDB); it is awaited before anything is signed. */
  saveLink(link: StoredLink): void | Promise<unknown>;
  updateLink(patch: Partial<StoredLink> & { publicKey: string }): void;
  buildDelegate(args: { senderId: string; usdcId: string; escrowId: string; amountUnits: string; msg: string }): Promise<{ base64: string }>;
  relay(base64: string): Promise<RelayOk>;
  now(): number;
}

export type PayForwardResult =
  | { created: true; link: StoredLink; txHash: string; explorerUrl: string; outcome: RelayOk["outcome"] }
  | { created: false; link: StoredLink; txHash: string; explorerUrl: string; outcome: RelayOk["outcome"]; reason: string };

export function isRelayerExpiry(seconds: number): boolean {
  return seconds >= RELAYER_MIN_EXPIRY_S && seconds <= RELAYER_MAX_EXPIRY_S;
}

/** Reads the relayer's outcome: did the escrow keep the USDC and open the link? */
export function interpretOutcome(outcome: RelayOk["outcome"], amountUnits: string): { created: boolean; reason: string } {
  const refused = outcome.logs.find((l) => /refused:/.test(l))?.replace(/; tokens returned$/, "");
  if (outcome.status !== "success") {
    return { created: false, reason: outcome.failures[0] ?? outcome.summary ?? "the transaction failed" };
  }
  if (outcome.linkCreated === false) return { created: false, reason: refused ?? outcome.summary ?? "the escrow returned the USDC" };
  if (outcome.usedAmount !== undefined && outcome.usedAmount !== amountUnits) {
    return { created: false, reason: refused ?? `the escrow kept ${outcome.usedAmount} of ${amountUnits} units; the rest was returned` };
  }
  return { created: true, reason: "" };
}

export async function runPayForward(input: PayForwardInput, deps: PayForwardDeps): Promise<PayForwardResult> {
  if (!isRelayerExpiry(input.expiresInS)) {
    throw new Error(`the relayer accepts link lives from ${RELAYER_MIN_EXPIRY_S / 3600} hour to ${RELAYER_MAX_EXPIRY_S / 86_400} days`);
  }
  const key = deps.newKey();
  const link: StoredLink = {
    publicKey: key.publicKey,
    secret: key.secret,
    amountUnits: input.amountUnits,
    memo: input.memo.trim(),
    expiresInS: input.expiresInS,
    createdAt: new Date(deps.now()).toISOString(),
    funder: input.senderId,
    network: input.network,
    relayed: true,
  };
  // 1. The record and the secret exist before any signature or network call.
  await deps.saveLink(link);
  // 2. Sign the delegate with the account's own key.
  const built = await deps.buildDelegate({
    senderId: input.senderId,
    usdcId: input.usdcId,
    escrowId: input.escrowId,
    amountUnits: input.amountUnits,
    msg: buildDropMsg(key.publicKey, input.expiresInS, input.memo),
  });
  // 3. The relayer pays and sends.
  const result = await deps.relay(built.base64);
  deps.updateLink({ publicKey: link.publicKey, createTxHash: result.txHash, relayerExplorerUrl: result.explorerUrl });
  const verdict = interpretOutcome(result.outcome, input.amountUnits);
  if (!verdict.created) {
    deps.updateLink({ publicKey: link.publicKey, createError: verdict.reason });
    return { created: false, link, txHash: result.txHash, explorerUrl: result.explorerUrl, outcome: result.outcome, reason: verdict.reason };
  }
  return { created: true, link: { ...link, createTxHash: result.txHash }, txHash: result.txHash, explorerUrl: result.explorerUrl, outcome: result.outcome };
}

/** One honest sentence for whatever the relayer call threw. */
export function describeRelayError(e: unknown): string {
  if (e instanceof RelayRequestError) {
    if (e.status === 429) {
      const wait = e.retryAfterS !== undefined ? ` Try again in ${e.retryAfterS} s.` : " Try again in a moment.";
      return `The relayer is at its limit (${e.code}).${wait}`;
    }
    if (e.status === 403) return `The relayer refused this request: ${e.reason}`;
    if (e.status === 400) return `The relayer did not understand the request: ${e.reason}`;
    if (e.status >= 500) return `The relayer had trouble (HTTP ${e.status}, ${e.code}): ${e.reason}`;
    return `The relayer answered ${e.status} (${e.code}): ${e.reason}`;
  }
  if (e instanceof Error) {
    if (/failed to fetch|networkerror|load failed/i.test(e.message)) return `Could not reach the relayer (${e.message}).`;
    return e.message;
  }
  return String(e);
}
