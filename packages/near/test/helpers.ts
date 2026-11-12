import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LumeniaConfig } from "../src/config.js";
import type { ChainPort, NearBalance, StorageBalance, TxOutcome } from "../src/near.js";
import { LinkStore } from "../src/store.js";

export const FUNDER = "lumenia-funder.testnet";
export const CONTRACT = "lumenia-near.testnet";
export const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

export function testConfig(overrides: Partial<LumeniaConfig> = {}): LumeniaConfig {
  return {
    network: "testnet",
    rpcUrls: ["http://127.0.0.1:1"],
    contractId: CONTRACT,
    usdcContractId: USDC,
    funderAccountId: FUNDER,
    funderPrivateKey: null,
    funderKeyFile: "/nonexistent/key.json",
    webOrigin: "https://near.lumenia.test",
    dailyBudgetUnits: 50_000_000n,
    maxLinkUnits: 20_000_000n,
    dataDir: mkdtempSync(join(tmpdir(), "lumenia-test-")),
    oneClickUrl: "https://1click.invalid",
    explorerUrl: "https://testnet.nearblocks.io",
    ...overrides,
  };
}

export function tempStore(): LinkStore {
  return LinkStore.inDir(mkdtempSync(join(tmpdir(), "lumenia-store-")));
}

export interface FakeDrop {
  status: string | Record<string, unknown>;
  amount: string;
  funder: string;
  created_at_ns: string | number;
  expires_at_ns: string | number;
  claimed_to: string | null;
  memo: string | null;
}

/** An in-memory stand-in for the escrow contract + the USDC contract. */
export class FakeChain implements ChainPort {
  drops = new Map<string, FakeDrop>();
  usdc = 20_000_000n;
  funderRegistered = true;
  contractRegistered = true;
  near: NearBalance | null = { total: 10n * 10n ** 24n, available: 9n * 10n ** 24n };
  calls: string[] = [];
  txCounter = 0;
  /** Called with the parsed msg right before the fake deposit lands. */
  onTransfer: ((msg: Record<string, unknown>) => void) | null = null;
  /** Make the next deposit throw (RPC failure); `landed` decides whether the drop exists anyway. */
  throwOnTransfer: { message: string; landed: boolean } | null = null;
  /** Make the escrow keep only this many units of the next deposit (the rest is "refunded"). */
  keepOnlyUnits: bigint | null = null;
  failNextTx: string | null = null;
  /** Gas of the last ft_transfer_call, to check that a batch asks for 300 Tgas. */
  lastGas: bigint | null = null;
  /** The last msg handed to ft_transfer_call, parsed. */
  lastMsg: Record<string, unknown> | null = null;
  now: () => Date = () => new Date("2026-11-11T12:00:00.000Z");

  constructor(readonly funder = FUNDER) {}

  async getConfig(): Promise<unknown> {
    return { usdc: USDC, max_expiry_s: 604800 };
  }
  async getStats(): Promise<unknown> {
    return { drops: this.drops.size };
  }
  async getDrop(publicKey: string): Promise<unknown> {
    this.calls.push(`get_drop ${publicKey}`);
    return this.drops.get(publicKey) ?? null;
  }
  async ftBalanceOf(): Promise<bigint> {
    return this.usdc;
  }
  async storageBalanceOf(accountId: string): Promise<StorageBalance | null> {
    if (accountId === CONTRACT) return this.contractRegistered ? { total: "1250000000000000000000", available: "0" } : null;
    return this.funderRegistered ? { total: "1250000000000000000000", available: "0" } : null;
  }
  async nearBalance(): Promise<NearBalance | null> {
    return this.near;
  }
  private outcome(returnValue: string | null): TxOutcome {
    this.txCounter += 1;
    if (this.failNextTx) {
      const failure = this.failNextTx;
      this.failNextTx = null;
      return { txHash: `FAKETX${this.txCounter}`, returnValue: null, logs: [], failure };
    }
    return { txHash: `FAKETX${this.txCounter}`, returnValue, logs: [], failure: null };
  }
  async ftTransferCall(p: { amountUnits: bigint; msg: string; gas?: bigint }): Promise<TxOutcome> {
    this.calls.push("ft_transfer_call");
    this.lastGas = p.gas ?? null;
    const msg = JSON.parse(p.msg) as Record<string, unknown>;
    this.lastMsg = msg;
    this.onTransfer?.(msg);
    if (this.throwOnTransfer) {
      const t = this.throwOnTransfer;
      this.throwOnTransfer = null;
      if (t.landed) this.landAny(msg, p.amountUnits);
      throw new Error(t.message);
    }
    if (this.failNextTx) return this.outcome(null);
    if (Array.isArray(msg.drops)) return this.outcome(JSON.stringify(this.landBatch(msg, p.amountUnits).toString()));
    const kept = this.keepOnlyUnits ?? p.amountUnits;
    this.keepOnlyUnits = null;
    if (kept > 0n) this.land(msg, kept);
    return this.outcome(JSON.stringify(kept.toString()));
  }
  private landAny(msg: Record<string, unknown>, units: bigint): void {
    if (Array.isArray(msg.drops)) this.landBatch(msg, units);
    else this.land(msg, units);
  }
  /** Mirrors the contract's batch rules: 1..30 drops, each >= 0.10 USDC, sum == transferred, all or nothing. */
  private landBatch(msg: Record<string, unknown>, transferred: bigint): bigint {
    const drops = msg.drops as Array<{ public_key: string; amount: string; memo: string }>;
    if (this.keepOnlyUnits !== null) {
      this.keepOnlyUnits = null;
      return 0n;
    }
    const sum = drops.reduce((acc, d) => acc + BigInt(d.amount), 0n);
    if (drops.length < 1 || drops.length > 30 || sum !== transferred || drops.some((d) => BigInt(d.amount) < 100_000n)) return 0n;
    for (const d of drops) this.land({ public_key: d.public_key, expires_in_s: msg.expires_in_s, memo: d.memo }, BigInt(d.amount));
    return sum;
  }
  private land(msg: Record<string, unknown>, units: bigint): void {
    const nowMs = this.now().getTime();
    this.usdc -= units;
    this.drops.set(String(msg.public_key), {
      status: "Open",
      amount: units.toString(),
      funder: this.funder,
      created_at_ns: `${nowMs}000000`,
      expires_at_ns: `${nowMs + Number(msg.expires_in_s) * 1000}000000`,
      claimed_to: null,
      memo: typeof msg.memo === "string" ? msg.memo : null,
    });
  }
  async reclaim(publicKey: string): Promise<TxOutcome> {
    this.calls.push(`reclaim ${publicKey}`);
    const d = this.drops.get(publicKey);
    if (d) {
      d.status = "Reclaimed";
      this.usdc += BigInt(d.amount);
    }
    return this.outcome(null);
  }
  /** Make the next arm_return throw (an RPC failure). */
  failArm: string | null = null;
  /** Every arm_return: the links and the gas. */
  arms: Array<{ publicKeys: string[]; gasTgas: number }> = [];
  async armReturn(publicKeys: string[], gasTgas: number): Promise<{ txHash: string }> {
    this.calls.push(`arm_return ${publicKeys.length}`);
    if (this.failArm) {
      const message = this.failArm;
      this.failArm = null;
      throw new Error(message);
    }
    this.arms.push({ publicKeys, gasTgas });
    this.txCounter += 1;
    return { txHash: `FAKETX${this.txCounter}` };
  }
  async storageDeposit(): Promise<TxOutcome> {
    this.calls.push("storage_deposit");
    this.funderRegistered = true;
    return this.outcome(null);
  }
}
