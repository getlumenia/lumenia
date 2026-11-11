import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultStatePath, expandHome, newRecord, StateError, StateStore } from "../src/state.js";

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lumenia-am-state-")), "state.json");
}

describe("StateStore", () => {
  it("starts empty, round-trips a record, and upserts by assignment id", () => {
    const store = new StateStore(tempPath());
    expect(store.all()).toEqual([]);
    expect(store.get("a1")).toBeNull();
    const rec = newRecord({ assignmentId: "a1", jobId: "j1", jobTitle: "Pay two reviewers", reference: "agent-market:a1", now: "2026-11-11T12:00:00.000Z" });
    store.put(rec, "2026-11-11T12:00:01.000Z");
    rec.phase = "creating";
    store.put(rec, "2026-11-11T12:00:02.000Z");
    expect(store.all()).toHaveLength(1);
    const back = store.get("a1");
    expect(back?.phase).toBe("creating");
    expect(back?.updatedAt).toBe("2026-11-11T12:00:02.000Z");
    expect(back?.firstSeenAt).toBe("2026-11-11T12:00:00.000Z");
  });

  it("writes the file with mode 0600 and no leftover temp file", () => {
    const path = tempPath();
    const store = new StateStore(path);
    store.put(newRecord({ assignmentId: "a1", jobId: "j1", jobTitle: "", reference: "r", now: "2026-11-11T12:00:00.000Z" }), "2026-11-11T12:00:00.000Z");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });

  it("keeps the reclaim log", () => {
    const store = new StateStore(tempPath());
    store.addReclaim({ at: "t", assignmentId: "a1", publicKey: "ed25519:x", label: "Ali", amountUsdc: "1.00", txHash: "TX", explorerUrl: "u" });
    expect(store.reclaims()).toHaveLength(1);
    expect(store.all()).toEqual([]);
  });

  it("refuses to run on a corrupt or foreign file", () => {
    const path = tempPath();
    writeFileSync(path, "{not json");
    expect(() => new StateStore(path).load()).toThrow(StateError);
    writeFileSync(path, JSON.stringify({ version: 2, assignments: {}, reclaims: [] }));
    expect(() => new StateStore(path).load()).toThrow(/unexpected shape/);
  });

  it("resolves the default path from STATE_FILE with ~ expansion", () => {
    expect(defaultStatePath({ STATE_FILE: "/tmp/x.json" })).toBe("/tmp/x.json");
    expect(defaultStatePath({})).toMatch(/\.lumenia-near\/agent-market-state\.json$/);
    expect(expandHome("~/a")).not.toMatch(/^~/);
  });
});
