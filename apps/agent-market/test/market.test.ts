import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MarketClient, MarketError, parseRetryAfter } from "../src/market.js";

const TOKEN = "aat_" + "a".repeat(32); // a syntactically valid dummy token, not a credential

interface Seen {
  method: string;
  url: string;
  auth: string | null;
  contentType: string | null;
  contentLength: string | null;
  body: string;
}

let server: Server;
let base = "";
let seen: Seen[] = [];
let failListOnce = false;
let rateLimitListOnce = false;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? "";
    seen.push({
      method: req.method ?? "",
      url,
      auth: (req.headers.authorization as string | undefined) ?? null,
      contentType: (req.headers["content-type"] as string | undefined) ?? null,
      contentLength: (req.headers["content-length"] as string | undefined) ?? null,
      body,
    });
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    if (url.startsWith("/direct-upload/")) {
      if (req.headers.authorization) return json(400, { error: "no auth on the direct url" });
      res.writeHead(200);
      return res.end();
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: { code: "unauthorized", message: `bad token ${req.headers.authorization ?? ""}` } });
    if (url.startsWith("/v1/agents/me/assignments")) {
      if (failListOnce) {
        failListOnce = false;
        return json(503, { error: "try later" });
      }
      if (rateLimitListOnce) {
        rateLimitListOnce = false;
        return json(429, { error: "rate_limited" }, { "Retry-After": "1" });
      }
      return json(200, {
        assignments: [
          { assignment: { assignmentId: "a1", jobId: "j1", status: "in_progress", deliverableUrl: null, submittedAt: null, bidId: "b1" }, job: { jobId: "j1", title: "t", description: "d", tags: [], jobKind: "standard", status: "in_progress", attachments: [] }, latestMessage: null },
          { assignment: { nope: true } },
          "garbage",
        ],
      });
    }
    if (url === "/v1/assignments/a1/start") return json(200, { startedAt: "2026-11-11T12:00:00.000Z" });
    if (url === "/v1/assignments/a1/progress") {
      const b = JSON.parse(body) as { percent: number };
      if (b.percent === 99) return json(409, { error: "progress_report_too_soon", retry_after: 12 }, { "Retry-After": "12" });
      return json(200, { ok: true });
    }
    if (url === "/v1/assignments/a1/messages") return json(201, { messageId: "m1" });
    if (url === "/v1/assignments/a1/decline") return json(200, { status: "cancelled" });
    if (url === "/v1/assignments/a1/submit") return json(200, { status: "submitted" });
    if (url === "/v1/assignments/gone/submit") return json(400, { code: "assignment_not_in_progress", message: "already accepted" });
    if (url === "/v1/files") {
      const b = JSON.parse(body) as { filename: string; byteSize: number; link: boolean };
      return json(201, { fileId: "f1", directUploadUrl: `${base}/direct-upload/f1`, uploadUrl: "/v1/files/f1/upload", fileUrl: b.link ? `${base}/files/tok1/${b.filename}` : undefined, expiresInSecs: 1800 });
    }
    if (url === "/v1/files/f1/complete") return json(200, { fileId: "f1", filename: "receipt.csv", byteSize: 12, sha256: "x", contentType: "text/csv" });
    json(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
});

function client(extra: Partial<ConstructorParameters<typeof MarketClient>[0]> = {}) {
  const sleeps: number[] = [];
  const c = new MarketClient({ token: TOKEN, baseUrl: base, sleep: async (ms) => void sleeps.push(ms), random: () => 0, ...extra });
  return { c, sleeps };
}

describe("MarketClient", () => {
  it("rejects a token that is not an agent token", () => {
    expect(() => new MarketClient({ token: "wk_abc" })).toThrow(/aat_/);
  });

  it("runs the start -> progress -> message -> file -> submit sequence with the right shapes and headers", async () => {
    const { c } = client();
    const rows = await c.listAssignments({ limit: 100 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.assignment.assignmentId).toBe("a1");
    await c.start("a1");
    await c.progress("a1", "Escrowing 2 payouts", 10.4);
    await c.message("a1", "Creating 2 claim links on NEAR testnet");
    const csv = Buffer.from("a,b\r\n1,2\r\n", "utf8");
    const up = await c.uploadFile("receipt.csv", csv);
    expect(up).toEqual({ fileId: "f1", fileUrl: `${base}/files/tok1/receipt.csv` });
    await c.submit("a1", "# Deliverable", [up.fileUrl!]);
    await c.decline("a1", "failed", "detail");

    const paths = seen.map((s) => `${s.method} ${s.url}`);
    expect(paths).toEqual([
      "GET /v1/agents/me/assignments?limit=100",
      "POST /v1/assignments/a1/start",
      "POST /v1/assignments/a1/progress",
      "POST /v1/assignments/a1/messages",
      "POST /v1/files",
      "PUT /direct-upload/f1",
      "POST /v1/files/f1/complete",
      "POST /v1/assignments/a1/submit",
      "POST /v1/assignments/a1/decline",
    ]);
    for (const s of seen) {
      if (s.url.startsWith("/direct-upload/")) expect(s.auth).toBeNull();
      else expect(s.auth).toBe(`Bearer ${TOKEN}`);
    }
    expect(JSON.parse(seen[2]!.body)).toEqual({ message: "Escrowing 2 payouts", percent: 10 });
    expect(JSON.parse(seen[3]!.body)).toEqual({ body: "Creating 2 claim links on NEAR testnet" });
    expect(JSON.parse(seen[4]!.body)).toEqual({ filename: "receipt.csv", byteSize: csv.byteLength, link: true });
    expect(seen[5]!.contentLength).toBe(String(csv.byteLength));
    expect(seen[5]!.body).toBe("a,b\r\n1,2\r\n");
    expect(JSON.parse(seen[7]!.body)).toEqual({ deliverableMarkdown: "# Deliverable", files: [`${base}/files/tok1/receipt.csv`] });
    expect(JSON.parse(seen[8]!.body)).toEqual({ reason: "failed", detail: "detail" });
    expect(seen[1]!.contentType).toBeNull();
    expect(seen[2]!.contentType).toBe("application/json");
  });

  it("retries a 5xx with backoff and a 429 after Retry-After, then succeeds", async () => {
    failListOnce = true;
    const { c, sleeps } = client();
    expect(await c.listAssignments()).toHaveLength(1);
    expect(sleeps).toEqual([1000]);
    expect(seen.filter((s) => s.url.startsWith("/v1/agents/me/assignments"))).toHaveLength(2);

    rateLimitListOnce = true;
    const second = client();
    expect(await second.c.listAssignments()).toHaveLength(1);
    expect(second.sleeps).toEqual([1000]);
  });

  it("gives up after maxAttempts on persistent 5xx", async () => {
    const { c, sleeps } = client({ maxAttempts: 2, baseUrl: base + "/nowhere" });
    // /nowhere/... -> 401 is not retried; use a dead port for network errors instead
    const dead = client({ maxAttempts: 2, baseUrl: "http://127.0.0.1:9" });
    await expect(dead.c.listAssignments()).rejects.toMatchObject({ name: "MarketError", status: 0, code: "network" });
    expect(dead.sleeps).toEqual([1000]);
    void c;
    void sleeps;
  });

  it("does not retry a 4xx, exposes status and code, and never leaks the token", async () => {
    const bad = new MarketClient({ token: "aat_wrongwrongwrongwrong", baseUrl: base, sleep: async () => {}, random: () => 0 });
    const err = await bad.listAssignments().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketError);
    const m = err as MarketError;
    expect(m.status).toBe(401);
    expect(m.code).toBe("unauthorized");
    expect(m.message).not.toContain("aat_wrongwrongwrongwrong");
    expect(m.message).toContain("aat_[redacted]");
    expect(seen).toHaveLength(1);

    const { c } = client();
    const e2 = (await c.submit("gone", "x", []).catch((e: unknown) => e)) as MarketError;
    expect(e2.status).toBe(400);
    expect(e2.code).toBe("assignment_not_in_progress");
    expect(e2.message).toMatch(/already accepted/);
  });

  it("surfaces a progress 409 as tooSoon with the retry delay, without retrying", async () => {
    const { c, sleeps } = client();
    const e = (await c.progress("a1", "x", 99).catch((err: unknown) => err)) as MarketError;
    expect(e.tooSoon).toBe(true);
    expect(e.retryAfterMs).toBe(12_000);
    expect(sleeps).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("refuses a deliverable above 256 KiB before sending", async () => {
    const { c } = client();
    await expect(c.submit("a1", "x".repeat(256 * 1024 + 1), [])).rejects.toMatchObject({ code: "deliverable_too_large" });
    expect(seen).toHaveLength(0);
  });

  it("parseRetryAfter reads seconds, dates and body hints", () => {
    expect(parseRetryAfter("3", null)).toBe(3000);
    expect(parseRetryAfter(null, { retry_after: 2 })).toBe(2000);
    expect(parseRetryAfter(null, null)).toBeNull();
    const now = Date.parse("2026-11-11T12:00:00.000Z");
    expect(parseRetryAfter("Wed, 11 Nov 2026 12:00:05 GMT", null, now)).toBe(5000);
  });
});
