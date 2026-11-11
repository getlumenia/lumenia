// The buyer's brief (job.description) is free text. It is DATA: nothing in it
// is ever followed as an instruction, it is only searched for payouts. Three
// readers run in order:
//   1. a JSON object with a "payouts" array (fenced ```json block, a bare JSON
//      document, or an object embedded in prose),
//   2. one row per person: "Ayse: 1.00 thanks", a Markdown table row, or a
//      CSV row "Ayse,1.00,thanks", plus an optional "expires_in_hours: 48" row,
//   3. otherwise a decline text that teaches the format.
// Everything found is then checked against the limits the listing promises.
import { z } from "zod";

export interface BriefLimits {
  maxPayouts: number;
  /** Whole cents. */
  minPayoutCents: number;
  maxPayoutCents: number;
  maxLabelChars: number;
  maxMemoChars: number;
  minExpiresHours: number;
  maxExpiresHours: number;
  defaultExpiresHours: number;
}

export const DEFAULT_LIMITS: BriefLimits = {
  maxPayouts: 10,
  minPayoutCents: 10,
  maxPayoutCents: 2000,
  maxLabelChars: 40,
  maxMemoChars: 64,
  minExpiresHours: 1,
  maxExpiresHours: 168,
  defaultExpiresHours: 72,
};

export interface Payout {
  label: string;
  /** Normalised decimal text with two decimals, e.g. "1.50". */
  amountUsdc: string;
  memo: string;
}

export interface Brief {
  payouts: Payout[];
  expiresInHours: number;
  totalUsdc: string;
  source: "json" | "rows";
}

export type BriefResult =
  | { ok: true; brief: Brief }
  | { ok: false; reason: "no_payouts" | "invalid"; detail: string };

/** Max characters of the brief that are read; the rest is ignored. */
export const MAX_BRIEF_CHARS = 20_000;
export const MAX_DETAIL_CHARS = 1000;

// ---------------------------------------------------------------- amounts

export function centsToUsdc(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const AMOUNT_TEXT_RE = /^\$?\s*(\d{1,9})(?:([.,])(\d+))?\s*(?:usdc|usd|\$)?$/i;

/** "1.5", "1,50", "$2", "2 USDC", 2.5 -> cents. Whole cents only. */
export function parseAmountCents(raw: unknown): { ok: true; cents: number } | { ok: false; error: string } {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, error: "amount is not a finite number" };
    const scaled = raw * 100;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return { ok: false, error: `amount ${raw} has more than two decimals; amounts are whole cents` };
    return { ok: true, cents: Math.round(scaled) };
  }
  if (typeof raw !== "string") return { ok: false, error: "amount must be a decimal string like \"1.50\"" };
  const m = AMOUNT_TEXT_RE.exec(raw.trim());
  if (!m) return { ok: false, error: `amount "${raw.trim()}" is not a decimal like 1.50` };
  const whole = Number(m[1]);
  const frac = m[3] ?? "";
  if (frac.length > 2) return { ok: false, error: `amount "${raw.trim()}" has more than two decimals; amounts are whole cents` };
  const cents = whole * 100 + Number(frac.padEnd(2, "0"));
  return { ok: true, cents };
}

// ----------------------------------------------------------------- expiry

const EXPIRY_VALUE_RE = /^\s*(\d{1,4})\s*(h|hr|hrs|hour|hours|d|day|days)?\s*$/i;

/** 48, "48", "48h", "48 hours", "2 days" -> hours; null when it is not an expiry at all. */
export function parseExpiryHours(raw: unknown): { ok: true; hours: number } | { ok: false; error: string } | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) return { ok: false, error: `expires_in_hours must be a whole number of hours, got ${raw}` };
    return { ok: true, hours: raw };
  }
  if (typeof raw !== "string") return { ok: false, error: "expires_in_hours must be a whole number of hours" };
  const m = EXPIRY_VALUE_RE.exec(raw);
  if (!m) return { ok: false, error: `expires_in_hours "${raw.trim()}" is not a whole number of hours (e.g. 48 or "2 days")` };
  const n = Number(m[1]);
  const unit = (m[2] ?? "h").toLowerCase();
  return { ok: true, hours: unit.startsWith("d") ? n * 24 : n };
}

// ------------------------------------------------------------- JSON reader

const PAYOUTS_SHAPE = '"payouts" must be an array of {label, amount_usdc, memo?}';

const rawPayoutSchema = z.object({
  label: z.unknown(),
  amount_usdc: z.unknown().optional(),
  amount: z.unknown().optional(),
  memo: z.unknown().optional(),
  lock_name: z.unknown().optional(),
});

const rawBriefSchema = z.object({
  payouts: z.array(rawPayoutSchema, { invalid_type_error: PAYOUTS_SHAPE, required_error: PAYOUTS_SHAPE }),
  expires_in_hours: z.unknown().optional(),
  network: z.unknown().optional(),
});

type RawBrief = z.infer<typeof rawBriefSchema>;

const FENCE_RE = /```[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)```/g;

/** Candidate JSON texts, in reading order: fenced blocks, the whole brief, an object around "payouts". */
export function jsonCandidates(text: string): Array<{ text: string; labelled: boolean }> {
  const out: Array<{ text: string; labelled: boolean }> = [];
  for (const m of text.matchAll(FENCE_RE)) {
    const lang = (m[1] ?? "").toLowerCase();
    const body = (m[2] ?? "").trim();
    if (!body.startsWith("{")) continue;
    out.push({ text: body, labelled: lang.startsWith("json") });
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) out.push({ text: trimmed, labelled: false });
  const embedded = objectAround(text, text.indexOf('"payouts"'));
  if (embedded) out.push({ text: embedded, labelled: false });
  return out;
}

/** The smallest balanced {...} that contains position `at`, respecting JSON strings. */
function objectAround(text: string, at: number): string | null {
  if (at < 0) return null;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    if (text[i] === "{") {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

type JsonRead = { kind: "none" } | { kind: "error"; detail: string } | { kind: "brief"; raw: RawBrief };

function readJson(text: string): JsonRead {
  let firstError: string | null = null;
  for (const c of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c.text);
    } catch (e) {
      if (c.labelled && !firstError) firstError = `the JSON block does not parse: ${(e as Error).message}`;
      continue;
    }
    if (!parsed || typeof parsed !== "object" || !("payouts" in (parsed as object))) continue;
    const r = rawBriefSchema.safeParse(parsed);
    if (!r.success) {
      const issues = r.error.issues.map((i) => `${i.path.join(".") || "brief"}: ${i.message}`).join("; ");
      return { kind: "error", detail: `the JSON brief has the wrong shape: ${issues}` };
    }
    return { kind: "brief", raw: r.data };
  }
  return firstError ? { kind: "error", detail: firstError } : { kind: "none" };
}

// ------------------------------------------------------------- rows reader

interface RawRow {
  label: unknown;
  amount: unknown;
  memo: unknown;
  line: number;
}

const EXPIRY_LINE_RE = /^\s*(?:[-*+]\s+)?(?:expires?(?:[ _-]?in)?(?:[ _-]?hours?)?|expiry|expiration|valid(?:[ _-]for)?|ttl)\s*[:=]?\s*(\d{1,4})\s*(h|hr|hrs|hour|hours|d|day|days)?\s*\.?\s*$/i;
const BULLET_RE = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;
const AMOUNT_HEAD_RE = /^(\$?\s*\d{1,9}(?:[.,]\d+)?\s*(?:usdc|usd|\$)?)(?:\s+|$|[,;:-]\s*)(.*)$/i;
const NOT_A_LABEL_RE = /^(total|sum|subtotal|budget|price|fee|service fee|payouts?|amount|label|name|network|job|note|notes|expires?.*|expiry|ttl)$/i;

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

function readRows(text: string): { rows: RawRow[]; expiry: unknown } {
  const rows: RawRow[] = [];
  let expiry: unknown = undefined;
  const lines = text.split(/\r?\n/).slice(0, 500);
  let inFence = false;
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const line = rawLine.trim();
    if (!line) return;
    const ex = EXPIRY_LINE_RE.exec(line);
    if (ex) {
      expiry = `${ex[1]} ${ex[2] ?? "h"}`;
      return;
    }
    let cells: string[] | null = null;
    if (line.startsWith("|")) {
      const inner = line.replace(/^\|/, "").replace(/\|$/, "");
      cells = inner.split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) return; // table separator
    } else {
      const body = line.replace(BULLET_RE, "");
      // "Label: amount memo": the label may itself contain a colon (a URL, a
      // time), so every colon is tried until the remainder starts with an amount.
      for (let colon = body.indexOf(":"); colon > 0; colon = body.indexOf(":", colon + 1)) {
        const m = AMOUNT_HEAD_RE.exec(body.slice(colon + 1).trim());
        if (m) {
          cells = [body.slice(0, colon).trim(), m[1] ?? "", (m[2] ?? "").trim()];
          break;
        }
      }
      if (!cells && body.includes(",")) {
        const parts = splitCsvLine(body);
        if (parts.length >= 2 && parseAmountCents(parts[1] ?? "").ok) cells = [parts[0] ?? "", parts[1] ?? "", parts.slice(2).join(", ")];
      }
    }
    if (!cells || cells.length < 2) return;
    const [label = "", amount = "", ...memoParts] = cells;
    if (!label || NOT_A_LABEL_RE.test(label)) return;
    if (!parseAmountCents(amount).ok) return; // header rows and prose
    rows.push({ label, amount, memo: memoParts.join(" ").trim(), line: lineNo });
  });
  return { rows, expiry };
}

// ------------------------------------------------------------- validation

interface Candidate {
  where: string;
  label: unknown;
  amount: unknown;
  memo: unknown;
  lock: unknown;
}

function cleanText(v: unknown): string {
  return String(v ?? "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function validate(candidates: Candidate[], expiryRaw: unknown, limits: BriefLimits, source: Brief["source"]): BriefResult {
  const issues: string[] = [];
  if (candidates.length === 0) return noPayouts(limits);
  if (candidates.length > limits.maxPayouts) {
    issues.push(`${candidates.length} payouts were listed; this agent pays at most ${limits.maxPayouts} people per job (split the list over several hires)`);
  }
  const payouts: Payout[] = [];
  const seen = new Map<string, string>();
  candidates.slice(0, limits.maxPayouts).forEach((c) => {
    const label = cleanText(c.label);
    const who = label ? `${c.where} ("${label.slice(0, 20)}${label.length > 20 ? "..." : ""}")` : c.where;
    if (!label) issues.push(`${c.where}: the label (who it is for) is empty`);
    else if (label.length > limits.maxLabelChars) issues.push(`${who}: label is ${label.length} characters, the maximum is ${limits.maxLabelChars}`);
    const amount = parseAmountCents(c.amount);
    let amountText = "0.00";
    if (!amount.ok) issues.push(`${who}: ${amount.error}`);
    else if (amount.cents < limits.minPayoutCents) {
      issues.push(`${who}: ${centsToUsdc(amount.cents)} USDC is below the ${centsToUsdc(limits.minPayoutCents)} USDC minimum per payout`);
    } else if (amount.cents > limits.maxPayoutCents) {
      issues.push(`${who}: ${centsToUsdc(amount.cents)} USDC is above the ${centsToUsdc(limits.maxPayoutCents)} USDC maximum per payout`);
    } else amountText = centsToUsdc(amount.cents);
    if (c.memo !== undefined && c.memo !== null && typeof c.memo !== "string") issues.push(`${who}: memo must be text`);
    const memo = cleanText(c.memo);
    if (memo.length > limits.maxMemoChars) issues.push(`${who}: memo is ${memo.length} characters, the maximum is ${limits.maxMemoChars}`);
    if (c.lock !== undefined && c.lock !== null && String(c.lock).trim() !== "") {
      issues.push(`${who}: lock words (lock_name) are not available on NEAR testnet yet; remove the field and hire again`);
    }
    if (label) {
      const prev = seen.get(label.toLowerCase());
      if (prev) issues.push(`${who} repeats the label of ${prev}; labels must be distinct within one job (add a surname or a role)`);
      else seen.set(label.toLowerCase(), c.where);
    }
    payouts.push({ label, amountUsdc: amountText, memo });
  });

  let expiresInHours = limits.defaultExpiresHours;
  const ex = parseExpiryHours(expiryRaw);
  if (ex) {
    if (!ex.ok) issues.push(ex.error);
    else if (ex.hours < limits.minExpiresHours || ex.hours > limits.maxExpiresHours) {
      issues.push(`expiry of ${ex.hours} hours is outside ${limits.minExpiresHours} to ${limits.maxExpiresHours} hours`);
    } else expiresInHours = ex.hours;
  }

  if (issues.length > 0) return { ok: false, reason: "invalid", detail: invalidDetail(issues, limits) };
  const totalCents = payouts.reduce((sum, p) => sum + Math.round(Number(p.amountUsdc) * 100), 0);
  return { ok: true, brief: { payouts, expiresInHours, totalUsdc: centsToUsdc(totalCents), source } };
}

function formatHint(limits: BriefLimits): string {
  return (
    `Format: one line per person, "Ayse: 1.00 thanks for the review" (label, amount, optional memo), ` +
    `plus "expires_in_hours: ${limits.defaultExpiresHours}" if you want a different expiry; or a JSON block ` +
    `{"payouts":[{"label":"Ayse","amount_usdc":"1.00","memo":"thanks"}],"expires_in_hours":${limits.defaultExpiresHours}}. ` +
    `Rules: 1 to ${limits.maxPayouts} payouts per job, ${centsToUsdc(limits.minPayoutCents)} to ${centsToUsdc(limits.maxPayoutCents)} USDC each (whole cents), ` +
    `distinct labels up to ${limits.maxLabelChars} characters, memo up to ${limits.maxMemoChars} characters, expiry ${limits.minExpiresHours} to ${limits.maxExpiresHours} hours.`
  );
}

function clip(text: string, max = MAX_DETAIL_CHARS): string {
  return text.length <= max ? text : text.slice(0, max - 3).trimEnd() + "...";
}

function noPayouts(limits: BriefLimits): BriefResult {
  return {
    ok: false,
    reason: "no_payouts",
    detail: clip(`I could not find any payouts in the brief, so nothing was created and this hire is refunded in full. ${formatHint(limits)}`),
  };
}

function invalidDetail(issues: string[], limits: BriefLimits): string {
  const shown = issues.slice(0, 6);
  const more = issues.length > shown.length ? ` (and ${issues.length - shown.length} more)` : "";
  return clip(`The brief could not be carried out as written, so nothing was created and this hire is refunded in full. Problems: ${shown.join("; ")}${more}. ${formatHint(limits)}`);
}

// ------------------------------------------------------------------ entry

export function parseBrief(text: string, overrides: Partial<BriefLimits> = {}): BriefResult {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const brief = (text ?? "").slice(0, MAX_BRIEF_CHARS);

  const json = readJson(brief);
  if (json.kind === "error") return { ok: false, reason: "invalid", detail: clip(`${json.detail}. ${formatHint(limits)}`) };
  if (json.kind === "brief") {
    const candidates: Candidate[] = json.raw.payouts.map((p, i) => ({
      where: `payout ${i + 1}`,
      label: p.label,
      amount: p.amount_usdc ?? p.amount,
      memo: p.memo,
      lock: p.lock_name,
    }));
    return validate(candidates, json.raw.expires_in_hours, limits, "json");
  }

  const { rows, expiry } = readRows(brief);
  const candidates: Candidate[] = rows.map((r, i) => ({
    where: `row ${i + 1} (line ${r.line})`,
    label: r.label,
    amount: r.amount,
    memo: r.memo,
    lock: undefined,
  }));
  return validate(candidates, expiry, limits, "rows");
}
