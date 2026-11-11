import { describe, expect, it } from "vitest";
import { parsePayoutCsv, PayoutCsvError, splitCsvLine } from "../src/payout-csv.js";

describe("parsePayoutCsv", () => {
  it("reads label,amount[,memo] rows, skipping a header, blanks and comments", () => {
    const rows = parsePayoutCsv('label,amount,memo\n# payroll\nAli,2.50,rent\n\nBea,0.10\n"Can, courier",1,"said ""thanks"""\r\n');
    expect(rows).toEqual([
      { label: "Ali", amountUsdc: "2.50", memo: "rent" },
      { label: "Bea", amountUsdc: "0.10", memo: "" },
      { label: "Can, courier", amountUsdc: "1", memo: 'said "thanks"' },
    ]);
  });

  it("does not treat a first data row that merely starts with 'label' as a header", () => {
    expect(parsePayoutCsv("labelmaker,1\n")).toEqual([{ label: "labelmaker", amountUsdc: "1", memo: "" }]);
  });

  it("rejects short rows, too many columns, unterminated quotes and empty files", () => {
    expect(() => parsePayoutCsv("Ali\n")).toThrow(PayoutCsvError);
    expect(() => parsePayoutCsv("Ali,1,memo,extra\n")).toThrow(/4 columns/);
    expect(() => parsePayoutCsv('"Ali,1\n')).toThrow(/unterminated/);
    expect(() => parsePayoutCsv("# nothing\n\n")).toThrow(/no payout rows/);
    expect(splitCsvLine("a,,c")).toEqual(["a", "", "c"]);
  });
});
