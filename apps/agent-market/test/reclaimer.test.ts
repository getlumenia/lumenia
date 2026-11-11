import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isFinalStatus, reclaimPass } from "../src/reclaimer.js";
import { StateStore } from "../src/state.js";
import { Worker } from "../src/worker.js";
import { clock, FakeMarket, FakeRail, row } from "./fakes.js";

const ID = "4d1e2c3b-5a6f-4e7d-8c9b-0a1b2c3d4e5f";

async function withLinks() {
  const c = clock();
  const market = new FakeMarket();
  market.now = c.now;
  const rail = new FakeRail();
  rail.now = c.now;
  const state = new StateStore(join(mkdtempSync(join(tmpdir(), "lumenia-am-reclaim-")), "state.json"));
  const worker = new Worker({ market, rail, state, now: c.now, sleep: async () => {} });
  market.rows.push(row()); // 48 h expiry, two links
  await worker.pollOnce();
  return { market, rail, state, worker, ...c };
}

describe("reclaimPass", () => {
  it("leaves unexpired links alone", async () => {
    const { rail, state, now } = await withLinks();
    const s = await reclaimPass({ rail, state, now });
    expect(s).toMatchObject({ checked: 0, open: 2, reclaimed: [], claimed: 0, errors: [] });
    expect(rail.reclaimCalls).toEqual([]);
  });

  it("reclaims expired unclaimed links, records claimed ones, and logs to the state file", async () => {
    const { rail, state, now, advance } = await withLinks();
    rail.claim("ed25519:PUB2", "ayse.testnet");
    advance(49 * 3_600_000);
    const s = await reclaimPass({ rail, state, now });
    expect(s.checked).toBe(2);
    expect(s.reclaimed.map((r) => [r.publicKey, r.label, r.amountUsdc, r.txHash])).toEqual([["ed25519:PUB1", "Ayse", "1.00", "RECLAIM1"]]);
    expect(s.claimed).toBe(1);
    expect(rail.reclaimCalls).toEqual(["ed25519:PUB1"]);
    const rec = state.get(ID)!;
    expect(rec.links[0]).toMatchObject({ status: "Reclaimed", reclaimTxHash: "RECLAIM1" });
    expect(rec.links[1]).toMatchObject({ status: "Claimed to ayse.testnet", claimedTo: "ayse.testnet" });
    expect(state.reclaims()).toHaveLength(1);
    // a second pass has nothing left to do
    const again = await reclaimPass({ rail, state, now });
    expect(again).toMatchObject({ checked: 0, reclaimed: [] });
  });

  it("records a chain-side disagreement (still Open) and a lookup error without stopping", async () => {
    const { rail, state, now, advance } = await withLinks();
    advance(49 * 3_600_000);
    const later = new Date(now().getTime() + 3_600_000).toISOString();
    rail.drops.get("ed25519:PUB1")!.expiresAt = later; // the chain says one more hour
    rail.drops.delete("ed25519:PUB2"); // and knows nothing about the other
    const s = await reclaimPass({ rail, state, now });
    expect(s.open).toBe(1);
    expect(state.get(ID)!.links[0]!.expiresAt).toBe(later);
    expect(state.get(ID)!.links[1]!.status).toBe("NotFound");
    expect(rail.reclaimCalls).toEqual([]);

    const broken = Object.create(rail) as FakeRail;
    broken.linkStatus = async () => {
      throw new Error("RPC down");
    };
    advance(2 * 3_600_000); // past the chain's later expiry: the link is looked up again, and the lookup breaks
    const s2 = await reclaimPass({ rail: broken, state, now });
    expect(s2.errors).toHaveLength(1);
    expect(s2.errors[0]).toMatch(/RPC down/);
  });

  it("adopts links of a declined job that landed on chain after all, then reclaims them after expiry", async () => {
    const c = clock();
    const rail = new FakeRail();
    rail.now = c.now;
    const state = new StateStore(join(mkdtempSync(join(tmpdir(), "lumenia-am-reclaim-")), "state.json"));
    const reference = `agent-market:${ID}`;
    // the deposit went through on chain...
    await rail.createPayLinks({ payouts: [{ label: "Ali", amountUsdc: "1.00", memo: "" }], expiresHours: 1, reference });
    // ...but the worker saw an error and declined (its record has no links)
    state.put(
      {
        assignmentId: ID,
        jobId: "j",
        jobTitle: "",
        firstSeenAt: c.now().toISOString(),
        updatedAt: c.now().toISOString(),
        phase: "failed",
        reference,
        brief: null,
        batchId: null,
        links: [],
        deliverable: null,
        submissions: [],
        decline: { at: c.now().toISOString(), reason: "failed", detail: "x", delivered: true },
        lastProgressAt: null,
        errors: [],
        notes: [],
      },
      c.now().toISOString(),
    );
    const s1 = await reclaimPass({ rail, state, now: c.now });
    expect(s1.adopted).toBe(1);
    expect(state.get(ID)!.links[0]).toMatchObject({ publicKey: "ed25519:PUB1", status: "Open", note: expect.stringMatching(/landed on chain/) });
    c.advance(2 * 3_600_000);
    const s2 = await reclaimPass({ rail, state, now: c.now });
    expect(s2.reclaimed).toHaveLength(1);
    expect(rail.reclaimCalls).toEqual(["ed25519:PUB1"]);
  });

  it("isFinalStatus", () => {
    expect(isFinalStatus("Claimed to a.testnet")).toBe(true);
    expect(isFinalStatus("Reclaimed")).toBe(true);
    expect(isFinalStatus("Open")).toBe(false);
    expect(isFinalStatus("Expired")).toBe(false);
  });
});
