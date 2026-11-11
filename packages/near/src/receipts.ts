// One receipt per payment. The receipt is written BEFORE the escrow deposit is
// broadcast (status Submitting) and updated after, so a crash in between never
// loses the link. The local status vocabulary:
//   Submitting  deposit not yet confirmed (local only)
//   Failed      deposit refused or never broadcast, nothing moved (local only)
//   Open        escrowed, claimable until expires_at
//   Expired     escrowed, past expires_at, the funder can reclaim
//   Claiming    a claim is in flight on chain
//   Claimed to <account>
//   Reclaimed   the funder took the USDC back
//   NotFound    the contract has no record for this public key
import { formatUsdc } from "./amount.js";

export const RECEIPT_CSV_COLUMNS = [
  "receipt_id",
  "created_at",
  "amount_usdc",
  "memo",
  "label",
  "batch_id",
  "link_public_key",
  "funder_account",
  "create_tx_hash",
  "explorer_url",
  "expires_at",
  "status",
  "claimed_to",
  "claim_tx_hash",
  "reclaim_tx_hash",
  "updated_at",
] as const;

export interface Receipt {
  receipt_id: string;
  created_at: string;
  amount_usdc: string;
  amount_units: string;
  memo: string;
  /** Who the payout is for, in the sender's words (batch payouts); null for a single link. */
  label: string | null;
  /** Shared by every receipt funded in the same ft_transfer_call; null for a single link. */
  batch_id: string | null;
  reference: string | null;
  link_public_key: string;
  funder_account: string;
  create_tx_hash: string | null;
  explorer_url: string | null;
  expires_at: string;
  status: string;
  claimed_to: string | null;
  claim_tx_hash: string | null;
  reclaim_tx_hash: string | null;
  updated_at: string;
  error: string | null;
  network: "testnet";
  /** The secret link. Kept in the local store so the agent can re-send it; never exported to CSV. */
  link?: string;
}

export type PublicReceipt = Omit<Receipt, "link">;

export type DropKind = "NotFound" | "Open" | "Expired" | "Claiming" | "Claimed" | "Reclaimed" | "Other";

export interface DropStatus {
  kind: DropKind;
  /** The receipt status string, e.g. "Claimed to alice.testnet". */
  label: string;
  amountUsdc: string | null;
  funder: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  claimedTo: string | null;
  memo: string | null;
  raw: unknown;
}

/** Nanosecond timestamps come back as JSON numbers or strings depending on the contract's serde types. */
export function nsToIso(ns: string | number | bigint): string {
  const big = typeof ns === "bigint" ? ns : BigInt(typeof ns === "number" ? Math.trunc(ns) : ns.trim());
  return new Date(Number(big / 1_000_000n)).toISOString();
}

function statusName(status: unknown): string {
  if (typeof status === "string") return status;
  if (status && typeof status === "object") {
    const keys = Object.keys(status as Record<string, unknown>);
    if (keys.length === 1 && keys[0]) return keys[0];
  }
  return String(status);
}

/** Map a get_drop view result (null when unknown) onto the receipt vocabulary. */
export function mapDrop(drop: unknown, now: Date): DropStatus {
  if (drop === null || drop === undefined) {
    return {
      kind: "NotFound",
      label: "NotFound",
      amountUsdc: null,
      funder: null,
      createdAt: null,
      expiresAt: null,
      claimedTo: null,
      memo: null,
      raw: drop ?? null,
    };
  }
  const d = drop as Record<string, unknown>;
  const name = statusName(d.status);
  const claimedTo = typeof d.claimed_to === "string" && d.claimed_to.length > 0 ? d.claimed_to : null;
  const expiresAt = d.expires_at_ns !== undefined && d.expires_at_ns !== null ? nsToIso(d.expires_at_ns as string | number) : null;
  const createdAt = d.created_at_ns !== undefined && d.created_at_ns !== null ? nsToIso(d.created_at_ns as string | number) : null;
  const amountUsdc = d.amount !== undefined && d.amount !== null ? formatUsdc(String(d.amount)) : null;
  const memo = typeof d.memo === "string" ? d.memo : null;
  const funder = typeof d.funder === "string" ? d.funder : null;
  const base = { amountUsdc, funder, createdAt, expiresAt, claimedTo, memo, raw: drop };
  switch (name) {
    case "Open": {
      const expired = expiresAt !== null && Date.parse(expiresAt) <= now.getTime();
      return expired ? { kind: "Expired", label: "Expired", ...base } : { kind: "Open", label: "Open", ...base };
    }
    case "Claiming":
      return { kind: "Claiming", label: "Claiming", ...base };
    case "Claimed":
      return { kind: "Claimed", label: claimedTo ? `Claimed to ${claimedTo}` : "Claimed", ...base };
    case "Reclaimed":
      return { kind: "Reclaimed", label: "Reclaimed", ...base };
    default:
      return { kind: "Other", label: name, ...base };
  }
}

export function publicReceipt(r: Receipt): PublicReceipt {
  const { link: _link, ...rest } = r;
  return rest;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with the fixed column order above; the secret link is never included. */
export function receiptsToCsv(receipts: readonly Receipt[]): string {
  const lines = [RECEIPT_CSV_COLUMNS.join(",")];
  for (const r of receipts) {
    lines.push(RECEIPT_CSV_COLUMNS.map((c) => csvCell((r as unknown as Record<string, unknown>)[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
