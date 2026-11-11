// A typed client for the few NEAR Agent Market calls a self-hosted worker
// needs (https://market.near.ai/skill/reference/agent-api.md, read 2026-11-11):
//   GET  /v1/agents/me/assignments        the worklist (in_progress by default)
//   POST /v1/assignments/{id}/start       idempotent
//   POST /v1/assignments/{id}/messages    {"body"}
//   POST /v1/assignments/{id}/progress    {"message","percent"}  max one per 30 s
//   POST /v1/assignments/{id}/decline     {"reason":"rejected"|"failed","detail"}  full refund
//   POST /v1/assignments/{id}/submit      {"deliverableMarkdown","files":[...]}
//   POST /v1/files + PUT bytes + POST /v1/files/{id}/complete
// 5xx, 429 and network errors are retried with backoff; every other 4xx is a
// MarketError with the status and the server's code. The token is never logged.
import { z } from "zod";

export const DEFAULT_BASE_URL = "https://market.near.ai";
export const USER_AGENT = "lumenia-near-agent-market/0.1 (+https://github.com/getlumenia)";
export const PROGRESS_MESSAGE_MAX = 280;
export const DECLINE_DETAIL_MAX = 1000;
export const DELIVERABLE_MAX_BYTES = 256 * 1024;

export type DeclineReason = "rejected" | "failed";

export const latestMessageSchema = z
  .object({
    senderSide: z.string().nullish(),
    origin: z.string().nullish(),
    body: z.string().nullish(),
    truncated: z.boolean().nullish(),
    createdAt: z.string().nullish(),
  })
  .passthrough();

export const assignmentSchema = z
  .object({
    assignmentId: z.string().min(1),
    jobId: z.string().nullish(),
    status: z.string().nullish(),
    escrowAmount: z.union([z.string(), z.number()]).nullish(),
    escrowToken: z.string().nullish(),
    slaSeconds: z.number().nullish(),
    slaDeadlineAt: z.string().nullish(),
    startedAt: z.string().nullish(),
    submittedAt: z.string().nullish(),
    deliverableUrl: z.string().nullish(),
    bidId: z.string().nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
  })
  .passthrough();

export const jobBriefSchema = z
  .object({
    jobId: z.string().nullish(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
    jobKind: z.string().nullish(),
    status: z.string().nullish(),
    attachments: z.array(z.unknown()).nullish(),
    entriesCloseAt: z.string().nullish(),
  })
  .passthrough();

export const assignmentRowSchema = z
  .object({
    assignment: assignmentSchema,
    job: jobBriefSchema.nullish(),
    latestMessage: latestMessageSchema.nullish(),
  })
  .passthrough();

export type AssignmentRow = z.infer<typeof assignmentRowSchema>;
export type LatestMessage = z.infer<typeof latestMessageSchema>;

/** What the worker needs from the market; MarketClient is the HTTP implementation, tests use a fake. */
export interface MarketApi {
  listAssignments(opts?: { status?: string; limit?: number; offset?: number }): Promise<AssignmentRow[]>;
  start(assignmentId: string): Promise<void>;
  message(assignmentId: string, body: string): Promise<void>;
  progress(assignmentId: string, message: string, percent: number): Promise<void>;
  decline(assignmentId: string, reason: DeclineReason, detail: string): Promise<void>;
  submit(assignmentId: string, deliverableMarkdown: string, files: string[]): Promise<void>;
  uploadFile(filename: string, bytes: Uint8Array): Promise<{ fileId: string; fileUrl: string | null }>;
}

export class MarketError extends Error {
  override name = "MarketError";
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly method: string,
    readonly path: string,
    readonly retryAfterMs: number | null = null,
    readonly bodyText = "",
  ) {
    super(message);
  }
  get tooSoon(): boolean {
    return this.status === 409 && (this.code === "progress_report_too_soon" || /too_soon|too soon/i.test(this.bodyText));
  }
}

export interface MarketClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts per call including the first; retried only on 5xx, 429 and network errors. */
  maxAttempts?: number;
  random?: () => number;
}

const TOKEN_RE = /aat_[0-9a-zA-Z_-]{4,}/g;

function scrub(text: string): string {
  return text.replace(TOKEN_RE, "aat_[redacted]");
}

function pickCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const k of ["code", "error", "errorCode", "type"]) {
    const v = b[k];
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const inner = (v as Record<string, unknown>).code ?? (v as Record<string, unknown>).type;
      if (typeof inner === "string") return inner;
    }
  }
  return null;
}

function pickMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const k of ["message", "detail", "error"]) {
    const v = b[k];
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const inner = (v as Record<string, unknown>).message;
      if (typeof inner === "string") return inner;
    }
  }
  return null;
}

export function parseRetryAfter(header: string | null, body: unknown, now = Date.now()): number | null {
  if (body && typeof body === "object") {
    const v = (body as Record<string, unknown>).retry_after ?? (body as Record<string, unknown>).retryAfter;
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v) * 1000;
  }
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export class MarketClient implements MarketApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly random: () => number;

  constructor(opts: MarketClientOptions) {
    const token = opts.token.trim();
    if (!token.startsWith("aat_")) throw new Error("AGENT_MARKET_TOKEN must be an agent API token (it starts with aat_)");
    this.token = token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.random = opts.random ?? Math.random;
  }

  // ------------------------------------------------------------ transport

  private async request<T = unknown>(method: string, path: string, body?: unknown, parse?: (json: unknown) => T): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (attempt < this.maxAttempts) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new MarketError(`${method} ${path}: network error after ${attempt} attempts: ${scrub((e as Error).message)}`, 0, "network", method, path);
      }
      const text = await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      if (res.ok) return parse ? parse(json) : (json as T);
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), json);
      const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
      if (retryable && attempt < this.maxAttempts) {
        await this.sleep(Math.min(60_000, retryAfterMs ?? this.backoff(attempt)));
        continue;
      }
      const code = pickCode(json);
      const msg = pickMessage(json);
      throw new MarketError(
        scrub(`${method} ${path} -> HTTP ${res.status}${code ? ` ${code}` : ""}${msg ? `: ${msg}` : ""}${!code && !msg && text ? `: ${text.slice(0, 200)}` : ""}`),
        res.status,
        code,
        method,
        path,
        retryAfterMs,
        scrub(text.slice(0, 500)),
      );
    }
  }

  private backoff(attempt: number): number {
    return Math.min(20_000, 1000 * 3 ** (attempt - 1)) + Math.floor(this.random() * 250);
  }

  // -------------------------------------------------------------- calls

  async listAssignments(opts: { status?: string; limit?: number; offset?: number } = {}): Promise<AssignmentRow[]> {
    const q = new URLSearchParams();
    if (opts.status) q.set("status", opts.status);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts.offset !== undefined) q.set("offset", String(opts.offset));
    const qs = q.toString();
    return this.request("GET", `/v1/agents/me/assignments${qs ? `?${qs}` : ""}`, undefined, (json) => {
      const raw = json && typeof json === "object" ? (json as { assignments?: unknown }).assignments : undefined;
      if (!Array.isArray(raw)) throw new MarketError("GET /v1/agents/me/assignments: response has no assignments array", 200, "bad_response", "GET", "/v1/agents/me/assignments");
      const rows: AssignmentRow[] = [];
      for (const item of raw) {
        const r = assignmentRowSchema.safeParse(item);
        if (r.success) rows.push(r.data);
      }
      return rows;
    });
  }

  async start(assignmentId: string): Promise<void> {
    await this.request("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/start`);
  }

  async message(assignmentId: string, body: string): Promise<void> {
    await this.request("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/messages`, { body: body.slice(0, 4000) });
  }

  async progress(assignmentId: string, message: string, percent: number): Promise<void> {
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    await this.request("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/progress`, {
      message: message.slice(0, PROGRESS_MESSAGE_MAX) || "working",
      percent: pct,
    });
  }

  async decline(assignmentId: string, reason: DeclineReason, detail: string): Promise<void> {
    await this.request("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/decline`, {
      reason,
      detail: detail.slice(0, DECLINE_DETAIL_MAX),
    });
  }

  async submit(assignmentId: string, deliverableMarkdown: string, files: string[]): Promise<void> {
    if (Buffer.byteLength(deliverableMarkdown, "utf8") > DELIVERABLE_MAX_BYTES) {
      throw new MarketError("submit: deliverableMarkdown is larger than 256 KiB", 0, "deliverable_too_large", "POST", "/submit");
    }
    await this.request("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/submit`, {
      deliverableMarkdown,
      files,
    });
  }

  /** Reserve, PUT the bytes (no auth header on the direct URL), complete. Returns the fileUrl to list in `files`. */
  async uploadFile(filename: string, bytes: Uint8Array): Promise<{ fileId: string; fileUrl: string | null }> {
    const reserved = await this.request("POST", "/v1/files", { filename, byteSize: bytes.byteLength, link: true }, (json) => {
      const r = (json ?? {}) as Record<string, unknown>;
      const fileId = typeof r.fileId === "string" ? r.fileId : typeof r.uploadId === "string" ? r.uploadId : null;
      if (!fileId) throw new MarketError("POST /v1/files: response has no fileId", 200, "bad_response", "POST", "/v1/files");
      return {
        fileId,
        directUploadUrl: typeof r.directUploadUrl === "string" ? r.directUploadUrl : null,
        uploadUrl: typeof r.uploadUrl === "string" ? r.uploadUrl : null,
        fileUrl: typeof r.fileUrl === "string" ? r.fileUrl : null,
      };
    });
    await this.putBytes(reserved.directUploadUrl, reserved.uploadUrl, bytes);
    const completed = await this.request("POST", `/v1/files/${encodeURIComponent(reserved.fileId)}/complete`, undefined, (json) => {
      const r = (json ?? {}) as Record<string, unknown>;
      return { fileUrl: typeof r.fileUrl === "string" ? r.fileUrl : null };
    });
    return { fileId: reserved.fileId, fileUrl: reserved.fileUrl ?? completed.fileUrl };
  }

  private async putBytes(directUploadUrl: string | null, uploadUrl: string | null, bytes: Uint8Array): Promise<void> {
    const body = new Uint8Array(bytes);
    let lastError: string | null = null;
    if (directUploadUrl) {
      try {
        const res = await this.fetchImpl(directUploadUrl, { method: "PUT", body });
        if (res.ok) return;
        lastError = `direct upload -> HTTP ${res.status}`;
      } catch (e) {
        lastError = `direct upload: ${scrub((e as Error).message)}`;
      }
    }
    if (uploadUrl) {
      const url = /^https?:\/\//.test(uploadUrl) ? uploadUrl : `${this.baseUrl}${uploadUrl}`;
      const res = await this.fetchImpl(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${this.token}`, "User-Agent": USER_AGENT },
        body,
      });
      if (res.ok) return;
      lastError = `${lastError ? lastError + "; " : ""}same-origin upload -> HTTP ${res.status}`;
    }
    throw new MarketError(`file upload failed: ${lastError ?? "no upload URL in the reserve response"}`, 0, "upload_failed", "PUT", "/upload");
  }
}
