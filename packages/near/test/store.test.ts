import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StoreError } from "../src/store.js";
import type { Receipt } from "../src/receipts.js";
import { tempStore } from "./helpers.js";

const r = (id: string): Receipt => ({
  receipt_id: id,
  created_at: "2026-11-11T11:00:00.000Z",
  amount_usdc: "1.00",
  amount_units: "1000000",
  memo: "",
  label: null,
  batch_id: null,
  reference: null,
  link_public_key: `ed25519:${id}`,
  funder_account: "f.testnet",
  create_tx_hash: null,
  explorer_url: null,
  expires_at: "2026-11-12T11:00:00.000Z",
  status: "Submitting",
  claimed_to: null,
  claim_tx_hash: null,
  reclaim_tx_hash: null,
  updated_at: "2026-11-11T11:00:00.000Z",
  error: null,
  network: "testnet",
  link: `https://x.test/c#secret-${id}`,
});

describe("LinkStore", () => {
  it("starts empty, upserts by receipt_id and keeps the file private", () => {
    const store = tempStore();
    expect(store.all()).toEqual([]);
    store.upsert(r("a"));
    store.upsert(r("b"));
    store.upsert({ ...r("a"), status: "Open" });
    expect(store.all().map((x) => `${x.receipt_id}:${x.status}`)).toEqual(["a:Open", "b:Submitting"]);
    expect(store.findByPublicKey("ed25519:b")?.receipt_id).toBe("b");
    expect(existsSync(store.path)).toBe(true);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(store.path, "utf8")).version).toBe(1);
  });

  it("refuses a corrupt or foreign file instead of overwriting it", () => {
    const store = tempStore();
    store.upsert(r("a"));
    writeFileSync(store.path, "{not json");
    expect(() => store.all()).toThrow(StoreError);
    writeFileSync(store.path, JSON.stringify({ version: 2, receipts: [] }));
    expect(() => store.all()).toThrow(StoreError);
  });
});
