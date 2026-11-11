// The public ledger: every drop the contract knows, newest first, paged, amounts and account ids
// only. Memos belong to the people involved, so a memo is shown only for drops this browser made.

import type { DropStatus, DropView } from "./drops";

export const LEDGER_PAGE_SIZE = 25;
export const LEDGER_MAX_LIMIT = 100;

export interface LedgerPage {
  from_index: number;
  limit: number;
  page: number;
  pages: number;
  hasNewer: boolean;
  hasOlder: boolean;
}

/** Page `page` (0 = newest) of `total` drops for get_drops, which lists newest first. */
export function ledgerPage(total: number, page: number, pageSize = LEDGER_PAGE_SIZE): LedgerPage {
  const size = Math.max(1, Math.min(pageSize, LEDGER_MAX_LIMIT));
  const pages = Math.max(1, Math.ceil(Math.max(0, total) / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return {
    from_index: p * size,
    limit: size,
    page: p,
    pages,
    hasNewer: p > 0,
    hasOlder: p < pages - 1,
  };
}

/** "alice.testnet" stays; a 64-hex implicit id becomes "4430f5be...85e9c8". */
export function shortAccount(id: string | null | undefined): string {
  if (!id) return "";
  if (/^[0-9a-f]{64}$/.test(id)) return `${id.slice(0, 8)}...${id.slice(-6)}`;
  if (id.length > 28) return `${id.slice(0, 14)}...${id.slice(-10)}`;
  return id;
}

export interface LedgerRow {
  publicKey: string;
  status: DropStatus;
  amountUnits: string;
  funder: string;
  funderShort: string;
  claimedTo: string | null;
  claimedToShort: string;
  createdAtNs: string;
  expiresAtNs: string;
  /** true when this browser created the drop; only then is the memo shown */
  mine: boolean;
  memo: string | null;
  createTxHash: string | null;
}

export interface LocalDropInfo {
  createTxHash?: string;
}

/** Maps contract rows to display rows, attaching local knowledge and hiding other people's memos. */
export function toLedgerRows(rows: ReadonlyArray<DropView>, mine: ReadonlyMap<string, LocalDropInfo>): LedgerRow[] {
  return rows.map((d) => {
    const key = d.public_key ?? "";
    const local = mine.get(key);
    return {
      publicKey: key,
      status: d.status,
      amountUnits: d.amount,
      funder: d.funder,
      funderShort: shortAccount(d.funder),
      claimedTo: d.claimed_to,
      claimedToShort: shortAccount(d.claimed_to),
      createdAtNs: String(d.created_at_ns),
      expiresAtNs: String(d.expires_at_ns),
      mine: local !== undefined,
      memo: local !== undefined ? d.memo : null,
      createTxHash: local?.createTxHash ?? null,
    };
  });
}
