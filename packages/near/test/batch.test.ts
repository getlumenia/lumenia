import { describe, expect, it } from "vitest";
import { BatchError, batchTotal, buildBatchMsg, MAX_BATCH_DROPS } from "../src/batch.js";
import { newLinkKey } from "../src/link.js";

const keys = Array.from({ length: 31 }, () => newLinkKey().publicKey);
const drop = (i: number, amountUnits: bigint, memo = "") => ({ publicKey: keys[i]!, amountUnits, memo });

describe("buildBatchMsg", () => {
  it("builds the contract's msg: drops with string units and a shared expires_in_s, total = exact sum", () => {
    const { msg, totalUnits } = buildBatchMsg([drop(0, 2_500_000n, "rent"), drop(1, 100_000n), drop(2, 19_990_000n, "x")], 86_400);
    expect(msg).toEqual({
      drops: [
        { public_key: keys[0], amount: "2500000", memo: "rent" },
        { public_key: keys[1], amount: "100000", memo: "" },
        { public_key: keys[2], amount: "19990000", memo: "x" },
      ],
      expires_in_s: 86_400,
    });
    expect(totalUnits).toBe(22_590_000n);
    expect(batchTotal(msg)).toBe(totalUnits);
    expect(JSON.parse(JSON.stringify(msg)).drops[0].amount).toBe("2500000");
  });

  it("accepts 1 and 30 payouts and refuses 0 and 31", () => {
    expect(buildBatchMsg([drop(0, 100_000n)], 3600).msg.drops).toHaveLength(1);
    const thirty = keys.slice(0, 30).map((_, i) => drop(i, 100_000n));
    expect(buildBatchMsg(thirty, 3600).totalUnits).toBe(3_000_000n);
    expect(() => buildBatchMsg([], 3600)).toThrow(BatchError);
    expect(() => buildBatchMsg(keys.map((_, i) => drop(i, 100_000n)), 3600)).toThrow(/at most 30/);
    expect(MAX_BATCH_DROPS).toBe(30);
  });

  it("refuses a payout under 0.10 USDC, naming the row", () => {
    expect(() => buildBatchMsg([drop(0, 1_000_000n), drop(1, 99_999n)], 3600)).toThrow(/payout 2 is 0.099999 USDC; each payout in a batch must be at least 0.10 USDC/);
  });

  it("refuses repeated keys, bad memos and expiry outside 60..604800 s", () => {
    expect(() => buildBatchMsg([drop(0, 100_000n), { publicKey: keys[0]!, amountUnits: 100_000n, memo: "" }], 3600)).toThrow(/repeats/);
    expect(() => buildBatchMsg([drop(0, 100_000n, "m".repeat(65))], 3600)).toThrow(/memo/);
    expect(() => buildBatchMsg([{ publicKey: "secp256k1:abc", amountUnits: 100_000n, memo: "" }], 3600)).toThrow(/ed25519/);
    expect(() => buildBatchMsg([drop(0, 100_000n)], 59)).toThrow(/expires_in_s/);
    expect(() => buildBatchMsg([drop(0, 100_000n)], 604_801)).toThrow(/expires_in_s/);
    expect(() => buildBatchMsg([drop(0, 100_000n)], 1.5)).toThrow(/expires_in_s/);
  });
});
