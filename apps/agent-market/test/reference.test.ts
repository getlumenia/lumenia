import { describe, expect, it } from "vitest";
import { MAX_REFERENCE_CHARS, referenceFor } from "../src/reference.js";

describe("referenceFor", () => {
  it("prefixes a uuid and stays within the library's 64 characters", () => {
    const r = referenceFor("4d1e2c3b-5a6f-4e7d-8c9b-0a1b2c3d4e5f");
    expect(r).toBe("agent-market:4d1e2c3b-5a6f-4e7d-8c9b-0a1b2c3d4e5f");
    expect(r.length).toBeLessThanOrEqual(MAX_REFERENCE_CHARS);
  });
  it("hashes an id that would not fit, deterministically", () => {
    const long = "x".repeat(100);
    const a = referenceFor(long);
    expect(a).toMatch(/^agent-market:sha256:[0-9a-f]{40}$/);
    expect(a).toBe(referenceFor(long));
    expect(a).not.toBe(referenceFor("y".repeat(100)));
  });
  it("rejects an empty id", () => {
    expect(() => referenceFor("  ")).toThrow();
  });
});
