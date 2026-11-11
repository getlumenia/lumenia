import { describe, expect, it } from "vitest";
import { mapDrop, nsToIso, publicReceipt, RECEIPT_CSV_COLUMNS, receiptsToCsv, type Receipt } from "../src/receipts.js";

const now = new Date("2026-11-11T12:00:00.000Z");
const ns = (iso: string) => `${Date.parse(iso)}000000`;

const open = {
  status: "Open",
  amount: "1000000",
  funder: "lumenia-funder.testnet",
  created_at_ns: ns("2026-11-11T11:00:00.000Z"),
  expires_at_ns: ns("2026-11-12T11:00:00.000Z"),
  claimed_to: null,
  memo: "thanks",
};

describe("mapDrop (status mapping)", () => {
  it("maps null to NotFound", () => {
    expect(mapDrop(null, now).kind).toBe("NotFound");
    expect(mapDrop(undefined, now).label).toBe("NotFound");
  });

  it("maps Open before expiry to Open and after expiry to Expired", () => {
    const o = mapDrop(open, now);
    expect(o).toMatchObject({ kind: "Open", label: "Open", amountUsdc: "1.00", funder: "lumenia-funder.testnet", memo: "thanks", claimedTo: null });
    expect(o.expiresAt).toBe("2026-11-12T11:00:00.000Z");
    expect(o.createdAt).toBe("2026-11-11T11:00:00.000Z");
    const e = mapDrop({ ...open, expires_at_ns: ns("2026-11-11T11:59:59.000Z") }, now);
    expect(e.kind).toBe("Expired");
    expect(e.label).toBe("Expired");
  });

  it("maps Claiming, Claimed (with account) and Reclaimed", () => {
    expect(mapDrop({ ...open, status: "Claiming" }, now).label).toBe("Claiming");
    const c = mapDrop({ ...open, status: "Claimed", claimed_to: "ali.testnet" }, now);
    expect(c.kind).toBe("Claimed");
    expect(c.label).toBe("Claimed to ali.testnet");
    expect(c.claimedTo).toBe("ali.testnet");
    expect(mapDrop({ ...open, status: "Reclaimed" }, now).label).toBe("Reclaimed");
  });

  it("accepts numeric nanosecond timestamps and enum-object statuses", () => {
    const d = mapDrop({ ...open, status: { Claimed: {} }, claimed_to: "x.testnet", created_at_ns: 1_794_394_800_000_000_000, expires_at_ns: 1_794_481_200_000_000_000 }, now);
    expect(d.label).toBe("Claimed to x.testnet");
    expect(d.createdAt).toBe("2026-11-11T11:00:00.000Z");
    expect(nsToIso("1794481200000000000")).toBe("2026-11-12T11:00:00.000Z");
  });

  it("passes unknown statuses through instead of guessing", () => {
    expect(mapDrop({ ...open, status: "Frozen" }, now)).toMatchObject({ kind: "Other", label: "Frozen" });
  });
});

const receipt: Receipt = {
  receipt_id: "rcpt_1",
  created_at: "2026-11-11T11:00:00.000Z",
  amount_usdc: "2.50",
  amount_units: "2500000",
  memo: 'thanks, "Ali"',
  label: null,
  batch_id: null,
  reference: "inv-1",
  link_public_key: "ed25519:PUBKEY",
  funder_account: "lumenia-funder.testnet",
  create_tx_hash: "TXHASH",
  explorer_url: "https://testnet.nearblocks.io/txns/TXHASH",
  expires_at: "2026-11-12T11:00:00.000Z",
  status: "Claimed to ali.testnet",
  claimed_to: "ali.testnet",
  claim_tx_hash: null,
  reclaim_tx_hash: null,
  updated_at: "2026-11-11T11:05:00.000Z",
  error: null,
  network: "testnet",
  link: "https://near.lumenia.test/c#ed25519:SECRET",
};

describe("receipts", () => {
  it("publicReceipt drops the secret link and nothing else", () => {
    const p = publicReceipt(receipt);
    expect("link" in p).toBe(false);
    expect(p.link_public_key).toBe("ed25519:PUBKEY");
    expect(p.status).toBe("Claimed to ali.testnet");
  });

  it("exports RFC 4180 CSV with the fixed columns and no secret", () => {
    const csv = receiptsToCsv([
      receipt,
      { ...receipt, receipt_id: "rcpt_2", memo: "line1\nline2", label: "Ali, courier", batch_id: "batch_9", status: "Open", claimed_to: null, create_tx_hash: null },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(RECEIPT_CSV_COLUMNS.join(","));
    expect(lines[1]).toBe(
      'rcpt_1,2026-11-11T11:00:00.000Z,2.50,"thanks, ""Ali""",,,ed25519:PUBKEY,lumenia-funder.testnet,TXHASH,https://testnet.nearblocks.io/txns/TXHASH,2026-11-12T11:00:00.000Z,Claimed to ali.testnet,ali.testnet,,,2026-11-11T11:05:00.000Z',
    );
    expect(lines[2]).toContain('"line1\nline2","Ali, courier",batch_9,');
    expect(csv).not.toContain("SECRET");
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});
