import type { AssignmentRow, DeclineReason, MarketApi } from "../src/market.js";
import { MarketError } from "../src/market.js";
import type { PayoutRail, RailBalances, RailBatchInput, RailBatchResult, RailDrop, RailReceipt, RailReclaim, RailStatus } from "../src/rail.js";

export const T0 = new Date("2026-11-11T12:00:00.000Z");

export function clock(start = T0): { now: () => Date; advance: (ms: number) => void } {
  let t = new Date(start);
  return { now: () => t, advance: (ms) => (t = new Date(t.getTime() + ms)) };
}

export function row(over: { id?: string; description?: string; title?: string; assignment?: Record<string, unknown>; job?: Record<string, unknown>; latestMessage?: Record<string, unknown> | null } = {}): AssignmentRow {
  const id = over.id ?? "4d1e2c3b-5a6f-4e7d-8c9b-0a1b2c3d4e5f";
  return {
    assignment: {
      assignmentId: id,
      jobId: "job-" + id.slice(0, 4),
      status: "in_progress",
      escrowAmount: "0.50",
      escrowToken: "USDC",
      slaSeconds: 600,
      startedAt: null,
      submittedAt: null,
      deliverableUrl: null,
      bidId: "bid-1",
      updatedAt: "2026-11-11T11:59:00.000Z",
      ...over.assignment,
    },
    job: {
      jobId: "job-" + id.slice(0, 4),
      title: over.title ?? "Pay two reviewers",
      description: over.description ?? JSON_BRIEF,
      tags: ["payout"],
      jobKind: "standard",
      status: "in_progress",
      attachments: [],
      ...over.job,
    },
    latestMessage: over.latestMessage === undefined ? null : over.latestMessage,
  };
}

export const JSON_BRIEF = `Please pay the reviewers.

\`\`\`json
{"payouts":[{"label":"Ayse","amount_usdc":"1.00","memo":"thanks for the review"},{"label":"Ali","amount_usdc":"2.50"}],"expires_in_hours":48}
\`\`\`
`;

export interface MarketCall {
  method: "list" | "start" | "message" | "progress" | "decline" | "submit" | "upload";
  id?: string;
  body?: unknown;
}

/** An in-memory market: rows are the in_progress worklist; submit and decline remove them like the real one. */
export class FakeMarket implements MarketApi {
  rows: AssignmentRow[] = [];
  calls: MarketCall[] = [];
  failNext = new Map<MarketCall["method"], Error>();
  progressTooSoon = false;
  files: Array<{ filename: string; bytes: Uint8Array; fileId: string; fileUrl: string }> = [];
  submissions: Array<{ id: string; markdown: string; files: string[] }> = [];
  declines: Array<{ id: string; reason: DeclineReason; detail: string }> = [];
  messages: Array<{ id: string; body: string }> = [];
  progressReports: Array<{ id: string; message: string; percent: number }> = [];
  now: () => Date = () => T0;

  private fail(method: MarketCall["method"]): void {
    const e = this.failNext.get(method);
    if (e) {
      this.failNext.delete(method);
      throw e;
    }
  }

  calledMethods(): string[] {
    return this.calls.map((c) => c.method);
  }

  async listAssignments(): Promise<AssignmentRow[]> {
    this.calls.push({ method: "list" });
    this.fail("list");
    return this.rows.map((r) => structuredClone(r));
  }
  async start(id: string): Promise<void> {
    this.calls.push({ method: "start", id });
    this.fail("start");
    const r = this.rows.find((x) => x.assignment.assignmentId === id);
    if (r && !r.assignment.startedAt) r.assignment.startedAt = this.now().toISOString();
  }
  async message(id: string, body: string): Promise<void> {
    this.calls.push({ method: "message", id, body });
    this.fail("message");
    this.messages.push({ id, body });
  }
  async progress(id: string, message: string, percent: number): Promise<void> {
    this.calls.push({ method: "progress", id, body: { message, percent } });
    this.fail("progress");
    if (this.progressTooSoon) throw new MarketError("too soon", 409, "progress_report_too_soon", "POST", "/progress", 12_000, '{"error":"progress_report_too_soon"}');
    this.progressReports.push({ id, message, percent });
  }
  async decline(id: string, reason: DeclineReason, detail: string): Promise<void> {
    this.calls.push({ method: "decline", id, body: { reason, detail } });
    this.fail("decline");
    this.declines.push({ id, reason, detail });
    this.rows = this.rows.filter((x) => x.assignment.assignmentId !== id);
  }
  async submit(id: string, markdown: string, files: string[]): Promise<void> {
    this.calls.push({ method: "submit", id, body: { markdown, files } });
    this.fail("submit");
    this.submissions.push({ id, markdown, files });
    const r = this.rows.find((x) => x.assignment.assignmentId === id);
    if (r) {
      r.assignment.deliverableUrl = `https://market.near.ai/deliverables/${id}/${this.submissions.length}`;
      r.assignment.submittedAt = this.now().toISOString();
      r.assignment.status = "submitted";
    }
    this.rows = this.rows.filter((x) => x.assignment.assignmentId !== id);
  }
  async uploadFile(filename: string, bytes: Uint8Array): Promise<{ fileId: string; fileUrl: string | null }> {
    this.calls.push({ method: "upload", body: { filename, byteSize: bytes.byteLength } });
    this.fail("upload");
    const n = this.files.length + 1;
    const f = { filename, bytes, fileId: `file_${n}`, fileUrl: `https://market.near.ai/files/tok${n}/${filename}` };
    this.files.push(f);
    return { fileId: f.fileId, fileUrl: f.fileUrl };
  }

  /** Put a submitted row back on the worklist the way the market does on request-changes. */
  requestChanges(id: string, feedback: string, at: string): void {
    const r = this.pastRow(id);
    r.assignment.status = "in_progress";
    r.latestMessage = { senderSide: "buyer", origin: "direct", body: feedback, truncated: false, createdAt: at };
    this.rows.push(r);
  }

  /** A dispute redo: deliverable kept, submittedAt cleared, no thread message. */
  disputeRedo(id: string, at: string): void {
    const r = this.pastRow(id);
    r.assignment.status = "in_progress";
    r.assignment.submittedAt = null;
    r.assignment.updatedAt = at;
    r.latestMessage = null;
    this.rows.push(r);
  }

  private pastRow(id: string): AssignmentRow {
    const last = this.submissions.filter((s) => s.id === id).at(-1);
    if (!last) throw new Error(`no submission for ${id}`);
    return row({
      id,
      assignment: { deliverableUrl: `https://market.near.ai/deliverables/${id}/${this.submissions.length}`, submittedAt: this.now().toISOString(), startedAt: T0.toISOString() },
    });
  }
}

interface FakeDropState extends RailDrop {
  reference: string;
}

/** An in-memory rail with the library's two guarantees: a batch is all or nothing, and a reference is idempotent. */
export class FakeRail implements PayoutRail {
  readonly network = "near:testnet";
  readonly contractId = "lumenia-near.testnet";
  readonly usdcContractId = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
  readonly funderAccountId = "lumenia-funder.testnet";
  readonly webOrigin = "https://near.lumenia.test";
  calls: string[] = [];
  batches = new Map<string, RailBatchResult>();
  receipts = new Map<string, RailReceipt[]>();
  drops = new Map<string, FakeDropState>();
  failNextCreate: Error | null = null;
  failBalances: Error | null = null;
  balancesOverride: Partial<RailBalances> = {};
  reclaimCalls: string[] = [];
  now: () => Date = () => T0;
  private keyCounter = 0;
  private txCounter = 0;
  private reclaimCounter = 0;

  async createPayLinks(input: RailBatchInput): Promise<RailBatchResult> {
    this.calls.push(`createPayLinks ${input.reference}`);
    if (this.failNextCreate) {
      const e = this.failNextCreate;
      this.failNextCreate = null;
      throw e;
    }
    const existing = this.batches.get(input.reference);
    if (existing) return { ...existing, note: `No new payment: ${existing.count} receipt(s) already carry reference "${input.reference}".` };
    const now = this.now();
    const expiresAt = new Date(now.getTime() + input.expiresHours * 3_600_000).toISOString();
    const txHash = `TX${++this.txCounter}`;
    const explorerUrl = `https://testnet.nearblocks.io/txns/${txHash}`;
    const payouts = input.payouts.map((p) => {
      const n = ++this.keyCounter;
      const publicKey = `ed25519:PUB${n}`;
      this.drops.set(publicKey, { kind: "Open", label: "Open", claimedTo: null, expiresAt, reference: input.reference });
      return {
        label: p.label,
        link: `${this.webOrigin}/c/near#ed25519:SECRET${n}`,
        publicKey,
        receipt: { amount_usdc: p.amountUsdc, memo: p.memo ?? "", status: "Open", expires_at: expiresAt, create_tx_hash: txHash, explorer_url: explorerUrl },
      };
    });
    const totalCents = input.payouts.reduce((s, p) => s + Math.round(Number(p.amountUsdc) * 100), 0);
    const result: RailBatchResult = {
      batchId: `batch_${this.txCounter}`,
      count: payouts.length,
      totalUsdc: `${Math.floor(totalCents / 100)}.${String(totalCents % 100).padStart(2, "0")}`,
      txHash,
      explorerUrl,
      expiresAt,
      payouts,
    };
    this.batches.set(input.reference, result);
    this.receipts.set(
      input.reference,
      payouts.map((p) => ({
        publicKey: p.publicKey,
        createdAt: now.toISOString(),
        label: p.label,
        amountUsdc: p.receipt.amount_usdc,
        memo: p.receipt.memo,
        status: "Open",
        link: p.link,
        expiresAt,
        txHash,
        explorerUrl,
      })),
    );
    return result;
  }

  async linkStatus(publicKey: string): Promise<RailStatus> {
    this.calls.push(`linkStatus ${publicKey}`);
    const d = this.drops.get(publicKey);
    if (!d) return { publicKey, status: "NotFound", drop: { kind: "NotFound", label: "NotFound", claimedTo: null, expiresAt: null } };
    if (d.kind === "Open" && d.expiresAt && Date.parse(d.expiresAt) <= this.now().getTime()) {
      d.kind = "Expired";
      d.label = "Expired";
    }
    return { publicKey, status: d.label, drop: { kind: d.kind, label: d.label, claimedTo: d.claimedTo, expiresAt: d.expiresAt } };
  }

  async reclaim(publicKey: string): Promise<RailReclaim> {
    this.reclaimCalls.push(publicKey);
    const d = this.drops.get(publicKey);
    if (!d || d.kind !== "Expired") throw new Error(`Nothing to reclaim: the drop's status is "${d?.label ?? "NotFound"}". Nothing was spent.`);
    d.kind = "Reclaimed";
    d.label = "Reclaimed";
    const txHash = `RECLAIM${++this.reclaimCounter}`;
    return { txHash, explorerUrl: `https://testnet.nearblocks.io/txns/${txHash}` };
  }

  async balances(): Promise<RailBalances> {
    this.calls.push("balances");
    if (this.failBalances) throw this.failBalances;
    return {
      funder: this.funderAccountId,
      usdc: { balance: "100.00", registered: true },
      budget: { dailyBudgetUsdc: "50.00", spentLast24hUsdc: "0.00", remainingUsdc: "50.00", maxLinkUsdc: "20.00" },
      ...this.balancesOverride,
    };
  }

  receiptsByReference(reference: string): RailReceipt[] {
    return this.receipts.get(reference) ?? [];
  }

  claim(publicKey: string, account: string): void {
    const d = this.drops.get(publicKey);
    if (!d) throw new Error("no drop");
    d.kind = "Claimed";
    d.label = `Claimed to ${account}`;
    d.claimedTo = account;
  }
}
