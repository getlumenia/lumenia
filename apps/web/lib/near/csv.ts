// RFC 4180 CSV for the sender's bookkeeping export. CRLF line ends, fields quoted only when they
// contain a comma, a quote or a line break, quotes doubled. Free-text fields (memo, label) that
// start with a formula trigger are prefixed with an apostrophe so a spreadsheet shows them as text.

export const LINK_CSV_COLUMNS = [
  "created_at",
  "public_key",
  "amount_usdc",
  "memo",
  "expires_at",
  "status",
  "claimed_to",
  "create_tx_hash",
  "explorer_url",
  "label",
] as const;

export type LinkCsvColumn = (typeof LINK_CSV_COLUMNS)[number];
export type LinkCsvRow = Record<LinkCsvColumn, string>;

const FREE_TEXT: ReadonlySet<LinkCsvColumn> = new Set(["memo", "label"]);

export function csvField(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Same as csvField, with the spreadsheet formula guard for text typed by people. */
export function csvTextField(value: string | null | undefined): string {
  const s = value ?? "";
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return csvField(guarded);
}

export function csvLine(fields: ReadonlyArray<string | number | null | undefined>): string {
  return fields.map(csvField).join(",") + "\r\n";
}

export function linkCsvLine(row: LinkCsvRow): string {
  return LINK_CSV_COLUMNS.map((c) => (FREE_TEXT.has(c) ? csvTextField(row[c]) : csvField(row[c]))).join(",") + "\r\n";
}

export function linksCsv(rows: LinkCsvRow[]): string {
  return csvLine(LINK_CSV_COLUMNS) + rows.map(linkCsvLine).join("");
}

/** UTF-8 BOM so Excel detects the encoding; the body is plain RFC 4180. */
export const CSV_BOM = "﻿";
