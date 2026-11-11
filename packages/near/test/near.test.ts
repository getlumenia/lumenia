import { describe, expect, it } from "vitest";
import { errorMessage, parseOutcome } from "../src/near.js";
import { parseUsedAmount } from "../src/lumenia.js";

describe("parseOutcome", () => {
  it("extracts the hash, the decoded return value and the logs of a successful call", () => {
    const o = parseOutcome({
      transaction: { hash: "ABC" },
      status: { SuccessValue: Buffer.from(JSON.stringify("1000000")).toString("base64") },
      transaction_outcome: { outcome: { logs: ["a"] } },
      receipts_outcome: [{ outcome: { logs: ["b", "c"] } }, { outcome: { logs: [] } }],
    });
    expect(o).toEqual({ txHash: "ABC", returnValue: '"1000000"', logs: ["a", "b", "c"], failure: null });
    expect(parseUsedAmount(o.returnValue)).toBe(1_000_000n);
  });

  it("reports a failure as JSON text", () => {
    const o = parseOutcome({ transaction: { hash: "DEF" }, status: { Failure: { ActionError: { kind: "FunctionCallError" } } } });
    expect(o.failure).toContain("FunctionCallError");
    expect(o.returnValue).toBeNull();
  });

  it("copes with empty responses", () => {
    expect(parseOutcome(undefined)).toEqual({ txHash: "", returnValue: null, logs: [], failure: null });
  });
});

describe("parseUsedAmount", () => {
  it("reads the NEP-141 return value in its usual shapes", () => {
    expect(parseUsedAmount('"250000"')).toBe(250_000n);
    expect(parseUsedAmount("250000")).toBe(250_000n);
    expect(parseUsedAmount("")).toBeNull();
    expect(parseUsedAmount(null)).toBeNull();
    expect(parseUsedAmount('"abc"')).toBeNull();
  });
});

describe("errorMessage", () => {
  it("keeps near-api-js error types visible", () => {
    const e = Object.assign(new Error("boom"), { type: "InvalidNonce" });
    expect(errorMessage(e)).toBe("boom (InvalidNonce)");
    expect(errorMessage("x")).toBe("x");
    expect(errorMessage({ a: 1 })).toBe('{"a":1}');
  });
});
