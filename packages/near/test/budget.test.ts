import { describe, expect, it } from "vitest";
import { BUDGET_WINDOW_MS, checkBudget, spentInWindow } from "../src/budget.js";

const now = new Date("2026-11-11T12:00:00.000Z");
const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
const r = (msAgo: number, units: number, status = "Open") => ({ created_at: at(msAgo), amount_units: String(units), status });

describe("spentInWindow", () => {
  it("sums the trailing 24 hours and ignores older, failed and future-dated rows", () => {
    const receipts = [
      r(1_000, 1_000_000),
      r(60 * 60_000, 2_500_000, "Claimed to a.testnet"),
      r(23 * 3_600_000, 500_000, "Reclaimed"),
      r(BUDGET_WINDOW_MS + 1, 9_000_000),
      r(5_000, 7_000_000, "Failed"),
      r(-2 * 3_600_000, 3_000_000),
    ];
    expect(spentInWindow(receipts, now)).toBe(4_000_000n);
  });
});

describe("checkBudget", () => {
  const base = { now, dailyBudgetUnits: 50_000_000n, maxLinkUnits: 20_000_000n };

  it("allows a payment that fits", () => {
    const c = checkBudget({ ...base, amountUnits: 20_000_000n, receipts: [r(1, 30_000_000)] });
    expect(c.ok).toBe(true);
    expect(c.remainingUnits).toBe(0n);
  });

  it("refuses when the rolling total would exceed the daily budget, naming the numbers", () => {
    const c = checkBudget({ ...base, amountUnits: 20_000_000n, receipts: [r(1, 30_000_001)] });
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("exceed the daily budget of 50.00 USDC");
    expect(c.reason).toContain("30.000001 USDC already paid");
    expect(c.reason).toContain("Nothing was spent");
  });

  it("refuses above the per-link maximum before looking at the budget", () => {
    const c = checkBudget({ ...base, amountUnits: 20_010_000n, receipts: [] });
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("per-link maximum of 20.00 USDC");
  });

  it("lets spend recover once old receipts leave the window", () => {
    const c = checkBudget({ ...base, amountUnits: 20_000_000n, receipts: [r(BUDGET_WINDOW_MS + 60_000, 50_000_000)] });
    expect(c.ok).toBe(true);
  });
});
