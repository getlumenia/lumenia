// The worker's memory: which assignments it has seen and what it did for each
// (brief, links, deliverable, submissions, decline), plus the reclaim log. One
// JSON file (STATE_FILE, default ~/.lumenia-near/agent-market-state.json),
// written through a temp file + rename with mode 0600 because the link records
// are bearer secrets. It is the second guard against paying a job twice; the
// first is the library's idempotency reference.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const STATE_VERSION = 1;

export type Phase =
  | "parsing"
  | "rejected"
  | "creating"
  | "created"
  | "submitted"
  | "failed"
  | "needs_human";

export interface LinkRecord {
  index: number;
  label: string;
  amountUsdc: string;
  memo: string;
  publicKey: string;
  link: string;
  txHash: string | null;
  explorerUrl: string | null;
  expiresAt: string;
  status: string;
  claimedTo: string | null;
  reclaimTxHash: string | null;
  lastCheckedAt: string | null;
  note: string | null;
}

export interface Submission {
  at: string;
  kind: "initial" | "rework" | "redo" | "resend";
  /** What made this round distinct (the feedback's timestamp, the assignment's updatedAt). */
  key: string | null;
}

export interface Decline {
  at: string;
  reason: "rejected" | "failed";
  detail: string;
  /** False until the market accepted the decline call. */
  delivered: boolean;
}

export interface AssignmentRecord {
  assignmentId: string;
  jobId: string;
  jobTitle: string;
  firstSeenAt: string;
  updatedAt: string;
  phase: Phase;
  reference: string;
  brief: { payouts: Array<{ label: string; amountUsdc: string; memo: string }>; expiresInHours: number; totalUsdc: string } | null;
  batchId: string | null;
  links: LinkRecord[];
  deliverable: { markdown: string; csv: string; csvFileId: string | null; csvFileUrl: string | null } | null;
  submissions: Submission[];
  decline: Decline | null;
  lastProgressAt: string | null;
  errors: string[];
  notes: string[];
}

export interface ReclaimEntry {
  at: string;
  assignmentId: string;
  publicKey: string;
  label: string;
  amountUsdc: string;
  txHash: string;
  explorerUrl: string;
}

export interface StateFile {
  version: typeof STATE_VERSION;
  assignments: Record<string, AssignmentRecord>;
  reclaims: ReclaimEntry[];
}

export class StateError extends Error {
  override name = "StateError";
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function defaultStatePath(env: Record<string, string | undefined> = process.env): string {
  return expandHome(env.STATE_FILE?.trim() || join(homedir(), ".lumenia-near", "agent-market-state.json"));
}

export function emptyState(): StateFile {
  return { version: STATE_VERSION, assignments: {}, reclaims: [] };
}

export function newRecord(p: { assignmentId: string; jobId: string; jobTitle: string; reference: string; now: string }): AssignmentRecord {
  return {
    assignmentId: p.assignmentId,
    jobId: p.jobId,
    jobTitle: p.jobTitle,
    firstSeenAt: p.now,
    updatedAt: p.now,
    phase: "parsing",
    reference: p.reference,
    brief: null,
    batchId: null,
    links: [],
    deliverable: null,
    submissions: [],
    decline: null,
    lastProgressAt: null,
    errors: [],
    notes: [],
  };
}

export class StateStore {
  constructor(readonly path: string) {}

  load(): StateFile {
    if (!existsSync(this.path)) return emptyState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (e) {
      throw new StateError(`${this.path} is not valid JSON (${(e as Error).message}); the worker refuses to run without its memory. Repair or move the file aside.`);
    }
    const f = parsed as Partial<StateFile> | null;
    if (!f || f.version !== STATE_VERSION || typeof f.assignments !== "object" || f.assignments === null || !Array.isArray(f.reclaims)) {
      throw new StateError(`${this.path} has an unexpected shape; expected {"version":1,"assignments":{},"reclaims":[]}`);
    }
    return { version: STATE_VERSION, assignments: f.assignments as Record<string, AssignmentRecord>, reclaims: f.reclaims };
  }

  save(file: StateFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // best effort on filesystems without POSIX modes
    }
  }

  get(assignmentId: string): AssignmentRecord | null {
    return this.load().assignments[assignmentId] ?? null;
  }

  all(): AssignmentRecord[] {
    return Object.values(this.load().assignments);
  }

  /** Read-modify-write of one record; `now` stamps updatedAt. */
  put(record: AssignmentRecord, now: string): AssignmentRecord {
    const file = this.load();
    record.updatedAt = now;
    file.assignments[record.assignmentId] = record;
    this.save(file);
    return record;
  }

  addReclaim(entry: ReclaimEntry): void {
    const file = this.load();
    file.reclaims.push(entry);
    this.save(file);
  }

  reclaims(): ReclaimEntry[] {
    return this.load().reclaims;
  }
}
