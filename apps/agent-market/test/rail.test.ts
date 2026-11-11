// The real library (@lumenia/near, packages/near) behind the worker, over the
// package's in-memory chain: proves the wiring, the reference idempotency, the
// /c/near# link shape and that LumeniaRail satisfies the PayoutRail interface
// the worker is written to.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeChain, tempStore, testConfig } from "../../../packages/near/test/helpers.js";
import { LumeniaRail, NEAR_CLAIM_PATH, openNearRail, type PayoutRail } from "../src/rail.js";
import { StateStore } from "../src/state.js";
import { Worker } from "../src/worker.js";
import { clock, FakeMarket, row } from "./fakes.js";

const ID = "4d1e2c3b-5a6f-4e7d-8c9b-0a1b2c3d4e5f";

function realRail() {
  const c = clock();
  const chain = new FakeChain();
  chain.now = c.now;
  chain.usdc = 100_000_000n;
  const lumenia = openNearRail(testConfig({ webOrigin: "https://getlumenia.com" }), { chain, store: tempStore(), now: c.now });
  const rail: PayoutRail = new LumeniaRail(lumenia);
  return { rail, chain, lumenia, ...c };
}

describe("LumeniaRail over the real library", () => {
  it("funds a batch in one ft_transfer_call, is idempotent on the reference, and exposes the receipts", async () => {
    const { rail, chain, lumenia } = realRail();
    const r = await rail.createPayLinks({
      payouts: [
        { label: "Ayse", amountUsdc: "1.00", memo: "thanks" },
        { label: "Ali", amountUsdc: "2.50" },
      ],
      expiresHours: 48,
      reference: `agent-market:${ID}`,
    });
    expect(r.count).toBe(2);
    expect(r.totalUsdc).toBe("3.50");
    expect(r.txHash).toBe("FAKETX1");
    expect(r.payouts[0]?.link).toMatch(/^https:\/\/getlumenia\.com\/c\/near#ed25519:/);
    expect(NEAR_CLAIM_PATH).toBe("/c/near");
    expect(r.payouts.map((p) => p.receipt.status)).toEqual(["Open", "Open"]);
    expect(chain.calls.filter((c) => c === "ft_transfer_call")).toHaveLength(1);
    expect(chain.lastMsg).toMatchObject({ expires_in_s: 48 * 3600 });
    expect((chain.lastMsg?.drops as unknown[]).length).toBe(2);
    // The receipt log on disk carries the same /c/near# link (re-pathed before the broadcast).
    expect(lumenia.store.findByPublicKey(r.payouts[0]!.publicKey)?.link).toBe(r.payouts[0]!.link);

    const again = await rail.createPayLinks({ payouts: [{ label: "Ayse", amountUsdc: "1.00" }], expiresHours: 48, reference: `agent-market:${ID}` });
    expect(again.note).toMatch(/instead of paying twice/);
    expect(again.payouts.map((p) => p.publicKey)).toEqual(r.payouts.map((p) => p.publicKey));
    expect(chain.calls.filter((c) => c === "ft_transfer_call")).toHaveLength(1);

    const receipts = rail.receiptsByReference(`agent-market:${ID}`);
    expect(receipts.map((x) => [x.label, x.amountUsdc, x.status])).toEqual([
      ["Ayse", "1.00", "Open"],
      ["Ali", "2.50", "Open"],
    ]);
    expect(receipts[0]?.link).toBe(r.payouts[0]?.link);

    const status = await rail.linkStatus(r.payouts[0]!.publicKey);
    expect(status.drop.kind).toBe("Open");
    const b = await rail.balances();
    expect(b.budget.spentLast24hUsdc).toBe("3.50");
    expect(rail.network).toBe("near:testnet");
    expect(rail.contractId).toBe("lumenia-near.testnet");
    expect(rail.webOrigin).toBe("https://getlumenia.com");
  });

  it("drives the whole worker path end to end over the real library", async () => {
    const { rail, chain, now, advance } = realRail();
    const market = new FakeMarket();
    market.now = now;
    const state = new StateStore(join(mkdtempSync(join(tmpdir(), "lumenia-am-rail-")), "state.json"));
    const worker = new Worker({ market, rail, state, now, sleep: async () => {} });
    market.rows.push(row());
    expect((await worker.pollOnce()).outcomes[ID]).toBe("submitted");
    const md = market.submissions[0]!.markdown;
    expect(md).toMatch(/\[FAKETX1\]\(https:\/\/testnet\.nearblocks\.io\/txns\/FAKETX1\)/);
    expect(md).toMatch(/https:\/\/getlumenia\.com\/c\/near#ed25519:/);
    expect(md).not.toMatch(/getlumenia\.com\/c#/);
    expect(chain.usdc).toBe(96_500_000n);

    // nobody claims: after expiry the reclaim pass takes both back through the library
    advance(49 * 3_600_000);
    const s = await worker.reclaim();
    expect(s.reclaimed).toHaveLength(2);
    expect(chain.usdc).toBe(100_000_000n);
    expect(state.get(ID)!.links.every((l) => l.status === "Reclaimed")).toBe(true);
  });

  it("from the environment, points the links at the product unless WEB_ORIGIN says otherwise, and never at the package's dev page", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lumenia-am-rail-env-"));
    const bare = LumeniaRail.fromEnv({ LUMENIA_DATA_DIR: dataDir });
    expect(bare.webOrigin).toBe("https://getlumenia.com");
    expect(bare.network).toBe("near:testnet");
    const set = LumeniaRail.fromEnv({ LUMENIA_DATA_DIR: dataDir, WEB_ORIGIN: "https://staging.getlumenia.com/" });
    expect(set.webOrigin).toBe("https://staging.getlumenia.com");
    expect(() => LumeniaRail.fromEnv({ LUMENIA_DATA_DIR: dataDir, NEAR_NETWORK: "mainnet" })).toThrow(/testnet-only/);
  });

  it("declines with the library's own reason when the treasury cannot pay", async () => {
    const { rail, chain, now } = realRail();
    chain.usdc = 1_000_000n;
    const market = new FakeMarket();
    market.now = now;
    const state = new StateStore(join(mkdtempSync(join(tmpdir(), "lumenia-am-rail-")), "state.json"));
    const worker = new Worker({ market, rail, state, now, sleep: async () => {} });
    market.rows.push(row());
    expect((await worker.pollOnce()).outcomes[ID]).toBe("declined");
    expect(market.declines[0]).toMatchObject({ reason: "rejected" });
    expect(market.declines[0]?.detail).toMatch(/treasury holds 1.00 USDC and this job needs 3.50/);
    expect(chain.calls.filter((c) => c === "ft_transfer_call")).toHaveLength(0);
  });
});
