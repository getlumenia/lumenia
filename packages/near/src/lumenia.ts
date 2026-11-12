// The library behind the MCP server and the CLI. One class, five money
// functions, one receipt log:
//   createPayLink   escrow USDC for a person and hand back a claim link
//   linkStatus      what the chain says about a link
//   reclaim         take an unclaimed, expired link's USDC back
//   balances        the funder's NEAR + USDC and the budget left
//   crossChainQuote dry 1Click quote (mainnet assets, informational)
import { randomUUID } from "node:crypto";
import { formatNear, formatUsdc, parseUsdcAmount } from "./amount.js";
import { BATCH_TRANSFER_CALL_GAS } from "./near.js";
import { buildBatchMsg, MAX_BATCH_DROPS, MIN_BATCH_DROP_UNITS } from "./batch.js";
import { checkBudget, spentInWindow } from "./budget.js";
import { loadConfig, resolveFunderKey, type Env, type LumeniaConfig } from "./config.js";
import { buildLink, newLinkKey, parseLinkOrKey, type LinkKey } from "./link.js";
import { NearChain, type ChainPort } from "./near.js";
import {
  buildQuoteRequest,
  requestDryQuote,
  summarizeQuote,
  type CrossChainQuote,
  type Destination,
} from "./oneclick.js";
import {
  mapDrop,
  publicReceipt,
  receiptsToCsv,
  type DropStatus,
  type PublicReceipt,
  type Receipt,
} from "./receipts.js";
import { armReturnTgas, returnTimerCoversS, returnTimerFits } from "./return-timer.js";
import { LinkStore } from "./store.js";

export const MIN_EXPIRES_HOURS = 1;
export const MAX_EXPIRES_HOURS = 168;
/** Eight hours: a life one return timer covers whole, so an unclaimed link comes home with no further signature. */
export const DEFAULT_EXPIRES_HOURS = 8;
export const MAX_MEMO_CHARS = 64;
export const MAX_REFERENCE_CHARS = 64;
/** Two identical payments inside this window are refused unless the caller says it is intended. */
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
/** A Submitting receipt older than this with no drop on chain is marked Failed. */
export const SUBMITTING_GRACE_MS = 2 * 60 * 1000;

export class LumeniaError extends Error {
  override name = "LumeniaError";
}

export interface PayLinkInput {
  amountUsdc: number | string;
  expiresHours?: number;
  memo?: string;
  /** Idempotency key: a second call with the same reference returns the first receipt instead of paying again. */
  reference?: string;
  allowDuplicate?: boolean;
}

/**
 * The link's return timer (the escrow's `arm_return`): armed right after the link exists, so that an
 * unclaimed link's USDC comes back to the funder by itself after the expiry. Not armed when the life
 * is longer than one transaction's gas keeps a timer awake, or when arming failed; the reason says so.
 */
export type ReturnTimer = { armed: true; txHash: string; explorerUrl: string; gasTgas: number } | { armed: false; reason: string };

export interface PayLinkResult {
  link: string;
  instruction: string;
  receipt: PublicReceipt;
  publicKey: string;
  txHash: string | null;
  explorerUrl: string | null;
  expiresAt: string;
  /** Set when a new link was made. */
  returnTimer?: ReturnTimer;
  /** Set when no new payment was made (idempotent replay). */
  note?: string;
}

export interface PayoutInput {
  /** Who this payout is for, in the sender's words ("Ali, courier"). Stored on the receipt, not on chain. */
  label: string;
  amountUsdc: number | string;
  memo?: string;
}

export interface PayManyInput {
  payouts: PayoutInput[];
  expiresHours?: number;
  /** Idempotency key for the whole batch. */
  reference?: string;
}

export interface PayoutResult {
  label: string;
  link: string;
  publicKey: string;
  receipt: PublicReceipt;
}

export interface PayManyResult {
  batchId: string;
  count: number;
  totalUsdc: string;
  txHash: string | null;
  explorerUrl: string | null;
  expiresAt: string;
  instruction: string;
  payouts: PayoutResult[];
  /** One timer for the whole batch, set when a new batch was made. */
  returnTimer?: ReturnTimer;
  note?: string;
}

export interface LinkStatusResult {
  publicKey: string;
  status: string;
  drop: DropStatus;
  receipt: PublicReceipt | null;
}

export interface ReclaimResult {
  receipt: PublicReceipt;
  txHash: string;
  explorerUrl: string;
}

export interface Balances {
  network: "testnet";
  funder: string;
  funderExplorerUrl: string;
  accountExists: boolean;
  near: { total: string; available: string } | null;
  usdc: { balance: string; units: string; registered: boolean };
  contract: { id: string; registeredOnUsdc: boolean };
  budget: { dailyBudgetUsdc: string; spentLast24hUsdc: string; remainingUsdc: string; maxLinkUsdc: string };
}

export interface LinkEntry {
  receipt_id: string;
  created_at: string;
  amount_usdc: string;
  memo: string;
  status: string;
  link: string | null;
  link_public_key: string;
  expires_at: string;
}

export interface LumeniaDeps {
  chain?: ChainPort;
  store?: LinkStore;
  now?: () => Date;
  fetch?: typeof fetch;
  keyFactory?: () => LinkKey;
}

export function payInstruction(expiresAt: string, timer?: ReturnTimer): string {
  const after = timer?.armed
    ? `If nobody claims it by ${expiresAt}, the USDC comes back to this account by itself: its return timer is armed (tx ${timer.txHash}), so nobody has to act. lumenia_reclaim also works after the expiry.`
    : `If nobody claims it by ${expiresAt}, call lumenia_reclaim with the link's public key to take the USDC back.`;
  return (
    "Send this link to the person. They open it in any browser; no wallet, no seed phrase and no gas needed. " +
    "The link IS the money: anyone holding it can claim, so send it over a private channel and do not post it. " +
    after
  );
}

export class Lumenia {
  readonly config: LumeniaConfig;
  readonly chain: ChainPort;
  readonly store: LinkStore;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly keyFactory: () => LinkKey;

  constructor(config: LumeniaConfig, deps: LumeniaDeps = {}) {
    this.config = config;
    this.chain = deps.chain ?? new NearChain(config, () => resolveFunderKey(config));
    this.store = deps.store ?? LinkStore.inDir(config.dataDir);
    this.now = deps.now ?? (() => new Date());
    this.fetchImpl = deps.fetch ?? fetch;
    this.keyFactory = deps.keyFactory ?? newLinkKey;
  }

  static fromEnv(env: Env = process.env, deps: LumeniaDeps = {}): Lumenia {
    return new Lumenia(loadConfig(env), deps);
  }

  txUrl(hash: string): string {
    return `${this.config.explorerUrl}/txns/${hash}`;
  }

  accountUrl(id: string): string {
    return `${this.config.explorerUrl}/address/${id}`;
  }

  // ---------------------------------------------------------------- pay

  async createPayLink(input: PayLinkInput): Promise<PayLinkResult> {
    const amountUnits = parseUsdcAmount(input.amountUsdc);
    const amountText = formatUsdc(amountUnits);
    const expiresHours = input.expiresHours ?? DEFAULT_EXPIRES_HOURS;
    if (!Number.isInteger(expiresHours) || expiresHours < MIN_EXPIRES_HOURS || expiresHours > MAX_EXPIRES_HOURS) {
      throw new LumeniaError(
        `expiresHours must be a whole number between ${MIN_EXPIRES_HOURS} and ${MAX_EXPIRES_HOURS}, got ${String(input.expiresHours)}`,
      );
    }
    const memo = (input.memo ?? "").trim();
    if (memo.length > MAX_MEMO_CHARS) throw new LumeniaError(`memo must be at most ${MAX_MEMO_CHARS} characters`);
    if (/[\r\n]/.test(memo)) throw new LumeniaError("memo must be a single line");
    const reference = input.reference?.trim() || null;
    if (reference && reference.length > MAX_REFERENCE_CHARS) {
      throw new LumeniaError(`reference must be at most ${MAX_REFERENCE_CHARS} characters`);
    }

    const now = this.now();
    const receipts = this.store.all();

    // 1. Idempotency: the receipt log is the guard against paying twice.
    if (reference) {
      const existing = receipts.find((r) => r.reference === reference && r.status !== "Failed");
      if (existing) {
        return {
          ...this.resultFromReceipt(existing),
          note: `No new payment: receipt ${existing.receipt_id} already carries reference "${reference}". Returning it instead of paying twice.`,
        };
      }
    }
    if (!input.allowDuplicate) {
      const dup = receipts.find(
        (r) =>
          r.status !== "Failed" &&
          r.amount_units === amountUnits.toString() &&
          r.memo === memo &&
          (r.reference ?? null) === reference &&
          now.getTime() - Date.parse(r.created_at) < DUPLICATE_WINDOW_MS,
      );
      if (dup) {
        const ago = Math.max(0, Math.round((now.getTime() - Date.parse(dup.created_at)) / 1000));
        throw new LumeniaError(
          `Refused: an identical payment (${amountText} USDC, memo "${memo}") was created ${ago} s ago as receipt ${dup.receipt_id}` +
            ` with link public key ${dup.link_public_key}. If a second payment is intended, pass a distinct reference or allowDuplicate=true. Nothing was spent.`,
        );
      }
    }

    // 2. Budget.
    const budget = checkBudget({
      amountUnits,
      receipts,
      now,
      dailyBudgetUnits: this.config.dailyBudgetUnits,
      maxLinkUnits: this.config.maxLinkUnits,
    });
    if (!budget.ok) throw new LumeniaError(budget.reason ?? "budget refused");

    // 3. Pre-flight reads: nothing has been signed yet.
    const funder = this.config.funderAccountId;
    const [funderStorage, usdcBalance, contractStorage] = await Promise.all([
      this.chain.storageBalanceOf(funder),
      this.chain.ftBalanceOf(funder),
      this.chain.storageBalanceOf(this.config.contractId),
    ]);
    if (!funderStorage) {
      throw new LumeniaError(
        `${funder} is not registered on the USDC contract ${this.config.usdcContractId}; run "lumenia register" ` +
          `(a 0.00125 NEAR storage deposit) first. Nothing was spent.`,
      );
    }
    if (usdcBalance < amountUnits) {
      throw new LumeniaError(
        `Insufficient USDC: ${funder} holds ${formatUsdc(usdcBalance)} USDC and the link needs ${amountText}. Nothing was spent.`,
      );
    }
    if (!contractStorage) {
      throw new LumeniaError(
        `The escrow contract ${this.config.contractId} is not registered on the USDC contract, so the deposit would bounce. Nothing was spent.`,
      );
    }

    // 4. Fresh key, link and receipt. The receipt (with the secret link) is on
    //    disk BEFORE the deposit is broadcast, so a crash cannot lose the link.
    const key = this.keyFactory();
    const link = buildLink(this.config.webOrigin, key.secretKey);
    const expiresAt = new Date(now.getTime() + expiresHours * 3_600_000).toISOString();
    const receipt: Receipt = {
      receipt_id: `rcpt_${randomUUID()}`,
      created_at: now.toISOString(),
      amount_usdc: amountText,
      amount_units: amountUnits.toString(),
      memo,
      label: null,
      batch_id: null,
      reference,
      link_public_key: key.publicKey,
      funder_account: funder,
      create_tx_hash: null,
      explorer_url: null,
      expires_at: expiresAt,
      status: "Submitting",
      claimed_to: null,
      claim_tx_hash: null,
      reclaim_tx_hash: null,
      updated_at: now.toISOString(),
      error: null,
      network: "testnet",
      link,
    };
    this.store.upsert(receipt);

    // 5. The deposit: ft_transfer_call(escrow, amount, msg) with 1 yoctoNEAR.
    const msg = JSON.stringify({ public_key: key.publicKey, expires_in_s: expiresHours * 3600, memo });
    let outcome;
    try {
      outcome = await this.chain.ftTransferCall({ amountUnits, msg });
    } catch (e) {
      const message = (e as Error).message;
      const drop = await this.safeDrop(key.publicKey);
      if (drop && drop.kind !== "NotFound") {
        // The RPC failed after the deposit went through: the link is live.
        this.finish(receipt, { status: drop.label, expires_at: drop.expiresAt ?? expiresAt, error: `confirmed on chain, but the RPC call failed afterwards: ${message}` });
        return { ...this.resultFromReceipt(receipt), note: "The deposit is confirmed on chain although the RPC call failed afterwards; the transaction hash is unknown." };
      }
      this.finish(receipt, { status: "Failed", error: message });
      throw new LumeniaError(`Deposit failed, nothing was spent: ${message} (receipt ${receipt.receipt_id})`);
    }
    if (outcome.failure) {
      this.finish(receipt, { status: "Failed", error: outcome.failure, create_tx_hash: outcome.txHash || null, explorer_url: outcome.txHash ? this.txUrl(outcome.txHash) : null });
      throw new LumeniaError(`Deposit transaction failed, nothing was spent: ${outcome.failure} (tx ${outcome.txHash || "unknown"})`);
    }
    const used = parseUsedAmount(outcome.returnValue);
    if (used !== null && used !== amountUnits) {
      const detail = outcome.logs.length ? ` Logs: ${outcome.logs.join(" | ")}` : "";
      this.finish(receipt, { status: "Failed", error: `escrow kept ${formatUsdc(used)} of ${amountText} USDC; the rest was refunded.${detail}`, create_tx_hash: outcome.txHash || null, explorer_url: outcome.txHash ? this.txUrl(outcome.txHash) : null });
      throw new LumeniaError(`The escrow contract refused the deposit and the USDC was refunded (tx ${outcome.txHash}).${detail}`);
    }

    // 6. Confirm the drop the way the recipient will see it.
    const drop = await this.safeDrop(key.publicKey);
    if (!drop || drop.kind === "NotFound") {
      this.finish(receipt, { create_tx_hash: outcome.txHash || null, explorer_url: outcome.txHash ? this.txUrl(outcome.txHash) : null, error: "deposit transaction succeeded but get_drop shows no drop yet; check lumenia_link_status" });
      throw new LumeniaError(`The deposit transaction ${outcome.txHash} succeeded but the contract shows no drop for ${key.publicKey} yet; check lumenia_link_status in a moment (receipt ${receipt.receipt_id}).`);
    }
    this.finish(receipt, { status: drop.label, expires_at: drop.expiresAt ?? expiresAt, create_tx_hash: outcome.txHash || null, explorer_url: outcome.txHash ? this.txUrl(outcome.txHash) : null, claimed_to: drop.claimedTo });
    // 7. The return timer, in a transaction of its own (a pending timer keeps it short of FINAL).
    const returnTimer = await this.armReturnTimer([key.publicKey], expiresHours * 3600);
    return { ...this.resultFromReceipt(receipt, returnTimer), returnTimer };
  }

  /** Arms one return timer for links of this funder that share a life. Never throws: a failure is the reason. */
  private async armReturnTimer(publicKeys: string[], lifeS: number): Promise<ReturnTimer> {
    if (!returnTimerFits(lifeS, publicKeys.length)) {
      const hours = Math.floor(returnTimerCoversS(1000, publicKeys.length) / 3600);
      return {
        armed: false,
        reason: `a life of ${describeDuration(lifeS * 1000)} is longer than one transaction's gas keeps a return timer awake (about ${hours} hours for ${publicKeys.length === 1 ? "one link" : `${publicKeys.length} links`}); after the expiry, call lumenia_reclaim, and anyone may also send it home with the escrow's return_expired`,
      };
    }
    const gasTgas = armReturnTgas(lifeS, publicKeys.length);
    try {
      const { txHash } = await this.chain.armReturn(publicKeys, gasTgas);
      return { armed: true, txHash, explorerUrl: this.txUrl(txHash), gasTgas };
    } catch (e) {
      return { armed: false, reason: `the return timer could not be armed (${(e as Error).message}); after the expiry, call lumenia_reclaim` };
    }
  }

  private resultFromReceipt(receipt: Receipt, timer?: ReturnTimer): PayLinkResult {
    return {
      link: receipt.link ?? "",
      instruction: payInstruction(receipt.expires_at, timer),
      receipt: publicReceipt(receipt),
      publicKey: receipt.link_public_key,
      txHash: receipt.create_tx_hash,
      explorerUrl: receipt.explorer_url,
      expiresAt: receipt.expires_at,
    };
  }

  private finish(receipt: Receipt, patch: Partial<Receipt>): void {
    Object.assign(receipt, patch, { updated_at: this.now().toISOString() });
    this.store.upsert(receipt);
  }

  private async safeDrop(publicKey: string): Promise<DropStatus | null> {
    try {
      return mapDrop(await this.chain.getDrop(publicKey), this.now());
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------- pay many

  /**
   * Fund up to 30 links in ONE ft_transfer_call. One fresh key per payout, every
   * receipt written (Submitting, with its label and a shared batch_id) before the
   * broadcast, one transaction hash shared by all. The contract keeps all or
   * nothing: on any failure the whole amount is refunded and every receipt is
   * marked Failed.
   */
  async createPayLinks(input: PayManyInput): Promise<PayManyResult> {
    const payouts = input.payouts;
    if (!Array.isArray(payouts) || payouts.length === 0) throw new LumeniaError("payouts must hold at least one row");
    if (payouts.length > MAX_BATCH_DROPS) {
      throw new LumeniaError(`at most ${MAX_BATCH_DROPS} payouts per batch, got ${payouts.length}; split the list. Nothing was spent.`);
    }
    const expiresHours = input.expiresHours ?? DEFAULT_EXPIRES_HOURS;
    if (!Number.isInteger(expiresHours) || expiresHours < MIN_EXPIRES_HOURS || expiresHours > MAX_EXPIRES_HOURS) {
      throw new LumeniaError(
        `expiresHours must be a whole number between ${MIN_EXPIRES_HOURS} and ${MAX_EXPIRES_HOURS}, got ${String(input.expiresHours)}`,
      );
    }
    const reference = input.reference?.trim() || null;
    if (reference && reference.length > MAX_REFERENCE_CHARS) {
      throw new LumeniaError(`reference must be at most ${MAX_REFERENCE_CHARS} characters`);
    }
    const labels = new Set<string>();
    const rows = payouts.map((p, i) => {
      const where = `payout ${i + 1}`;
      const label = (p.label ?? "").toString().trim();
      if (!label) throw new LumeniaError(`${where} needs a label (who it is for)`);
      if (label.length > MAX_MEMO_CHARS) throw new LumeniaError(`${where} label must be at most ${MAX_MEMO_CHARS} characters`);
      if (labels.has(label)) throw new LumeniaError(`${where} repeats the label "${label}"; labels must be distinct within a batch`);
      labels.add(label);
      let amountUnits: bigint;
      try {
        amountUnits = parseUsdcAmount(p.amountUsdc);
      } catch (e) {
        throw new LumeniaError(`${where} ("${label}"): ${(e as Error).message}`);
      }
      if (amountUnits < MIN_BATCH_DROP_UNITS) {
        throw new LumeniaError(
          `${where} ("${label}") is ${formatUsdc(amountUnits)} USDC; each payout in a batch must be at least ${formatUsdc(MIN_BATCH_DROP_UNITS)} USDC. Nothing was spent.`,
        );
      }
      if (amountUnits > this.config.maxLinkUnits) {
        throw new LumeniaError(
          `${where} ("${label}") is ${formatUsdc(amountUnits)} USDC, above the per-link maximum of ${formatUsdc(this.config.maxLinkUnits)} USDC (MAX_LINK_USDC). Nothing was spent.`,
        );
      }
      const memo = (p.memo ?? "").trim();
      if (memo.length > MAX_MEMO_CHARS) throw new LumeniaError(`${where} ("${label}") memo must be at most ${MAX_MEMO_CHARS} characters`);
      if (/[\r\n]/.test(memo)) throw new LumeniaError(`${where} ("${label}") memo must be a single line`);
      return { label, amountUnits, memo };
    });
    const totalUnits = rows.reduce((sum, r) => sum + r.amountUnits, 0n);
    const totalText = formatUsdc(totalUnits);

    const now = this.now();
    const receipts = this.store.all();

    // 1. Idempotency on the batch reference.
    if (reference) {
      const existing = receipts.filter((r) => r.reference === reference && r.status !== "Failed");
      if (existing.length > 0) {
        return {
          ...this.manyResultFromReceipts(existing),
          note: `No new payment: ${existing.length} receipt(s) already carry reference "${reference}". Returning them instead of paying twice.`,
        };
      }
    }

    // 2. Budget: the whole batch counts against the rolling 24 hours.
    const budget = checkBudget({ amountUnits: totalUnits, receipts, now, dailyBudgetUnits: this.config.dailyBudgetUnits });
    if (!budget.ok) throw new LumeniaError((budget.reason ?? "budget refused").replace("paying " + totalText, `paying ${totalText} (the batch total)`));

    // 3. Pre-flight reads.
    const funder = this.config.funderAccountId;
    const [funderStorage, usdcBalance, contractStorage] = await Promise.all([
      this.chain.storageBalanceOf(funder),
      this.chain.ftBalanceOf(funder),
      this.chain.storageBalanceOf(this.config.contractId),
    ]);
    if (!funderStorage) {
      throw new LumeniaError(`${funder} is not registered on the USDC contract; run "lumenia register" first. Nothing was spent.`);
    }
    if (usdcBalance < totalUnits) {
      throw new LumeniaError(`Insufficient USDC: ${funder} holds ${formatUsdc(usdcBalance)} USDC and the batch needs ${totalText}. Nothing was spent.`);
    }
    if (!contractStorage) {
      throw new LumeniaError(`The escrow contract ${this.config.contractId} is not registered on the USDC contract. Nothing was spent.`);
    }

    // 4. Keys, links and receipts, all on disk before the broadcast.
    const batchId = `batch_${randomUUID()}`;
    const expiresAt = new Date(now.getTime() + expiresHours * 3_600_000).toISOString();
    const made = rows.map((row) => {
      const key = this.keyFactory();
      const link = buildLink(this.config.webOrigin, key.secretKey);
      const receipt: Receipt = {
        receipt_id: `rcpt_${randomUUID()}`,
        created_at: now.toISOString(),
        amount_usdc: formatUsdc(row.amountUnits),
        amount_units: row.amountUnits.toString(),
        memo: row.memo,
        label: row.label,
        batch_id: batchId,
        reference,
        link_public_key: key.publicKey,
        funder_account: funder,
        create_tx_hash: null,
        explorer_url: null,
        expires_at: expiresAt,
        status: "Submitting",
        claimed_to: null,
        claim_tx_hash: null,
        reclaim_tx_hash: null,
        updated_at: now.toISOString(),
        error: null,
        network: "testnet",
        link,
      };
      return { row, key, link, receipt };
    });
    this.store.upsertMany(made.map((m) => m.receipt));

    // 5. One ft_transfer_call for the whole batch (300 Tgas, 1 yoctoNEAR).
    const { msg, totalUnits: msgTotal } = buildBatchMsg(
      made.map((m) => ({ publicKey: m.key.publicKey, amountUnits: m.row.amountUnits, memo: m.row.memo })),
      expiresHours * 3600,
    );
    if (msgTotal !== totalUnits) throw new LumeniaError("internal: batch total mismatch");
    const all = made.map((m) => m.receipt);
    const firstKey = made[0]?.key.publicKey ?? "";
    let outcome;
    try {
      outcome = await this.chain.ftTransferCall({ amountUnits: totalUnits, msg: JSON.stringify(msg), gas: BATCH_TRANSFER_CALL_GAS });
    } catch (e) {
      const message = (e as Error).message;
      const first = await this.safeDrop(firstKey);
      if (first && first.kind !== "NotFound") {
        await this.confirmBatch(made, null, `confirmed on chain, but the RPC call failed afterwards: ${message}`);
        return {
          ...this.manyResultFromReceipts(all),
          note: "The deposit is confirmed on chain although the RPC call failed afterwards; the transaction hash is unknown.",
        };
      }
      this.finishMany(all, { status: "Failed", error: message });
      throw new LumeniaError(`Batch deposit failed, nothing was spent: ${message} (batch ${batchId})`);
    }
    const txPatch = {
      create_tx_hash: outcome.txHash || null,
      explorer_url: outcome.txHash ? this.txUrl(outcome.txHash) : null,
    };
    if (outcome.failure) {
      this.finishMany(all, { status: "Failed", error: outcome.failure, ...txPatch });
      throw new LumeniaError(`Batch deposit transaction failed, nothing was spent: ${outcome.failure} (tx ${outcome.txHash || "unknown"})`);
    }
    const used = parseUsedAmount(outcome.returnValue);
    if (used !== null && used !== totalUnits) {
      const detail = outcome.logs.length ? ` Logs: ${outcome.logs.join(" | ")}` : "";
      this.finishMany(all, { status: "Failed", error: `escrow kept ${formatUsdc(used)} of ${totalText} USDC; the batch was refunded in full.${detail}`, ...txPatch });
      throw new LumeniaError(`The escrow contract refused the batch and refunded the whole amount (tx ${outcome.txHash}).${detail}`);
    }
    await this.confirmBatch(made, outcome.txHash || null, null);
    // One return timer for the whole batch: one funder, one life, at most 30 links.
    const returnTimer = await this.armReturnTimer(
      made.map((m) => m.key.publicKey),
      expiresHours * 3600,
    );
    return { ...this.manyResultFromReceipts(all, returnTimer), returnTimer };
  }

  /** Read every drop of a batch back and settle its receipt. */
  private async confirmBatch(made: Array<{ key: LinkKey; receipt: Receipt }>, txHash: string | null, note: string | null): Promise<void> {
    const drops = await Promise.all(made.map((m) => this.safeDrop(m.key.publicKey)));
    made.forEach((m, i) => {
      const drop = drops[i] ?? null;
      const patch: Partial<Receipt> = {
        create_tx_hash: txHash,
        explorer_url: txHash ? this.txUrl(txHash) : null,
        error: note,
      };
      if (drop && drop.kind !== "NotFound") {
        patch.status = drop.label;
        patch.claimed_to = drop.claimedTo;
        if (drop.expiresAt) patch.expires_at = drop.expiresAt;
      } else {
        patch.error = "deposit transaction succeeded but get_drop shows no drop yet; check lumenia_link_status";
      }
      Object.assign(m.receipt, patch, { updated_at: this.now().toISOString() });
    });
    this.store.upsertMany(made.map((m) => m.receipt));
  }

  private finishMany(receipts: Receipt[], patch: Partial<Receipt>): void {
    const updated_at = this.now().toISOString();
    for (const r of receipts) Object.assign(r, patch, { updated_at });
    this.store.upsertMany(receipts);
  }

  private manyResultFromReceipts(receipts: Receipt[], timer?: ReturnTimer): PayManyResult {
    const first = receipts[0];
    const totalUnits = receipts.reduce((sum, r) => sum + BigInt(r.amount_units), 0n);
    const expiresAt = first?.expires_at ?? this.now().toISOString();
    return {
      batchId: first?.batch_id ?? "",
      count: receipts.length,
      totalUsdc: formatUsdc(totalUnits),
      txHash: first?.create_tx_hash ?? null,
      explorerUrl: first?.explorer_url ?? null,
      expiresAt,
      instruction: `Send each link to its own person (the label says who). ${payInstruction(expiresAt, timer)}`,
      payouts: receipts.map((r) => ({
        label: r.label ?? "",
        link: r.link ?? "",
        publicKey: r.link_public_key,
        receipt: publicReceipt(r),
      })),
    };
  }

  // ------------------------------------------------------------- status

  async linkStatus(linkOrPublicKey: string): Promise<LinkStatusResult> {
    const { publicKey } = parseLinkOrKey(linkOrPublicKey);
    const now = this.now();
    const drop = mapDrop(await this.chain.getDrop(publicKey), now);
    const stored = this.store.findByPublicKey(publicKey) ?? null;
    const receipt = stored ? this.reconcile(stored, drop, now) : null;
    const status = drop.kind === "NotFound" && receipt ? receipt.status : drop.label;
    return { publicKey, status, drop, receipt: receipt ? publicReceipt(receipt) : null };
  }

  /** Bring a stored receipt in line with what the chain says; saves only on change. */
  private reconcile(receipt: Receipt, drop: DropStatus, now: Date): Receipt {
    const patch: Partial<Receipt> = {};
    if (drop.kind === "NotFound") {
      if (receipt.status === "Submitting" && now.getTime() - Date.parse(receipt.created_at) > SUBMITTING_GRACE_MS) {
        patch.status = "Failed";
        patch.error = "no drop on chain for this key after the grace period; the deposit never confirmed";
      }
    } else {
      if (receipt.status !== drop.label) patch.status = drop.label;
      if (drop.claimedTo !== receipt.claimed_to) patch.claimed_to = drop.claimedTo;
      if (drop.expiresAt && drop.expiresAt !== receipt.expires_at) patch.expires_at = drop.expiresAt;
    }
    if (Object.keys(patch).length === 0) return receipt;
    this.finish(receipt, patch);
    return receipt;
  }

  // ------------------------------------------------------------ reclaim

  async reclaim(linkOrPublicKey: string): Promise<ReclaimResult> {
    const { publicKey } = parseLinkOrKey(linkOrPublicKey);
    const now = this.now();
    const drop = mapDrop(await this.chain.getDrop(publicKey), now);
    if (drop.kind === "NotFound") throw new LumeniaError(`No drop on chain for ${publicKey}; nothing to reclaim.`);
    if (drop.kind === "Open") {
      const left = drop.expiresAt ? Math.max(0, Date.parse(drop.expiresAt) - now.getTime()) : 0;
      throw new LumeniaError(
        `Not expired yet: the link stays claimable until ${drop.expiresAt} (${describeDuration(left)} from now). Reclaim becomes possible after expiry. Nothing was spent.`,
      );
    }
    if (drop.kind !== "Expired") throw new LumeniaError(`Nothing to reclaim: the drop's status is "${drop.label}". Nothing was spent.`);
    if (drop.funder && drop.funder !== this.config.funderAccountId) {
      throw new LumeniaError(
        `Only the funder ${drop.funder} can reclaim this drop; this server signs as ${this.config.funderAccountId}. Nothing was spent.`,
      );
    }
    const outcome = await this.chain.reclaim(publicKey);
    if (outcome.failure) throw new LumeniaError(`Reclaim transaction failed: ${outcome.failure} (tx ${outcome.txHash || "unknown"})`);
    const receipt = this.store.findByPublicKey(publicKey) ?? this.receiptFromDrop(publicKey, drop, now);
    this.finish(receipt, {
      status: "Reclaimed",
      reclaim_tx_hash: outcome.txHash || null,
      claimed_to: null,
    });
    return { receipt: publicReceipt(receipt), txHash: outcome.txHash, explorerUrl: this.txUrl(outcome.txHash) };
  }

  /** A drop this funder created elsewhere (another machine, the web app) still gets a receipt row when reclaimed here. */
  private receiptFromDrop(publicKey: string, drop: DropStatus, now: Date): Receipt {
    return {
      receipt_id: `rcpt_${randomUUID()}`,
      created_at: drop.createdAt ?? now.toISOString(),
      amount_usdc: drop.amountUsdc ?? "0.00",
      amount_units: drop.amountUsdc ? parseUsdcAmountLoose(drop.amountUsdc) : "0",
      memo: drop.memo ?? "",
      label: null,
      batch_id: null,
      reference: null,
      link_public_key: publicKey,
      funder_account: drop.funder ?? this.config.funderAccountId,
      create_tx_hash: null,
      explorer_url: null,
      expires_at: drop.expiresAt ?? now.toISOString(),
      status: drop.label,
      claimed_to: drop.claimedTo,
      claim_tx_hash: null,
      reclaim_tx_hash: null,
      updated_at: now.toISOString(),
      error: "created from the chain record; the link itself was not made by this installation",
      network: "testnet",
    };
  }

  // ----------------------------------------------------------- balances

  async balances(): Promise<Balances> {
    const funder = this.config.funderAccountId;
    const [near, usdc, storage, contractStorage] = await Promise.all([
      this.chain.nearBalance(funder),
      this.chain.ftBalanceOf(funder),
      this.chain.storageBalanceOf(funder),
      this.chain.storageBalanceOf(this.config.contractId),
    ]);
    const spent = spentInWindow(this.store.all(), this.now());
    const remaining = this.config.dailyBudgetUnits > spent ? this.config.dailyBudgetUnits - spent : 0n;
    return {
      network: "testnet",
      funder,
      funderExplorerUrl: this.accountUrl(funder),
      accountExists: near !== null,
      near: near ? { total: formatNear(near.total), available: formatNear(near.available) } : null,
      usdc: { balance: formatUsdc(usdc), units: usdc.toString(), registered: storage !== null },
      contract: { id: this.config.contractId, registeredOnUsdc: contractStorage !== null },
      budget: {
        dailyBudgetUsdc: formatUsdc(this.config.dailyBudgetUnits),
        spentLast24hUsdc: formatUsdc(spent),
        remainingUsdc: formatUsdc(remaining),
        maxLinkUsdc: formatUsdc(this.config.maxLinkUnits),
      },
    };
  }

  /** Register the funder on the USDC contract (0.00125 NEAR). Idempotent. */
  async register(): Promise<{ alreadyRegistered: boolean; txHash: string | null; explorerUrl: string | null }> {
    const storage = await this.chain.storageBalanceOf(this.config.funderAccountId);
    if (storage) return { alreadyRegistered: true, txHash: null, explorerUrl: null };
    const outcome = await this.chain.storageDeposit();
    if (outcome.failure) throw new LumeniaError(`storage_deposit failed: ${outcome.failure}`);
    return { alreadyRegistered: false, txHash: outcome.txHash, explorerUrl: this.txUrl(outcome.txHash) };
  }

  // -------------------------------------------------------------- quote

  async crossChainQuote(input: { amountUsdc: number | string; destination: Destination; recipient?: string }): Promise<CrossChainQuote> {
    const amountUnits = parseUsdcAmount(input.amountUsdc);
    const recipient = input.recipient?.trim() || undefined;
    const req = buildQuoteRequest({ amountUnits, destination: input.destination, now: this.now(), ...(recipient ? { recipient } : {}) });
    const res = await requestDryQuote(this.config.oneClickUrl, req, this.fetchImpl);
    return summarizeQuote(req, input.destination, res);
  }

  // ----------------------------------------------------------- receipts

  /** Receipts newest first; `since` is an ISO date or timestamp; `refresh` re-reads unsettled ones from the chain. */
  async listReceipts(opts: { since?: string; refresh?: boolean; limit?: number } = {}): Promise<PublicReceipt[]> {
    let list = this.store.all();
    if (opts.since) {
      const t = Date.parse(opts.since);
      if (Number.isNaN(t)) throw new LumeniaError(`since="${opts.since}" is not a date; use ISO 8601 like 2026-11-01 or 2026-11-01T12:00:00Z`);
      list = list.filter((r) => Date.parse(r.created_at) >= t);
    }
    list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    if (opts.limit !== undefined) list = list.slice(0, Math.max(0, opts.limit));
    if (opts.refresh) {
      const now = this.now();
      for (const r of list) {
        if (!UNSETTLED.has(r.status) && !r.status.startsWith("Claiming")) continue;
        try {
          this.reconcile(r, mapDrop(await this.chain.getDrop(r.link_public_key), now), now);
        } catch {
          // a failed refresh keeps the stored status
        }
      }
    }
    return list.map(publicReceipt);
  }

  async receiptsCsv(opts: { since?: string; refresh?: boolean } = {}): Promise<string> {
    const list = await this.listReceipts(opts);
    return receiptsToCsv(list as Receipt[]);
  }

  /** The lumenia://links resource: every link this installation created, secrets included. */
  links(): LinkEntry[] {
    return this.store
      .all()
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .map((r) => ({
        receipt_id: r.receipt_id,
        created_at: r.created_at,
        amount_usdc: r.amount_usdc,
        memo: r.memo,
        status: r.status,
        link: r.link ?? null,
        link_public_key: r.link_public_key,
        expires_at: r.expires_at,
      }));
  }
}

const UNSETTLED: ReadonlySet<string> = new Set(["Submitting", "Open", "Expired", "Claiming"]);

/** ft_transfer_call returns the amount the receiver kept, as a JSON string ("1000000"). */
export function parseUsedAmount(returnValue: string | null): bigint | null {
  if (returnValue === null || returnValue.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(returnValue);
    if (typeof parsed === "string" && /^\d+$/.test(parsed)) return BigInt(parsed);
    if (typeof parsed === "number" && Number.isInteger(parsed)) return BigInt(parsed);
    return null;
  } catch {
    return /^\d+$/.test(returnValue.trim()) ? BigInt(returnValue.trim()) : null;
  }
}

function parseUsdcAmountLoose(text: string): string {
  const [whole = "0", frac = ""] = text.split(".");
  return (BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6))).toString();
}

export function describeDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} h ${rem} min` : `${h} h`;
}
