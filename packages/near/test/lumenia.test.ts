import { describe, expect, it } from "vitest";
import { Lumenia, LumeniaError, payInstruction } from "../src/lumenia.js";
import { armReturnTgas } from "../src/return-timer.js";
import { parseLinkOrKey } from "../src/link.js";
import { CONTRACT, FakeChain, FUNDER, tempStore, testConfig } from "./helpers.js";

const T0 = new Date("2026-11-11T12:00:00.000Z");

function setup(overrides: Parameters<typeof testConfig>[0] = {}) {
  const chain = new FakeChain();
  const store = tempStore();
  let now = new Date(T0);
  chain.now = () => now;
  const lumenia = new Lumenia(testConfig(overrides), { chain, store, now: () => now });
  return { chain, store, lumenia, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("createPayLink", () => {
  it("escrows the amount, returns the link + receipt, and writes the receipt before broadcasting", async () => {
    const { chain, store, lumenia } = setup();
    let seenBeforeBroadcast: string | undefined;
    chain.onTransfer = (msg) => {
      const r = store.findByPublicKey(String(msg.public_key));
      seenBeforeBroadcast = r ? `${r.status}|${r.link ? "link" : "nolink"}` : "missing";
    };
    const r = await lumenia.createPayLink({ amountUsdc: 2.5, expiresHours: 3, memo: "thanks", reference: "inv-1" });
    expect(seenBeforeBroadcast).toBe("Submitting|link");
    expect(r.link).toMatch(/^https:\/\/near\.lumenia\.test\/c#ed25519:/);
    expect(parseLinkOrKey(r.link).publicKey).toBe(r.publicKey);
    expect(r.txHash).toBe("FAKETX1");
    expect(r.explorerUrl).toBe("https://testnet.nearblocks.io/txns/FAKETX1");
    expect(r.expiresAt).toBe("2026-11-11T15:00:00.000Z");
    expect(r.instruction).toBe(payInstruction(r.expiresAt, r.returnTimer));
    expect(r.instruction).toMatch(/comes back to this account by itself/);
    expect(r.receipt).toMatchObject({
      amount_usdc: "2.50",
      memo: "thanks",
      reference: "inv-1",
      link_public_key: r.publicKey,
      funder_account: FUNDER,
      create_tx_hash: "FAKETX1",
      status: "Open",
      network: "testnet",
    });
    expect("link" in r.receipt).toBe(false);
    expect(chain.usdc).toBe(17_500_000n);
    expect(chain.drops.get(r.publicKey)?.memo).toBe("thanks");
    expect(chain.calls.filter((c) => c === "ft_transfer_call")).toHaveLength(1);
    // the return timer, armed after the link exists, for this link and a 3 h life
    expect(chain.calls.indexOf("arm_return 1")).toBeGreaterThan(chain.calls.indexOf("ft_transfer_call"));
    expect(chain.arms).toEqual([{ publicKeys: [r.publicKey], gasTgas: armReturnTgas(3 * 3600) }]);
    expect(r.returnTimer).toEqual({ armed: true, txHash: "FAKETX2", explorerUrl: "https://testnet.nearblocks.io/txns/FAKETX2", gasTgas: armReturnTgas(3 * 3600) });
  });

  it("does not arm a timer for a life one transaction's gas cannot cover, and says what to do instead", async () => {
    const { chain, lumenia } = setup();
    const r = await lumenia.createPayLink({ amountUsdc: "1", expiresHours: 24 });
    expect(chain.calls.some((c) => c.startsWith("arm_return"))).toBe(false);
    expect(r.returnTimer?.armed).toBe(false);
    expect(r.returnTimer && !r.returnTimer.armed ? r.returnTimer.reason : "").toMatch(/longer than one transaction's gas keeps a return timer awake.*lumenia_reclaim.*return_expired/);
    expect(r.instruction).toMatch(/call lumenia_reclaim with the link's public key/);
  });

  it("keeps the payment when the timer cannot be armed", async () => {
    const { chain, lumenia } = setup();
    chain.failArm = "RPC unreachable";
    const r = await lumenia.createPayLink({ amountUsdc: "1", expiresHours: 2 });
    expect(r.receipt.status).toBe("Open");
    expect(r.returnTimer).toEqual({ armed: false, reason: expect.stringMatching(/could not be armed \(RPC unreachable\); after the expiry, call lumenia_reclaim/) });
    expect(r.instruction).toMatch(/call lumenia_reclaim/);
  });

  it("links live 8 hours by default, which one return timer covers", async () => {
    const { chain, lumenia } = setup();
    const r = await lumenia.createPayLink({ amountUsdc: "1" });
    expect(r.expiresAt).toBe("2026-11-11T20:00:00.000Z");
    expect(chain.arms[0]?.gasTgas).toBe(armReturnTgas(8 * 3600));
    expect(r.returnTimer?.armed).toBe(true);
  });

  it("sends the contract the msg it expects", async () => {
    const { chain, lumenia } = setup();
    let msg: Record<string, unknown> = {};
    chain.onTransfer = (m) => (msg = m);
    const r = await lumenia.createPayLink({ amountUsdc: "1", expiresHours: 24, memo: "m" });
    expect(msg).toEqual({ public_key: r.publicKey, expires_in_s: 86_400, memo: "m" });
    expect(String(msg.public_key)).toMatch(/^ed25519:/);
  });

  it("validates expiry, memo and reference before touching the chain", async () => {
    const { chain, lumenia } = setup();
    await expect(lumenia.createPayLink({ amountUsdc: 1, expiresHours: 0 })).rejects.toThrow(/expiresHours/);
    await expect(lumenia.createPayLink({ amountUsdc: 1, expiresHours: 169 })).rejects.toThrow(/expiresHours/);
    await expect(lumenia.createPayLink({ amountUsdc: 1, expiresHours: 1.5 })).rejects.toThrow(/expiresHours/);
    await expect(lumenia.createPayLink({ amountUsdc: 1, memo: "x".repeat(65) })).rejects.toThrow(/memo/);
    await expect(lumenia.createPayLink({ amountUsdc: 1, memo: "a\nb" })).rejects.toThrow(/single line/);
    await expect(lumenia.createPayLink({ amountUsdc: 1, reference: "r".repeat(65) })).rejects.toThrow(/reference/);
    await expect(lumenia.createPayLink({ amountUsdc: "1.234" })).rejects.toThrow(/2 decimal/);
    expect(chain.calls).toHaveLength(0);
  });

  it("enforces the per-link maximum and the daily budget, spending nothing", async () => {
    const { chain, lumenia } = setup();
    await expect(lumenia.createPayLink({ amountUsdc: 20.01 })).rejects.toThrow(/per-link maximum of 20.00 USDC/);
    chain.usdc = 1_000_000_000n;
    await lumenia.createPayLink({ amountUsdc: 20, memo: "a" });
    await lumenia.createPayLink({ amountUsdc: 20, memo: "b" });
    await expect(lumenia.createPayLink({ amountUsdc: 10.01, memo: "c" })).rejects.toThrow(/exceed the daily budget of 50.00 USDC/);
    await lumenia.createPayLink({ amountUsdc: 10, memo: "d" });
    const b = await lumenia.balances();
    expect(b.budget).toEqual({ dailyBudgetUsdc: "50.00", spentLast24hUsdc: "50.00", remainingUsdc: "0.00", maxLinkUsdc: "20.00" });
    expect(chain.calls.filter((c) => c === "ft_transfer_call")).toHaveLength(3);
  });

  it("is idempotent on reference: the second call returns the first receipt and pays nothing", async () => {
    const { chain, lumenia } = setup();
    const a = await lumenia.createPayLink({ amountUsdc: 3, reference: "order-7" });
    const b = await lumenia.createPayLink({ amountUsdc: 3, reference: "order-7" });
    expect(b.receipt.receipt_id).toBe(a.receipt.receipt_id);
    expect(b.link).toBe(a.link);
    expect(b.note).toMatch(/instead of paying twice/);
    expect(chain.calls.filter((c) => c === "ft_transfer_call")).toHaveLength(1);
  });

  it("refuses an identical payment within two minutes unless allowDuplicate is set", async () => {
    const { chain, lumenia, advance } = setup();
    await lumenia.createPayLink({ amountUsdc: 1, memo: "coffee" });
    await expect(lumenia.createPayLink({ amountUsdc: 1, memo: "coffee" })).rejects.toThrow(/identical payment/);
    await lumenia.createPayLink({ amountUsdc: 1, memo: "coffee", allowDuplicate: true });
    advance(3 * 60_000);
    await lumenia.createPayLink({ amountUsdc: 1, memo: "coffee" });
    expect(chain.calls.filter((c) => c === "ft_transfer_call")).toHaveLength(3);
  });

  it("refuses when the funder is unregistered, broke, or the escrow is unregistered", async () => {
    const { chain, lumenia } = setup();
    chain.funderRegistered = false;
    await expect(lumenia.createPayLink({ amountUsdc: 1 })).rejects.toThrow(/not registered on the USDC contract.*lumenia register/);
    chain.funderRegistered = true;
    chain.usdc = 999_999n;
    await expect(lumenia.createPayLink({ amountUsdc: 1 })).rejects.toThrow(/Insufficient USDC: .* holds 0.999999 USDC/);
    chain.usdc = 20_000_000n;
    chain.contractRegistered = false;
    await expect(lumenia.createPayLink({ amountUsdc: 1 })).rejects.toThrow(/escrow contract .* not registered/);
    expect(chain.calls.filter((c) => c === "ft_transfer_call")).toHaveLength(0);
  });

  it("marks the receipt Failed (and keeps the link) when the deposit throws before landing", async () => {
    const { chain, store, lumenia } = setup();
    chain.throwOnTransfer = { message: "Server error: timeout", landed: false };
    await expect(lumenia.createPayLink({ amountUsdc: 1 })).rejects.toThrow(/nothing was spent: Server error: timeout/i);
    const [r] = store.all();
    expect(r?.status).toBe("Failed");
    expect(r?.error).toContain("timeout");
    expect(r?.link).toMatch(/#ed25519:/);
    // a failed receipt does not eat the budget
    const b = await lumenia.balances();
    expect(b.budget.spentLast24hUsdc).toBe("0.00");
  });

  it("recovers when the RPC fails after the deposit landed", async () => {
    const { chain, lumenia } = setup();
    chain.throwOnTransfer = { message: "socket hang up", landed: true };
    const r = await lumenia.createPayLink({ amountUsdc: 1 });
    expect(r.receipt.status).toBe("Open");
    expect(r.txHash).toBeNull();
    expect(r.note).toMatch(/confirmed on chain/);
  });

  it("treats a partial acceptance by the escrow as a refund and fails the receipt", async () => {
    const { chain, store, lumenia } = setup();
    chain.keepOnlyUnits = 0n;
    await expect(lumenia.createPayLink({ amountUsdc: 1 })).rejects.toThrow(/refused the deposit and the USDC was refunded/);
    expect(store.all()[0]?.status).toBe("Failed");
  });

  it("fails the receipt when the transaction itself fails", async () => {
    const { chain, store, lumenia } = setup();
    chain.failNextTx = '{"ActionError":{"kind":"FunctionCallError"}}';
    await expect(lumenia.createPayLink({ amountUsdc: 1 })).rejects.toThrow(/Deposit transaction failed/);
    expect(store.all()[0]).toMatchObject({ status: "Failed", create_tx_hash: "FAKETX1" });
  });
});

describe("linkStatus", () => {
  it("reads the chain and updates the stored receipt", async () => {
    const { chain, lumenia } = setup();
    const paid = await lumenia.createPayLink({ amountUsdc: 1 });
    const d = chain.drops.get(paid.publicKey)!;
    d.status = "Claimed";
    d.claimed_to = "ali.testnet";
    const s = await lumenia.linkStatus(paid.link);
    expect(s.publicKey).toBe(paid.publicKey);
    expect(s.status).toBe("Claimed to ali.testnet");
    expect(s.drop.claimedTo).toBe("ali.testnet");
    expect(s.receipt).toMatchObject({ status: "Claimed to ali.testnet", claimed_to: "ali.testnet" });
    const list = await lumenia.listReceipts();
    expect(list[0]?.status).toBe("Claimed to ali.testnet");
  });

  it("answers NotFound for a key it never saw, with no receipt", async () => {
    const { lumenia } = setup();
    const { publicKey } = parseLinkOrKey(`https://x.test/c#${(await import("../src/link.js")).newLinkKey().secretKey}`);
    const s = await lumenia.linkStatus(publicKey);
    expect(s).toMatchObject({ publicKey, status: "NotFound", receipt: null });
  });

  it("reports Expired once the chain's expiry has passed", async () => {
    const { lumenia, advance } = setup();
    const paid = await lumenia.createPayLink({ amountUsdc: 1, expiresHours: 1 });
    advance(61 * 60_000);
    const s = await lumenia.linkStatus(paid.publicKey);
    expect(s.status).toBe("Expired");
    expect(s.receipt?.status).toBe("Expired");
  });

  it("turns a stale Submitting receipt with no drop into Failed after the grace period", async () => {
    const { chain, store, lumenia, advance } = setup();
    chain.throwOnTransfer = { message: "timeout", landed: false };
    await lumenia.createPayLink({ amountUsdc: 1 }).catch(() => undefined);
    const r = store.all()[0]!;
    store.upsert({ ...r, status: "Submitting" });
    expect((await lumenia.linkStatus(r.link_public_key)).receipt?.status).toBe("Submitting");
    advance(3 * 60_000);
    expect((await lumenia.linkStatus(r.link_public_key)).receipt?.status).toBe("Failed");
  });
});

describe("reclaim", () => {
  it("refuses before expiry and for unknown or settled drops, spending nothing", async () => {
    const { chain, lumenia } = setup();
    const paid = await lumenia.createPayLink({ amountUsdc: 1, expiresHours: 2 });
    await expect(lumenia.reclaim(paid.publicKey)).rejects.toThrow(/Not expired yet.*2 h from now/);
    // An altered key: its last base58 character always becomes a different one ("1" -> "2", anything else
    // -> "1"). The key is random, so a fixed `.replace(/.$/, "1")` changed nothing whenever it already ended
    // in "1" and then hit the real drop ("Not expired yet"), about 1 run in 58.
    const realKey = parseLinkOrKey(paid.link).publicKey;
    const alteredKey = realKey.slice(0, -1) + (realKey.endsWith("1") ? "2" : "1");
    expect(alteredKey).not.toBe(realKey);
    await expect(lumenia.reclaim(alteredKey)).rejects.toThrow(/No drop on chain|not a valid/);
    chain.drops.get(paid.publicKey)!.status = "Claimed";
    chain.drops.get(paid.publicKey)!.claimed_to = "b.testnet";
    await expect(lumenia.reclaim(paid.publicKey)).rejects.toThrow(/status is "Claimed to b.testnet"/);
    expect(chain.calls.some((c) => c.startsWith("reclaim"))).toBe(false);
  });

  it("reclaims an expired drop and records the tx hash on the receipt", async () => {
    const { chain, lumenia, advance } = setup();
    const paid = await lumenia.createPayLink({ amountUsdc: 1, expiresHours: 1 });
    advance(2 * 3_600_000);
    const r = await lumenia.reclaim(paid.link);
    // FAKETX1 made the link, FAKETX2 armed its return timer, FAKETX3 is the reclaim
    expect(r.txHash).toBe("FAKETX3");
    expect(r.explorerUrl).toBe("https://testnet.nearblocks.io/txns/FAKETX3");
    expect(r.receipt).toMatchObject({ receipt_id: paid.receipt.receipt_id, status: "Reclaimed", reclaim_tx_hash: "FAKETX3" });
    expect(chain.usdc).toBe(20_000_000n);
    expect((await lumenia.linkStatus(paid.publicKey)).status).toBe("Reclaimed");
  });

  it("refuses to reclaim another funder's drop", async () => {
    const { chain, lumenia, advance } = setup();
    const paid = await lumenia.createPayLink({ amountUsdc: 1, expiresHours: 1 });
    chain.drops.get(paid.publicKey)!.funder = "someone-else.testnet";
    advance(2 * 3_600_000);
    await expect(lumenia.reclaim(paid.publicKey)).rejects.toThrow(/Only the funder someone-else.testnet/);
  });
});

describe("balances, receipts, links", () => {
  it("reports balances, registration and the budget", async () => {
    const { chain, lumenia } = setup();
    chain.near = null;
    const b = await lumenia.balances();
    expect(b).toMatchObject({ funder: FUNDER, accountExists: false, near: null, usdc: { balance: "20.00", registered: true }, contract: { id: CONTRACT, registeredOnUsdc: true } });
  });

  it("lists receipts newest first, filters by since, limits, and exports CSV without secrets", async () => {
    const { lumenia, advance } = setup();
    await lumenia.createPayLink({ amountUsdc: 1, memo: "first" });
    advance(3_600_000);
    await lumenia.createPayLink({ amountUsdc: 2, memo: "second" });
    const all = await lumenia.listReceipts();
    expect(all.map((r) => r.memo)).toEqual(["second", "first"]);
    expect(await lumenia.listReceipts({ since: "2026-11-11T12:30:00Z" })).toHaveLength(1);
    expect(await lumenia.listReceipts({ limit: 1 })).toHaveLength(1);
    await expect(lumenia.listReceipts({ since: "yesterday" })).rejects.toThrow(/ISO 8601/);
    const csv = await lumenia.receiptsCsv();
    expect(csv.split("\r\n")[0]).toMatch(/^receipt_id,created_at,amount_usdc/);
    expect(csv).toContain(",2.00,second,");
    expect(csv).not.toContain("#ed25519:");
    const links = lumenia.links();
    expect(links).toHaveLength(2);
    expect(links[0]?.link).toMatch(/#ed25519:/);
  });

  it("refresh re-reads unsettled receipts from the chain", async () => {
    const { chain, lumenia } = setup();
    const paid = await lumenia.createPayLink({ amountUsdc: 1 });
    chain.drops.get(paid.publicKey)!.status = "Reclaimed";
    expect((await lumenia.listReceipts())[0]?.status).toBe("Open");
    expect((await lumenia.listReceipts({ refresh: true }))[0]?.status).toBe("Reclaimed");
  });

  it("register is idempotent", async () => {
    const { chain, lumenia } = setup();
    expect(await lumenia.register()).toEqual({ alreadyRegistered: true, txHash: null, explorerUrl: null });
    chain.funderRegistered = false;
    const r = await lumenia.register();
    expect(r.alreadyRegistered).toBe(false);
    expect(r.txHash).toBe("FAKETX1");
  });
});

describe("config guard rails", () => {
  it("refuses mainnet", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig({ NEAR_NETWORK: "mainnet" })).toThrow(/testnet-only/);
    expect(loadConfig({}).funderAccountId).toBe(FUNDER);
    expect(loadConfig({ DAILY_BUDGET_USDC: "12.5" }).dailyBudgetUnits).toBe(12_500_000n);
    expect(() => loadConfig({ DAILY_BUDGET_USDC: "lots" })).toThrow(/DAILY_BUDGET_USDC/);
    expect(() => loadConfig({ WEB_ORIGIN: "https://x.test/path" })).toThrow(/WEB_ORIGIN/);
    expect(() => loadConfig({ FUNDER_ACCOUNT_ID: "Not Valid" })).toThrow(/FUNDER_ACCOUNT_ID/);
  });

  it("LumeniaError is an Error", () => {
    expect(new LumeniaError("x")).toBeInstanceOf(Error);
  });
});

describe("createPayLinks (batch)", () => {
  const payouts = [
    { label: "Ali, courier", amountUsdc: 2.5, memo: "rent" },
    { label: "Bea", amountUsdc: "0.10" },
    { label: "Can", amountUsdc: 7, memo: "logo" },
  ];

  it("funds every payout in one ft_transfer_call with 300 Tgas, receipts written first with labels and a shared batch_id", async () => {
    const { chain, store, lumenia } = setup();
    let before: string[] = [];
    chain.onTransfer = () => (before = store.all().map((r) => `${r.label}|${r.status}|${r.batch_id ? "batch" : "nobatch"}|${r.link ? "link" : "nolink"}`));
    const r = await lumenia.createPayLinks({ payouts, expiresHours: 48, reference: "payroll-11" });
    expect(before.sort()).toEqual(["Ali, courier|Submitting|batch|link", "Bea|Submitting|batch|link", "Can|Submitting|batch|link"]);
    expect(chain.calls.filter((c) => c === "ft_transfer_call")).toHaveLength(1);
    expect(chain.lastGas).toBe(300_000_000_000_000n);
    expect(chain.lastMsg?.expires_in_s).toBe(48 * 3600);
    expect((chain.lastMsg?.drops as unknown[]).length).toBe(3);
    expect(r.count).toBe(3);
    expect(r.totalUsdc).toBe("9.60");
    expect(r.txHash).toBe("FAKETX1");
    expect(r.explorerUrl).toBe("https://testnet.nearblocks.io/txns/FAKETX1");
    expect(r.batchId).toMatch(/^batch_/);
    expect(r.expiresAt).toBe("2026-11-13T12:00:00.000Z");
    expect(r.instruction).toMatch(/Send each link to its own person/);
    expect(r.payouts.map((p) => p.label)).toEqual(["Ali, courier", "Bea", "Can"]);
    expect(new Set(r.payouts.map((p) => p.publicKey)).size).toBe(3);
    for (const p of r.payouts) {
      expect(p.link).toMatch(/^https:\/\/near\.lumenia\.test\/c#ed25519:/);
      expect(parseLinkOrKey(p.link).publicKey).toBe(p.publicKey);
      expect(p.receipt).toMatchObject({ status: "Open", batch_id: r.batchId, create_tx_hash: "FAKETX1", reference: "payroll-11", label: p.label });
      expect(chain.drops.get(p.publicKey)?.amount).toBe(p.receipt.amount_units);
    }
    expect(chain.drops.get(r.payouts[0]!.publicKey)?.memo).toBe("rent");
    expect(chain.usdc).toBe(20_000_000n - 9_600_000n);
    const b = await lumenia.balances();
    expect(b.budget.spentLast24hUsdc).toBe("9.60");
    const csv = await lumenia.receiptsCsv();
    expect(csv).toContain(`,"Ali, courier",${r.batchId},`);
    expect(store.findByBatchId(r.batchId)).toHaveLength(3);
    // a 48 h life is longer than one timer covers: nothing armed, and the instruction says reclaim
    expect(chain.calls.some((c) => c.startsWith("arm_return"))).toBe(false);
    expect(r.returnTimer?.armed).toBe(false);
  });

  it("arms ONE return timer for a whole batch whose life it covers", async () => {
    const { chain, lumenia } = setup();
    const r = await lumenia.createPayLinks({ payouts, expiresHours: 2 });
    expect(chain.arms).toEqual([{ publicKeys: r.payouts.map((p) => p.publicKey), gasTgas: armReturnTgas(2 * 3600, 3) }]);
    expect(r.returnTimer).toMatchObject({ armed: true, gasTgas: armReturnTgas(2 * 3600, 3) });
    expect(r.instruction).toMatch(/Send each link to its own person.*comes back to this account by itself/);
  });

  it("validates rows before touching the chain: labels, minimum, per-link max, count, memo", async () => {
    const { chain, lumenia } = setup();
    await expect(lumenia.createPayLinks({ payouts: [] })).rejects.toThrow(/at least one row/);
    await expect(lumenia.createPayLinks({ payouts: [{ label: " ", amountUsdc: 1 }] })).rejects.toThrow(/payout 1 needs a label/);
    await expect(lumenia.createPayLinks({ payouts: [{ label: "A", amountUsdc: 1 }, { label: "A", amountUsdc: 1 }] })).rejects.toThrow(/repeats the label/);
    await expect(lumenia.createPayLinks({ payouts: [{ label: "A", amountUsdc: 0.09 }] })).rejects.toThrow(/at least 0.10 USDC/);
    await expect(lumenia.createPayLinks({ payouts: [{ label: "A", amountUsdc: 20.01 }] })).rejects.toThrow(/above the per-link maximum/);
    await expect(lumenia.createPayLinks({ payouts: [{ label: "A", amountUsdc: "1.234" }] })).rejects.toThrow(/payout 1 \("A"\): amount/);
    await expect(lumenia.createPayLinks({ payouts: [{ label: "A", amountUsdc: 1, memo: "x".repeat(65) }] })).rejects.toThrow(/memo/);
    const many = Array.from({ length: 31 }, (_, i) => ({ label: `p${i}`, amountUsdc: 0.1 }));
    await expect(lumenia.createPayLinks({ payouts: many })).rejects.toThrow(/at most 30 payouts/);
    await expect(lumenia.createPayLinks({ payouts, expiresHours: 0 })).rejects.toThrow(/expiresHours/);
    expect(chain.calls).toHaveLength(0);
  });

  it("counts the batch total against the daily budget and the funder's balance", async () => {
    const { chain, lumenia } = setup();
    chain.usdc = 1_000_000_000n;
    const twenty = (label: string) => ({ label, amountUsdc: 20 });
    await expect(lumenia.createPayLinks({ payouts: [twenty("a"), twenty("b"), { label: "c", amountUsdc: 10.01 }] })).rejects.toThrow(
      /paying 50.01 \(the batch total\) USDC would exceed the daily budget of 50.00 USDC/,
    );
    chain.usdc = 9_000_000n;
    await expect(lumenia.createPayLinks({ payouts })).rejects.toThrow(/Insufficient USDC: .* holds 9.00 USDC and the batch needs 9.60/);
    expect(chain.calls.filter((c) => c === "ft_transfer_call")).toHaveLength(0);
  });

  it("is all or nothing: a refund by the escrow marks every receipt Failed, and the budget forgets it", async () => {
    const { chain, store, lumenia } = setup();
    chain.keepOnlyUnits = 0n;
    await expect(lumenia.createPayLinks({ payouts })).rejects.toThrow(/refused the batch and refunded the whole amount/);
    expect(store.all().map((r) => r.status)).toEqual(["Failed", "Failed", "Failed"]);
    expect(store.all().every((r) => r.link?.includes("#ed25519:"))).toBe(true);
    expect((await lumenia.balances()).budget.spentLast24hUsdc).toBe("0.00");
    chain.throwOnTransfer = { message: "timeout", landed: false };
    await expect(lumenia.createPayLinks({ payouts, reference: "r2" })).rejects.toThrow(/Batch deposit failed, nothing was spent: timeout/);
    expect(store.all().filter((r) => r.reference === "r2").map((r) => r.status)).toEqual(["Failed", "Failed", "Failed"]);
  });

  it("recovers a batch whose RPC call failed after landing", async () => {
    const { chain, lumenia } = setup();
    chain.throwOnTransfer = { message: "socket hang up", landed: true };
    const r = await lumenia.createPayLinks({ payouts });
    expect(r.note).toMatch(/confirmed on chain/);
    expect(r.txHash).toBeNull();
    expect(r.payouts.map((p) => p.receipt.status)).toEqual(["Open", "Open", "Open"]);
  });

  it("is idempotent on the batch reference", async () => {
    const { chain, lumenia } = setup();
    const a = await lumenia.createPayLinks({ payouts, reference: "payroll-12" });
    const b = await lumenia.createPayLinks({ payouts, reference: "payroll-12" });
    expect(b.note).toMatch(/instead of paying twice/);
    expect(b.payouts.map((p) => p.link)).toEqual(a.payouts.map((p) => p.link));
    expect(chain.calls.filter((c) => c === "ft_transfer_call")).toHaveLength(1);
  });

  it("status and reclaim work per payout afterwards", async () => {
    const { chain, lumenia, advance } = setup();
    const r = await lumenia.createPayLinks({ payouts, expiresHours: 1 });
    const bea = r.payouts[1]!;
    chain.drops.get(bea.publicKey)!.status = "Claimed";
    chain.drops.get(bea.publicKey)!.claimed_to = "bea.testnet";
    expect((await lumenia.linkStatus(bea.link)).status).toBe("Claimed to bea.testnet");
    advance(2 * 3_600_000);
    const rc = await lumenia.reclaim(r.payouts[0]!.publicKey);
    expect(rc.receipt).toMatchObject({ label: "Ali, courier", status: "Reclaimed", batch_id: r.batchId });
    const list = await lumenia.listReceipts({ refresh: true });
    expect(list.map((x) => `${x.label}:${x.status}`).sort()).toEqual(["Ali, courier:Reclaimed", "Bea:Claimed to bea.testnet", "Can:Expired"]);
  });
});
