// "Send to many": one ft_transfer_call creates up to 30 drops. The msg is
// {"drops":[{"public_key","amount","memo"?}...],"expires_in_s":N}; the item amounts (6-dp units)
// must sum EXACTLY to the transferred amount and each must be at least the contract's min_amount.

import { parseUsdcAmount, formatUsdc } from "./amount";
import { MAX_MEMO_BYTES, memoBytes } from "./drops";

export const MAX_BATCH_DROPS = 30;
/** The contract's default min_amount (0.10 USDC); the live value comes from get_config. */
export const DEFAULT_MIN_AMOUNT_UNITS = "100000";

export interface BatchRow {
  line: number;
  label: string;
  amountUnits: string;
  memo: string;
}

export interface BatchRowError {
  line: number;
  reason: string;
}

export interface ParsedBatch {
  rows: BatchRow[];
  errors: BatchRowError[];
  totalUnits: string;
}

/** Splits one CSV-ish line on commas, honouring double quotes ("a, b" stays one field). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/**
 * Rows are `label, amount[, memo]`, one per line; blank lines and a header line starting with
 * "label" are skipped. Every problem is reported with its line number; nothing is guessed.
 */
export function parseBatchRows(text: string, opts: { minUnits?: string; maxUnitsPerRow?: string } = {}): ParsedBatch {
  const minUnits = BigInt(opts.minUnits ?? DEFAULT_MIN_AMOUNT_UNITS);
  const rows: BatchRow[] = [];
  const errors: BatchRowError[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === "") return;
    const fields = splitCsvLine(raw);
    if (i === 0 && /^label$/i.test(fields[0] ?? "") && /^amount/i.test(fields[1] ?? "")) return;
    const [label = "", amountText = "", ...rest] = fields;
    const memo = rest.join(", ").trim();
    if (label === "") {
      errors.push({ line, reason: "missing label" });
      return;
    }
    if (amountText === "") {
      errors.push({ line, reason: "missing amount" });
      return;
    }
    const parsed = parseUsdcAmount(amountText, { maxUnits: opts.maxUnitsPerRow });
    if (!parsed.ok) {
      errors.push({ line, reason: parsed.reason });
      return;
    }
    if (BigInt(parsed.units) < minUnits) {
      errors.push({ line, reason: `amount is below the minimum of ${formatUsdc(minUnits)} USDC` });
      return;
    }
    if (memoBytes(memo) > MAX_MEMO_BYTES) {
      errors.push({ line, reason: `memo is longer than ${MAX_MEMO_BYTES} bytes` });
      return;
    }
    rows.push({ line, label, amountUnits: parsed.units, memo });
  });
  if (rows.length > MAX_BATCH_DROPS) {
    errors.push({ line: 0, reason: `at most ${MAX_BATCH_DROPS} rows per batch (got ${rows.length})` });
  }
  if (rows.length === 0 && errors.length === 0) errors.push({ line: 0, reason: "no rows" });
  return { rows, errors, totalUnits: batchTotal(rows.map((r) => r.amountUnits)) };
}

export function batchTotal(units: ReadonlyArray<string>): string {
  return units.reduce((acc, u) => acc + BigInt(u), 0n).toString();
}

export interface BatchDrop {
  publicKey: string;
  amountUnits: string;
  memo?: string;
}

/**
 * The ft_transfer_call msg for a batch. Throws unless 1..30 items, each at or above `minUnits`,
 * and the sum equals `transferUnits` exactly (the contract refunds everything otherwise).
 */
export function buildBatchMsg(drops: ReadonlyArray<BatchDrop>, expiresInS: number, transferUnits: string, minUnits = DEFAULT_MIN_AMOUNT_UNITS): string {
  if (drops.length < 1) throw new Error("a batch needs at least one drop");
  if (drops.length > MAX_BATCH_DROPS) throw new Error(`a batch holds at most ${MAX_BATCH_DROPS} drops`);
  const min = BigInt(minUnits);
  const seen = new Set<string>();
  for (const d of drops) {
    if (!/^\d+$/.test(d.amountUnits)) throw new Error(`amount ${d.amountUnits} is not a unit string`);
    if (BigInt(d.amountUnits) < min) throw new Error(`amount ${d.amountUnits} is below min_amount ${minUnits}`);
    if (seen.has(d.publicKey)) throw new Error(`public key ${d.publicKey} appears twice`);
    seen.add(d.publicKey);
  }
  const total = batchTotal(drops.map((d) => d.amountUnits));
  if (total !== transferUnits) throw new Error(`drop amounts sum to ${total}, not the transferred ${transferUnits}`);
  const items = drops.map((d) => {
    const item: { public_key: string; amount: string; memo?: string } = { public_key: d.publicKey, amount: d.amountUnits };
    const m = d.memo?.trim();
    if (m) item.memo = m;
    return item;
  });
  return JSON.stringify({ drops: items, expires_in_s: expiresInS });
}
