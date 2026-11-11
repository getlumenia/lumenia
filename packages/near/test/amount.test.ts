import { describe, expect, it } from "vitest";
import { AmountError, formatNear, formatUsdc, parseUsdcAmount } from "../src/amount.js";

describe("parseUsdcAmount", () => {
  it("parses strings and numbers with up to two decimals into 6-decimal units", () => {
    expect(parseUsdcAmount("2.50")).toBe(2_500_000n);
    expect(parseUsdcAmount("2.5")).toBe(2_500_000n);
    expect(parseUsdcAmount(2.5)).toBe(2_500_000n);
    expect(parseUsdcAmount("1")).toBe(1_000_000n);
    expect(parseUsdcAmount(20)).toBe(20_000_000n);
    expect(parseUsdcAmount("0.01")).toBe(10_000n);
    expect(parseUsdcAmount(" 7.25 ")).toBe(7_250_000n);
  });

  it("rejects more than two decimals, zero, negatives, exponents and junk", () => {
    for (const bad of ["2.505", "0", "0.00", "-1", "1e-7", "1e21", "abc", "", "1,50", ".5", "5.", 0, -2, 0.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseUsdcAmount(bad as never), String(bad)).toThrow(AmountError);
    }
  });

  it("does not go through floating point for cents", () => {
    expect(parseUsdcAmount("0.29")).toBe(290_000n);
    expect(parseUsdcAmount(0.29)).toBe(290_000n);
    expect(parseUsdcAmount("19.99")).toBe(19_990_000n);
  });
});

describe("formatUsdc", () => {
  it("prints at least two decimals and trims trailing zeros beyond that", () => {
    expect(formatUsdc(1_000_000n)).toBe("1.00");
    expect(formatUsdc("2500000")).toBe("2.50");
    expect(formatUsdc(1_234_567n)).toBe("1.234567");
    expect(formatUsdc(10_000n)).toBe("0.01");
    expect(formatUsdc(0n)).toBe("0.00");
    expect(formatUsdc(50_000_000n)).toBe("50.00");
  });

  it("round-trips with parseUsdcAmount", () => {
    for (const s of ["0.01", "2.50", "19.99", "20.00"]) expect(formatUsdc(parseUsdcAmount(s))).toBe(s);
  });
});

describe("formatNear", () => {
  it("formats yoctoNEAR for display", () => {
    expect(formatNear(10n ** 24n)).toBe("1.0000");
    expect(formatNear(1_250_000_000_000_000_000_000n, 5)).toBe("0.00125");
  });
});
