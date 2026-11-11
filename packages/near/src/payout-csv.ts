// Rows for `lumenia pay-many --file`: label,amount[,memo] per line, RFC 4180
// quoting, an optional header line and #-comments. Pure, no I/O.
export class PayoutCsvError extends Error {
  override name = "PayoutCsvError";
}

export interface PayoutRow {
  label: string;
  amountUsdc: string;
  memo: string;
}

export function parsePayoutCsv(text: string): PayoutRow[] {
  const rows: PayoutRow[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    const cells = splitCsvLine(line).map((c) => c.trim());
    const [label = "", amount = "", memo = ""] = cells;
    if (rows.length === 0 && label.toLowerCase() === "label" && amount.toLowerCase().startsWith("amount")) return;
    if (!label || !amount) throw new PayoutCsvError(`line ${i + 1} needs at least label,amount: "${line}"`);
    if (cells.length > 3) throw new PayoutCsvError(`line ${i + 1} has ${cells.length} columns; expected label,amount[,memo] (quote a memo that contains commas)`);
    rows.push({ label, amountUsdc: amount, memo });
  });
  if (rows.length === 0) throw new PayoutCsvError("the CSV has no payout rows");
  return rows;
}

export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (quoted) throw new PayoutCsvError(`unterminated quote in: "${line}"`);
  cells.push(cell);
  return cells;
}
