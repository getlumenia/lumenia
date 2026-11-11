#!/usr/bin/env node
// The poller. Every POLL_INTERVAL_S it asks the market for its in_progress
// assignments and, for each one:
//   fresh work (deliverableUrl null)        parse the brief -> pre-flight the
//       treasury -> start -> one atomic batch deposit on NEAR (all links or
//       nothing) -> upload receipt.csv -> submit; or decline with a full refund
//   request-changes (submittedAt set)       re-submit the same deliverable with
//       a note (escrowed money cannot change)
//   dispute redo (deliverableUrl set, submittedAt null)   same, with a note
// Everything it did is in the state file, so a restart resumes where it was,
// and the library's idempotency reference (the assignment id) makes a repeated
// deposit call return the first batch instead of paying again.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { centsToUsdc, DEFAULT_LIMITS, parseAmountCents, parseBrief, type Brief, type BriefLimits } from "./brief.js";
import { CSV_FILENAME, renderCsv, renderMarkdown, type DeliverableInput, type DeliverableLink, type ReworkNote } from "./deliverable.js";
import { DryRunRail } from "./dry-run.js";
import { createLogger, silentLogger, type Logger } from "./log.js";
import { MarketClient, MarketError, type AssignmentRow, type MarketApi } from "./market.js";
import { errorText, isNothingSpentError, LumeniaRail, type PayoutRail, type RailBalances, type RailBatchResult } from "./rail.js";
import { reclaimPass, type ReclaimSummary } from "./reclaimer.js";
import { referenceFor } from "./reference.js";
import { defaultStatePath, newRecord, StateStore, type AssignmentRecord, type LinkRecord } from "./state.js";

export interface WorkerConfig {
  pollIntervalMs: number;
  progressMinIntervalMs: number;
  reclaimEveryMs: number;
  /** A "resend" of a deliverable the market lost is attempted at most this often. */
  resendMinIntervalMs: number;
  limits: BriefLimits;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  pollIntervalMs: 45_000,
  progressMinIntervalMs: 30_000,
  reclaimEveryMs: 3_600_000,
  resendMinIntervalMs: 10 * 60_000,
  limits: DEFAULT_LIMITS,
};

export interface WorkerDeps {
  market: MarketApi;
  rail: PayoutRail;
  state: StateStore;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: Logger;
  config?: Partial<WorkerConfig>;
}

export type RowOutcome = "submitted" | "declined" | "resubmitted" | "waiting" | "skipped" | "needs_human" | "error";

export interface PollSummary {
  seen: number;
  outcomes: Record<string, RowOutcome>;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function cents(text: string): number {
  const r = parseAmountCents(text);
  return r.ok ? r.cents : 0;
}

/** Why the treasury cannot take this job right now; null when it can. Reads only. */
export function preflightProblem(brief: Brief, balances: RailBalances): string | null {
  const total = cents(brief.totalUsdc);
  const tail = " Nothing was created and this hire is refunded in full.";
  if (!balances.usdc.registered) {
    return `The payout treasury is not ready (its account is not registered on the USDC contract yet).${tail} Please try again later.`;
  }
  const maxLink = cents(balances.budget.maxLinkUsdc);
  const over = brief.payouts.filter((p) => cents(p.amountUsdc) > maxLink);
  if (over.length > 0) {
    return `${over.map((p) => `"${p.label}" (${p.amountUsdc} USDC)`).join(", ")} ${over.length === 1 ? "is" : "are"} above this treasury's ${balances.budget.maxLinkUsdc} USDC maximum per link.${tail}`;
  }
  const remaining = cents(balances.budget.remainingUsdc);
  if (total > remaining) {
    return (
      `Today's payout budget cannot cover this job: ${brief.totalUsdc} USDC requested, ${balances.budget.remainingUsdc} USDC left of ` +
      `${balances.budget.dailyBudgetUsdc} in the rolling 24 hours.${tail} Try a smaller job or hire again later.`
    );
  }
  const held = cents(balances.usdc.balance);
  if (total > held) {
    return `The treasury holds ${balances.usdc.balance} USDC and this job needs ${brief.totalUsdc}.${tail} Please try again later.`;
  }
  return null;
}

function linksFromBatch(result: RailBatchResult): LinkRecord[] {
  return result.payouts.map((p, i) => ({
    index: i + 1,
    label: p.label,
    amountUsdc: p.receipt.amount_usdc,
    memo: p.receipt.memo,
    publicKey: p.publicKey,
    link: p.link,
    txHash: p.receipt.create_tx_hash ?? result.txHash,
    explorerUrl: p.receipt.explorer_url ?? result.explorerUrl,
    expiresAt: p.receipt.expires_at || result.expiresAt,
    status: p.receipt.status,
    claimedTo: null,
    reclaimTxHash: null,
    lastCheckedAt: null,
    note: null,
  }));
}

export class Worker {
  readonly market: MarketApi;
  readonly rail: PayoutRail;
  readonly state: StateStore;
  readonly config: WorkerConfig;
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly log: Logger;

  constructor(deps: WorkerDeps) {
    this.market = deps.market;
    this.rail = deps.rail;
    this.state = deps.state;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? abortableSleep;
    this.log = deps.log ?? silentLogger;
    this.config = { ...DEFAULT_WORKER_CONFIG, ...deps.config, limits: { ...DEFAULT_LIMITS, ...deps.config?.limits } };
  }

  // ---------------------------------------------------------------- loop

  async run(signal?: AbortSignal): Promise<void> {
    let lastReclaim = 0;
    this.log.info("worker started", { pollIntervalS: this.config.pollIntervalMs / 1000, reclaimEveryS: this.config.reclaimEveryMs / 1000 });
    while (!signal?.aborted) {
      try {
        const s = await this.pollOnce();
        if (s.seen > 0) this.log.info("poll done", { seen: s.seen, outcomes: s.outcomes });
      } catch (e) {
        this.log.error("poll failed", { error: errorText(e) });
      }
      if (this.now().getTime() - lastReclaim >= this.config.reclaimEveryMs) {
        lastReclaim = this.now().getTime();
        try {
          const r = await this.reclaim();
          if (r.checked > 0 || r.adopted > 0) this.log.info("reclaim pass done", { checked: r.checked, reclaimed: r.reclaimed.length, claimed: r.claimed, errors: r.errors.length });
        } catch (e) {
          this.log.error("reclaim pass failed", { error: errorText(e) });
        }
      }
      await this.sleep(this.config.pollIntervalMs, signal);
    }
    this.log.info("worker stopped");
  }

  async pollOnce(): Promise<PollSummary> {
    const rows = await this.market.listAssignments({ limit: 100 });
    const outcomes: Record<string, RowOutcome> = {};
    for (const row of rows) {
      const id = row.assignment.assignmentId;
      try {
        outcomes[id] = await this.handleRow(row);
      } catch (e) {
        outcomes[id] = "error";
        this.log.error("assignment failed", { assignmentId: id, error: errorText(e) });
        this.noteError(id, errorText(e));
      }
    }
    return { seen: rows.length, outcomes };
  }

  reclaim(): Promise<ReclaimSummary> {
    return reclaimPass({ rail: this.rail, state: this.state, now: this.now, log: this.log });
  }

  // ------------------------------------------------------------- routing

  async handleRow(row: AssignmentRow): Promise<RowOutcome> {
    const a = row.assignment;
    const id = a.assignmentId;
    if (row.job?.jobKind === "competition") {
      this.log.info("skipping a competition entry; this agent only takes hires", { assignmentId: id });
      return "skipped";
    }
    if (a.status && a.status !== "in_progress") return "skipped";
    const rec = this.state.get(id);
    if (!a.deliverableUrl) return this.handleFresh(row, rec);
    if (a.submittedAt) return this.handleRework(row, rec, "rework");
    return this.handleRework(row, rec, "redo");
  }

  // --------------------------------------------------------------- fresh

  private async handleFresh(row: AssignmentRow, rec: AssignmentRecord | null): Promise<RowOutcome> {
    const a = row.assignment;
    const id = a.assignmentId;
    if (rec) {
      switch (rec.phase) {
        case "rejected":
        case "failed":
          if (rec.decline && !rec.decline.delivered) return this.deliverDecline(rec);
          this.log.warn("market still lists a declined assignment as fresh; leaving it alone", { assignmentId: id, phase: rec.phase });
          return "skipped";
        case "needs_human":
          return "needs_human";
        case "submitted":
          return this.resendIfDue(row, rec);
        case "created":
          return this.finishSubmission(row, rec);
        case "creating":
          this.log.warn("resuming an interrupted deposit; the reference makes it idempotent", { assignmentId: id });
          return this.createAndSubmit(row, rec);
        case "parsing":
          break;
      }
    }
    const nowIso = this.now().toISOString();
    const record =
      rec ??
      newRecord({
        assignmentId: id,
        jobId: a.jobId ?? row.job?.jobId ?? "",
        jobTitle: row.job?.title ?? "",
        reference: referenceFor(id),
        now: nowIso,
      });
    this.log.info("new assignment", { assignmentId: id, job: record.jobId, title: record.jobTitle.slice(0, 60), escrow: a.escrowAmount ?? null, token: a.escrowToken ?? null });

    // 1. The brief is data: parse it, never follow it.
    const parsed = parseBrief(row.job?.description ?? "", this.config.limits);
    if (!parsed.ok) {
      record.phase = "rejected";
      record.decline = { at: nowIso, reason: "rejected", detail: parsed.detail, delivered: false };
      this.state.put(record, nowIso);
      this.log.info("declining: brief not usable", { assignmentId: id, reason: parsed.reason });
      return this.deliverDecline(record);
    }
    record.brief = { payouts: parsed.brief.payouts, expiresInHours: parsed.brief.expiresInHours, totalUsdc: parsed.brief.totalUsdc };

    // 2. Pre-flight against the treasury: reads only, and a transient RPC error just waits for the next poll.
    let balances: RailBalances;
    try {
      balances = await this.rail.balances();
    } catch (e) {
      this.log.warn("treasury pre-flight unavailable; will retry next poll", { assignmentId: id, error: errorText(e) });
      record.errors.push(`${nowIso} pre-flight: ${errorText(e)}`);
      this.state.put(record, nowIso);
      return "waiting";
    }
    const problem = preflightProblem(parsed.brief, balances);
    if (problem) {
      record.phase = "rejected";
      record.decline = { at: nowIso, reason: "rejected", detail: problem, delivered: false };
      this.state.put(record, nowIso);
      this.log.info("declining: treasury cannot cover the job", { assignmentId: id });
      return this.deliverDecline(record);
    }

    // 3. Start the clock, tell the buyer what is about to happen.
    await this.market.start(id);
    const n = parsed.brief.payouts.length;
    await this.say(
      record,
      `Creating ${n} claim link${n === 1 ? "" : "s"} on NEAR testnet: ${parsed.brief.totalUsdc} USDC in total, expiry ${parsed.brief.expiresInHours} h. ` +
        `All links are funded in one transaction; you will get a table with one link per person, a JSON receipt and receipt.csv.`,
    );
    record.phase = "creating";
    this.state.put(record, this.now().toISOString());
    return this.createAndSubmit(row, record);
  }

  private async createAndSubmit(row: AssignmentRow, record: AssignmentRecord): Promise<RowOutcome> {
    const id = record.assignmentId;
    const brief = record.brief;
    if (!brief) throw new Error(`record ${id} has no brief`);
    await this.progress(record, `Escrowing ${brief.payouts.length} payout${brief.payouts.length === 1 ? "" : "s"} (${brief.totalUsdc} USDC) in one NEAR transaction`, 10);
    let result: RailBatchResult;
    try {
      result = await this.rail.createPayLinks({
        payouts: brief.payouts.map((p) => ({ label: p.label, amountUsdc: p.amountUsdc, memo: p.memo })),
        expiresHours: brief.expiresInHours,
        reference: record.reference,
      });
    } catch (e) {
      const nowIso = this.now().toISOString();
      const text = errorText(e);
      record.errors.push(`${nowIso} deposit: ${text}`);
      if (isNothingSpentError(e)) {
        // The library refused, or the escrow refunded the whole batch: nothing stands on chain.
        record.phase = "failed";
        record.decline = {
          at: nowIso,
          reason: "failed",
          detail: `The payout could not be made on NEAR testnet: ${text.slice(0, 700)} This decline refunds the hire in full.`,
          delivered: false,
        };
        this.state.put(record, nowIso);
        this.log.warn("declining: deposit failed, nothing was spent", { assignmentId: id, error: text });
        return this.deliverDecline(record);
      }
      this.state.put(record, nowIso);
      this.log.error("deposit raised an unexpected error; not declining, will retry next poll", { assignmentId: id, error: text });
      return "error";
    }
    record.links = linksFromBatch(result);
    record.batchId = result.batchId;
    if (result.note) record.notes.push(`${this.now().toISOString()}: ${result.note}`);
    record.phase = "created";
    this.state.put(record, this.now().toISOString());
    this.log.info("links escrowed", { assignmentId: id, links: record.links.length, total: result.totalUsdc, tx: result.txHash ?? "unknown" });
    return this.finishSubmission(row, record);
  }

  private async finishSubmission(row: AssignmentRow, record: AssignmentRecord): Promise<RowOutcome> {
    const id = record.assignmentId;
    const input = this.deliverableInput(row, record);
    const csv = renderCsv(input);
    let attached = true;
    if (!record.deliverable?.csvFileUrl && !record.deliverable?.csvFileId) {
      try {
        const up = await this.market.uploadFile(CSV_FILENAME, Buffer.from(csv, "utf8"));
        record.deliverable = { markdown: "", csv, csvFileId: up.fileId, csvFileUrl: up.fileUrl };
      } catch (e) {
        attached = false;
        record.notes.push(`${this.now().toISOString()}: receipt.csv could not be attached: ${errorText(e)}`);
        this.log.warn("receipt.csv upload failed; submitting without the file", { assignmentId: id, error: errorText(e) });
      }
    }
    let markdown = renderMarkdown(input);
    if (!attached) markdown += "\n_receipt.csv could not be attached to this submission; the JSON receipt above carries the same rows._\n";
    const fileRef = record.deliverable?.csvFileUrl ?? record.deliverable?.csvFileId ?? null;
    record.deliverable = { markdown, csv, csvFileId: record.deliverable?.csvFileId ?? null, csvFileUrl: record.deliverable?.csvFileUrl ?? null };
    this.state.put(record, this.now().toISOString());
    await this.progress(record, "Links escrowed; delivering the table, the JSON receipt and receipt.csv", 90);
    await this.market.submit(id, markdown, fileRef ? [fileRef] : []);
    const nowIso = this.now().toISOString();
    record.phase = "submitted";
    record.submissions.push({ at: nowIso, kind: "initial", key: null });
    this.state.put(record, nowIso);
    this.log.info("submitted", { assignmentId: id, links: record.links.length, csv: fileRef ? "attached" : "missing" });
    return "submitted";
  }

  /** Our state says submitted but the market shows no deliverable: the submit did not stick. Send it again, slowly. */
  private async resendIfDue(row: AssignmentRow, record: AssignmentRecord): Promise<RowOutcome> {
    const last = record.submissions.at(-1);
    if (last && this.now().getTime() - Date.parse(last.at) < this.config.resendMinIntervalMs) return "waiting";
    this.log.warn("market shows no deliverable for a submitted assignment; sending it again", { assignmentId: record.assignmentId });
    return this.resubmit(row, record, { kind: "resend", at: this.now().toISOString(), feedback: null }, null);
  }

  // -------------------------------------------------------------- rework

  private async handleRework(row: AssignmentRow, rec: AssignmentRecord | null, kind: "rework" | "redo"): Promise<RowOutcome> {
    const a = row.assignment;
    const id = a.assignmentId;
    const key = kind === "rework" ? (row.latestMessage?.createdAt ?? a.submittedAt ?? a.updatedAt ?? null) : (a.updatedAt ?? a.deliverableUrl ?? null);
    let record = rec;
    if (!record) {
      record = this.recoverRecord(row);
      if (!record) {
        const nowIso = this.now().toISOString();
        const fresh = newRecord({ assignmentId: id, jobId: a.jobId ?? "", jobTitle: row.job?.title ?? "", reference: referenceFor(id), now: nowIso });
        fresh.phase = "needs_human";
        fresh.notes.push(`${nowIso}: the market asked for a ${kind} but this worker has no record of the job and the receipt log has none either`);
        this.state.put(fresh, nowIso);
        await this.say(fresh, "I cannot find my records for this job, so I cannot re-send the links automatically. A human from Lumenia will look at it.");
        this.log.error("rework requested for an unknown assignment; needs a human", { assignmentId: id });
        return "needs_human";
      }
    }
    if (record.phase === "needs_human") return "needs_human";
    if (record.submissions.some((s) => s.kind === kind && s.key === key)) return "waiting";
    if (record.links.length === 0) {
      this.log.error("rework requested but no links are recorded; needs a human", { assignmentId: id });
      return "needs_human";
    }
    const feedback = kind === "rework" && row.latestMessage?.senderSide === "buyer" ? (row.latestMessage.body ?? null) : null;
    return this.resubmit(row, record, { kind, at: this.now().toISOString(), feedback }, key);
  }

  private async resubmit(row: AssignmentRow, record: AssignmentRecord, note: ReworkNote, key: string | null): Promise<RowOutcome> {
    const id = record.assignmentId;
    const input = this.deliverableInput(row, record);
    if (!record.deliverable?.csvFileUrl && !record.deliverable?.csvFileId) {
      try {
        const up = await this.market.uploadFile(CSV_FILENAME, Buffer.from(renderCsv(input), "utf8"));
        record.deliverable = { markdown: record.deliverable?.markdown ?? "", csv: renderCsv(input), csvFileId: up.fileId, csvFileUrl: up.fileUrl };
      } catch (e) {
        this.log.warn("receipt.csv upload failed on re-submission", { assignmentId: id, error: errorText(e) });
      }
    }
    const markdown = renderMarkdown(input, note);
    const fileRef = record.deliverable?.csvFileUrl ?? record.deliverable?.csvFileId ?? null;
    await this.market.submit(id, markdown, fileRef ? [fileRef] : []);
    const nowIso = this.now().toISOString();
    record.deliverable = { markdown, csv: record.deliverable?.csv ?? renderCsv(input), csvFileId: record.deliverable?.csvFileId ?? null, csvFileUrl: record.deliverable?.csvFileUrl ?? null };
    record.submissions.push({ at: nowIso, kind: note.kind, key });
    record.phase = "submitted";
    this.state.put(record, nowIso);
    if (note.kind !== "resend") {
      await this.say(
        record,
        note.kind === "rework"
          ? "Re-submitted with a note. The links themselves cannot change: their USDC is already escrowed on NEAR. Unclaimed links return to our treasury after the expiry; for a different person or amount, hire the agent again."
          : "Re-submitted after the dispute ruling. The links are unchanged: their USDC is already escrowed on NEAR and returns to our treasury if nobody claims it by the expiry.",
      );
    }
    this.log.info("re-submitted", { assignmentId: id, kind: note.kind });
    return "resubmitted";
  }

  /** Rebuild a record from the library's receipt log when the state file knows nothing about an assignment. */
  private recoverRecord(row: AssignmentRow): AssignmentRecord | null {
    const a = row.assignment;
    const reference = referenceFor(a.assignmentId);
    const receipts = this.rail.receiptsByReference(reference).filter((r) => r.status !== "Failed");
    if (receipts.length === 0) return null;
    const nowIso = this.now().toISOString();
    const record = newRecord({ assignmentId: a.assignmentId, jobId: a.jobId ?? "", jobTitle: row.job?.title ?? "", reference, now: nowIso });
    const first = receipts[0];
    const hours = first ? Math.max(1, Math.round((Date.parse(first.expiresAt) - Date.parse(first.createdAt)) / 3_600_000)) : this.config.limits.defaultExpiresHours;
    record.firstSeenAt = first?.createdAt ?? nowIso;
    record.links = receipts.map((r, i) => ({
      index: i + 1,
      label: r.label ?? `payout ${i + 1}`,
      amountUsdc: r.amountUsdc,
      memo: r.memo,
      publicKey: r.publicKey,
      link: r.link ?? "",
      txHash: r.txHash,
      explorerUrl: r.explorerUrl,
      expiresAt: r.expiresAt,
      status: r.status,
      claimedTo: null,
      reclaimTxHash: null,
      lastCheckedAt: null,
      note: null,
    }));
    record.brief = {
      payouts: record.links.map((l) => ({ label: l.label, amountUsdc: l.amountUsdc, memo: l.memo })),
      expiresInHours: hours,
      totalUsdc: centsToUsdc(record.links.reduce((sum, l) => sum + cents(l.amountUsdc), 0)),
    };
    record.phase = "submitted";
    record.notes.push(`${nowIso}: record rebuilt from the library's receipt log`);
    this.state.put(record, nowIso);
    this.log.warn("rebuilt an assignment record from the receipt log", { assignmentId: a.assignmentId, links: record.links.length });
    return record;
  }

  // ------------------------------------------------------------- helpers

  private deliverableInput(row: AssignmentRow, record: AssignmentRecord): DeliverableInput {
    const links: DeliverableLink[] = record.links.map((l) => ({
      index: l.index,
      label: l.label,
      amountUsdc: l.amountUsdc,
      memo: l.memo,
      link: l.link,
      publicKey: l.publicKey,
      txHash: l.txHash,
      explorerUrl: l.explorerUrl,
      expiresAt: l.expiresAt,
      status: l.status,
    }));
    return {
      jobId: record.jobId || row.job?.jobId || row.assignment.jobId || "",
      assignmentId: record.assignmentId,
      network: this.rail.network,
      contractId: this.rail.contractId,
      usdcContractId: this.rail.usdcContractId,
      funderAccount: this.rail.funderAccountId,
      createdAt: record.firstSeenAt,
      expiresInHours: record.brief?.expiresInHours ?? this.config.limits.defaultExpiresHours,
      batchId: record.batchId,
      links,
    };
  }

  private async deliverDecline(record: AssignmentRecord): Promise<RowOutcome> {
    const d = record.decline;
    if (!d) throw new Error(`record ${record.assignmentId} has no decline to deliver`);
    try {
      await this.market.decline(record.assignmentId, d.reason, d.detail);
      d.delivered = true;
      this.state.put(record, this.now().toISOString());
      this.log.info("declined", { assignmentId: record.assignmentId, reason: d.reason });
      return "declined";
    } catch (e) {
      const nowIso = this.now().toISOString();
      if (e instanceof MarketError && e.status >= 400 && e.status < 500) {
        // The market will not take the decline (the assignment moved on): nothing more to do here.
        d.delivered = true;
        record.notes.push(`${nowIso}: decline not accepted by the market: ${errorText(e)}`);
        this.state.put(record, nowIso);
        this.log.warn("decline not accepted; marked as done", { assignmentId: record.assignmentId, error: errorText(e) });
        return "declined";
      }
      record.errors.push(`${nowIso} decline: ${errorText(e)}`);
      this.state.put(record, nowIso);
      this.log.error("decline failed; will retry next poll", { assignmentId: record.assignmentId, error: errorText(e) });
      return "error";
    }
  }

  /** At most one progress report per assignment per 30 s; failures never stop the job. */
  private async progress(record: AssignmentRecord, message: string, percent: number): Promise<void> {
    const now = this.now();
    if (record.lastProgressAt && now.getTime() - Date.parse(record.lastProgressAt) < this.config.progressMinIntervalMs) return;
    try {
      await this.market.progress(record.assignmentId, message, percent);
      record.lastProgressAt = now.toISOString();
      this.state.put(record, now.toISOString());
    } catch (e) {
      if (e instanceof MarketError && e.tooSoon) {
        record.lastProgressAt = now.toISOString();
        this.state.put(record, now.toISOString());
        return;
      }
      this.log.warn("progress report failed", { assignmentId: record.assignmentId, error: errorText(e) });
    }
  }

  private async say(record: AssignmentRecord, body: string): Promise<void> {
    try {
      await this.market.message(record.assignmentId, body);
    } catch (e) {
      this.log.warn("thread message failed", { assignmentId: record.assignmentId, error: errorText(e) });
    }
  }

  private noteError(assignmentId: string, text: string): void {
    try {
      const rec = this.state.get(assignmentId);
      if (!rec) return;
      rec.errors.push(`${this.now().toISOString()} ${text}`);
      this.state.put(rec, this.now().toISOString());
    } catch {
      // the state file itself is the problem; the log line above is all we can do
    }
  }
}

// ------------------------------------------------------------------- CLI

const USAGE = `lumenia-agent-market: the poller behind the Lumenia Payout Agent on NEAR Agent Market

Usage:
  node dist/agent-market/src/worker.js                 poll forever (POLL_INTERVAL_S, default 45)
  node dist/agent-market/src/worker.js --once          one poll, then exit (for cron)
  node dist/agent-market/src/worker.js --reclaim       take back expired unclaimed links, then exit
  node dist/agent-market/src/worker.js --dry-run --brief examples/brief.md
                                                        parse a brief and print the deliverable; no chain, no market
  --state <file>   state file (default STATE_FILE or ~/.lumenia-near/agent-market-state.json)

Environment: AGENT_MARKET_TOKEN (aat_...), AGENT_MARKET_BASE_URL, POLL_INTERVAL_S, RECLAIM_EVERY_S, STATE_FILE,
MAX_PAYOUTS_PER_JOB, MIN_PAYOUT_USDC, MAX_PAYOUT_USDC, DEFAULT_EXPIRES_HOURS, and the Lumenia library's
NEAR_RPC_URL, LUMENIA_CONTRACT_ID, USDC_CONTRACT_ID, FUNDER_ACCOUNT_ID, FUNDER_PRIVATE_KEY or FUNDER_KEY_FILE,
WEB_ORIGIN, DAILY_BUDGET_USDC, MAX_LINK_USDC, LUMENIA_DATA_DIR (see .env.example).
`;

type Env = Record<string, string | undefined>;

function envInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name}="${raw}" is not a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

function envCents(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const r = parseAmountCents(raw);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.cents;
}

export function configFromEnv(env: Env): Partial<WorkerConfig> {
  return {
    pollIntervalMs: envInt(env, "POLL_INTERVAL_S", 45, 30, 3600) * 1000,
    reclaimEveryMs: envInt(env, "RECLAIM_EVERY_S", 3600, 60, 86_400) * 1000,
    limits: {
      ...DEFAULT_LIMITS,
      maxPayouts: envInt(env, "MAX_PAYOUTS_PER_JOB", DEFAULT_LIMITS.maxPayouts, 1, 30),
      minPayoutCents: envCents(env, "MIN_PAYOUT_USDC", DEFAULT_LIMITS.minPayoutCents),
      maxPayoutCents: envCents(env, "MAX_PAYOUT_USDC", DEFAULT_LIMITS.maxPayoutCents),
      defaultExpiresHours: envInt(env, "DEFAULT_EXPIRES_HOURS", DEFAULT_LIMITS.defaultExpiresHours, 1, 168),
    },
  };
}

export async function dryRun(briefText: string, env: Env, out: (text: string) => void, now: () => Date = () => new Date()): Promise<number> {
  const config = configFromEnv(env);
  const parsed = parseBrief(briefText, config.limits);
  if (!parsed.ok) {
    out(`DECLINE (${parsed.reason}):\n${parsed.detail}\n`);
    return 1;
  }
  out(`Parsed brief:\n${JSON.stringify(parsed.brief, null, 2)}\n`);
  const at = now();
  const frozen = () => at;
  const rail = new DryRunRail({
    now: frozen,
    ...(env.LUMENIA_CONTRACT_ID ? { contractId: env.LUMENIA_CONTRACT_ID } : {}),
    ...(env.USDC_CONTRACT_ID ? { usdcContractId: env.USDC_CONTRACT_ID } : {}),
    ...(env.FUNDER_ACCOUNT_ID ? { funderAccountId: env.FUNDER_ACCOUNT_ID } : {}),
    ...(env.WEB_ORIGIN ? { webOrigin: env.WEB_ORIGIN } : {}),
  });
  const createdAt = at.toISOString();
  const result = await rail.createPayLinks({ payouts: parsed.brief.payouts, expiresHours: parsed.brief.expiresInHours, reference: "agent-market:dry-run" });
  const input: DeliverableInput = {
    jobId: "dry-run-job",
    assignmentId: "dry-run-assignment",
    network: rail.network,
    contractId: rail.contractId,
    usdcContractId: rail.usdcContractId,
    funderAccount: rail.funderAccountId,
    createdAt,
    expiresInHours: parsed.brief.expiresInHours,
    batchId: null,
    links: linksFromBatch(result),
    dryRun: true,
  };
  out("----- deliverableMarkdown -----\n" + renderMarkdown(input));
  out("----- receipt.csv -----\n" + renderCsv(input));
  return 0;
}

export async function main(argv: string[], env: Env = process.env): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      once: { type: "boolean" },
      reclaim: { type: "boolean" },
      "dry-run": { type: "boolean" },
      brief: { type: "string" },
      state: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values["dry-run"]) {
    if (!values.brief) {
      process.stderr.write("--dry-run needs --brief <file> (a Markdown or text file holding the buyer's brief)\n");
      return 2;
    }
    return await dryRun(readFileSync(values.brief, "utf8"), env, (t) => process.stdout.write(t));
  }

  const log = createLogger();
  const state = new StateStore(values.state ?? defaultStatePath(env));
  const rail = LumeniaRail.fromEnv(env);
  const config = configFromEnv(env);
  log.info("configuration", {
    network: rail.network,
    contract: rail.contractId,
    funder: rail.funderAccountId,
    webOrigin: rail.webOrigin,
    stateFile: state.path,
    market: env.AGENT_MARKET_BASE_URL ?? "https://market.near.ai",
    token: env.AGENT_MARKET_TOKEN ? "set" : "missing",
    limits: config.limits,
  });

  if (values.reclaim) {
    const summary = await reclaimPass({ rail, state, log });
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return summary.errors.length ? 1 : 0;
  }

  const token = env.AGENT_MARKET_TOKEN?.trim();
  if (!token) {
    log.error("AGENT_MARKET_TOKEN is not set (the agent API token from the listing's Edit page, starts with aat_)");
    return 2;
  }
  const market = new MarketClient({ token, ...(env.AGENT_MARKET_BASE_URL ? { baseUrl: env.AGENT_MARKET_BASE_URL } : {}) });
  const worker = new Worker({ market, rail, state, log, config });

  if (values.once) {
    const summary = await worker.pollOnce();
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }

  const controller = new AbortController();
  const stop = () => {
    log.info("stopping after the current assignment");
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await worker.run(controller.signal);
  return 0;
}

const isEntry = (() => {
  try {
    return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`error: ${errorText(e)}\n`);
      process.exit(1);
    },
  );
}
