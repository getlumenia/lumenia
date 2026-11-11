// One ft_transfer_call can fund up to 30 drops at once. The contract reads
// msg = {"drops":[{"public_key","amount","memo"}...],"expires_in_s":N}, insists
// that the amounts sum EXACTLY to the transferred amount and that each is at
// least 0.10 USDC, and refunds everything on any failure (no records are kept).
// This module builds and checks that message; it never touches the network.
import { formatUsdc } from "./amount.js";

export const MAX_BATCH_DROPS = 30;
export const MIN_BATCH_DROP_UNITS = 100_000n; // 0.10 USDC
export const MIN_EXPIRES_IN_S = 60;
export const MAX_EXPIRES_IN_S = 604_800;
export const MAX_BATCH_MEMO_CHARS = 64;

export class BatchError extends Error {
  override name = "BatchError";
}

export interface BatchDropInput {
  publicKey: string;
  amountUnits: bigint;
  memo: string;
}

export interface BatchDropMsg {
  public_key: string;
  amount: string;
  memo: string;
}

export interface BatchMsg {
  drops: BatchDropMsg[];
  expires_in_s: number;
}

/** Build the batch msg and the exact total the funder must transfer with it. */
export function buildBatchMsg(drops: readonly BatchDropInput[], expiresInS: number): { msg: BatchMsg; totalUnits: bigint } {
  if (!Array.isArray(drops) || drops.length < 1) throw new BatchError("a batch needs at least one payout");
  if (drops.length > MAX_BATCH_DROPS) {
    throw new BatchError(`a batch holds at most ${MAX_BATCH_DROPS} payouts, got ${drops.length}`);
  }
  if (!Number.isInteger(expiresInS) || expiresInS < MIN_EXPIRES_IN_S || expiresInS > MAX_EXPIRES_IN_S) {
    throw new BatchError(`expires_in_s must be a whole number between ${MIN_EXPIRES_IN_S} and ${MAX_EXPIRES_IN_S}, got ${String(expiresInS)}`);
  }
  const seen = new Set<string>();
  let totalUnits = 0n;
  const out: BatchDropMsg[] = drops.map((d, i) => {
    if (typeof d.amountUnits !== "bigint" || d.amountUnits < MIN_BATCH_DROP_UNITS) {
      throw new BatchError(
        `payout ${i + 1} is ${typeof d.amountUnits === "bigint" ? formatUsdc(d.amountUnits) : String(d.amountUnits)} USDC; ` +
          `each payout in a batch must be at least ${formatUsdc(MIN_BATCH_DROP_UNITS)} USDC`,
      );
    }
    if (!d.publicKey.startsWith("ed25519:")) throw new BatchError(`payout ${i + 1} has no ed25519 public key`);
    if (seen.has(d.publicKey)) throw new BatchError(`payout ${i + 1} repeats the public key of an earlier payout`);
    seen.add(d.publicKey);
    if (typeof d.memo !== "string" || d.memo.length > MAX_BATCH_MEMO_CHARS) {
      throw new BatchError(`payout ${i + 1} memo must be a string of at most ${MAX_BATCH_MEMO_CHARS} characters`);
    }
    totalUnits += d.amountUnits;
    return { public_key: d.publicKey, amount: d.amountUnits.toString(), memo: d.memo };
  });
  return { msg: { drops: out, expires_in_s: expiresInS }, totalUnits };
}

/** The sum the contract will check against the transferred amount. */
export function batchTotal(msg: BatchMsg): bigint {
  return msg.drops.reduce((sum, d) => sum + BigInt(d.amount), 0n);
}
