// The shared practice balance, from the browser. The sponsor Worker makes a practice link from its
// own balance (apps/sponsor/src/lib/near-practice.ts, POST `${relayer base}/practice-link`); this tab
// makes the link's key pair and sends ONLY the public key, so the secret that claims the money never
// leaves the browser, and no key of the practice balance is ever part of this app.
//
// Pure orchestration with injected effects, so the order of operations can be tested (the pay-forward
// module's pattern): the link record and its secret are kept BEFORE the request leaves this tab.

import type { RelayOk } from "@lumenia/near/relayer/client";
import { formatUsdc } from "./amount";
import { interpretOutcome } from "./pay-forward";
import type { StoredLink } from "./store";

/** What the Worker holds a practice link to; the screen checks the same lines first. */
export const PRACTICE_COOLDOWN_S = 30;
export const PRACTICE_PER_DAY_PER_CONNECTION = 10;

/** The request body: the PUBLIC key, the amount as a decimal string, the life, an optional memo. */
export interface PracticeLinkBody {
  publicKey: string;
  amountUsdc: string;
  expiresInS: number;
  memo?: string;
}

/** The answer to a link the Worker made: the outcome is the relayer's own shape (RelayOk). */
export interface PracticeLinkOk {
  txHash: string;
  explorerUrl: string;
  /** The account that funded the link on chain (the practice balance). */
  funderId?: string;
  outcome: RelayOk["outcome"];
}

/** Any non-2xx answer: 400 a bad request, 429 a cap, 503 paused or empty, 502 trouble after the caps. */
export class PracticeRequestError extends Error {
  override name = "PracticeRequestError";
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
    readonly retryAfterS?: number,
  ) {
    super(`the practice balance answered ${status} (${code}): ${reason}`);
  }
}

export function practiceLinkUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/practice-link`;
}

/** The body for a stored link: the public key only, never `secret`. */
export function practiceLinkBody(link: Pick<StoredLink, "publicKey" | "amountUnits" | "expiresInS" | "memo">): PracticeLinkBody {
  const memo = (link.memo ?? "").trim();
  return { publicKey: link.publicKey, amountUsdc: formatUsdc(link.amountUnits), expiresInS: link.expiresInS, ...(memo ? { memo } : {}) };
}

function isPracticeOk(v: unknown): v is PracticeLinkOk {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<PracticeLinkOk>;
  const o = r.outcome as Partial<RelayOk["outcome"]> | undefined;
  return typeof r.txHash === "string" && typeof r.explorerUrl === "string" && !!o && typeof o === "object" && (o.status === "success" || o.status === "failure") && Array.isArray(o.failures) && Array.isArray(o.logs);
}

/** POST the body; throws PracticeRequestError on any non-2xx answer or an answer that is not a link. */
export async function requestPracticeLink(base: string, body: PracticeLinkBody, fetchImpl: typeof fetch = fetch): Promise<PracticeLinkOk> {
  const response = await fetchImpl(practiceLinkUrl(base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const b = (json ?? {}) as { reason?: unknown; code?: unknown; error?: unknown; retryAfterS?: unknown };
    const error = typeof b.error === "string" ? b.error : "";
    // The kill switch answers {error: "sponsor temporarily halted"} with no code: it is a pause like any other.
    const code = typeof b.code === "string" ? b.code : error === "sponsor temporarily halted" ? "halted" : /^[a-z_]+$/.test(error) ? error : "http_error";
    const header = Number(response.headers.get("retry-after"));
    const retryAfterS = typeof b.retryAfterS === "number" ? b.retryAfterS : Number.isFinite(header) && header > 0 ? header : undefined;
    throw new PracticeRequestError(response.status, code, typeof b.reason === "string" ? b.reason : error || text || response.statusText, retryAfterS);
  }
  if (!isPracticeOk(json)) throw new PracticeRequestError(502, "bad_answer", "the answer was not a practice link");
  return json;
}

/**
 * The refusals the Worker gives BEFORE it signs anything, by status and code: nothing was sent. Any
 * other failure (a 502 after the caps were spent, an answer that never arrived, an unknown 5xx) may
 * have put a transaction on the network, so its link record is kept and the retry asks the chain first.
 */
const NOTHING_SENT: Record<number, readonly string[]> = {
  400: ["bad_request", "public_key", "amount", "expiry", "memo"],
  429: ["cooldown", "ip_daily", "global_daily"],
  503: ["store_unavailable", "practice_empty", "near_not_configured", "practice_off", "halted"],
};

export function nothingWasSent(e: unknown): boolean {
  if (!(e instanceof PracticeRequestError)) return false;
  if (e.status === 404 || e.status === 405) return true;
  return NOTHING_SENT[e.status]?.includes(e.code) ?? false;
}

/** One honest sentence for whatever the practice request threw. No network is named here. */
export function describePracticeError(e: unknown): string {
  if (e instanceof PracticeRequestError) {
    const wait = e.retryAfterS !== undefined ? `${e.retryAfterS} s` : "a moment";
    switch (e.code) {
      case "cooldown":
        return `One practice link every ${PRACTICE_COOLDOWN_S} seconds. Try again in ${wait}.`;
      case "ip_daily":
        return "This connection has made today's practice links. Try again tomorrow, or use your own account key.";
      case "global_daily":
        return "The shared practice balance has made all of today's links. Try again tomorrow, or use your own account key.";
      case "practice_empty":
        return "The shared practice balance is too low for this amount right now. Nothing was sent. Try a smaller amount, or use your own account key.";
      case "store_unavailable":
        return "Practice links are briefly unavailable. Nothing was sent. Try again in a minute.";
      case "halted":
      case "near_not_configured":
      case "practice_off":
        return "Practice links are paused right now. Nothing was sent. Use your own account key instead, or try again later.";
      default:
        break;
    }
    if (e.status === 400) return `The practice balance could not take this link: ${e.reason}.`;
    if (e.status === 404 || e.status === 405) return "Practice links are not available here yet. Nothing was sent. Use your own account key instead.";
    if (e.status >= 500) return `The practice balance had trouble making the link (${e.reason}). It may still appear: Your links below keeps checking.`;
    return `The practice balance answered ${e.status} (${e.code}): ${e.reason}`;
  }
  if (e instanceof Error) {
    if (/failed to fetch|networkerror|load failed/i.test(e.message)) return `Could not reach the practice balance (${e.message}). Check your connection and try again.`;
    return e.message;
  }
  return String(e);
}

export interface PracticeDeps {
  /** Keeps the record AND the secret; awaited before anything is sent. True when both are on disk. */
  saveLink(link: StoredLink): Promise<boolean>;
  updateLink(patch: Partial<StoredLink> & { publicKey: string }): void;
  /** Drops a record and its secret: only for a fresh link the Worker refused before signing. */
  removeLink(publicKey: string): Promise<unknown>;
  request(body: PracticeLinkBody): Promise<PracticeLinkOk>;
}

export type PracticeResult =
  /** The escrow kept the money and opened the link. */
  | { kind: "created"; link: StoredLink; txHash: string; explorerUrl: string; kept: boolean }
  /** The transaction ran but the escrow handed the money back to the practice balance. */
  | { kind: "refunded"; link: StoredLink; txHash: string; explorerUrl: string; reason: string }
  /** The Worker refused before signing: nothing was sent. A fresh link's record is gone again. */
  | { kind: "refused"; link: StoredLink; error: unknown; message: string; removed: boolean }
  /** Anything else: a transaction may be on the network, so the record stays and a retry asks the chain first. */
  | { kind: "unknown"; link: StoredLink; error: unknown; message: string };

/**
 * One practice link. `retry` marks a link already tried once with an unknown outcome: its record is
 * never removed, because that earlier attempt may have landed.
 */
export async function runPracticeLink(link: StoredLink, deps: PracticeDeps, opts: { retry?: boolean } = {}): Promise<PracticeResult> {
  const own: StoredLink = { ...link, practice: true };
  // 1. The record and the secret exist before the request leaves this tab.
  const kept = await deps.saveLink(own);
  // 2. Only the public key goes out.
  let answer: PracticeLinkOk;
  try {
    answer = await deps.request(practiceLinkBody(own));
  } catch (error) {
    const message = describePracticeError(error);
    if (nothingWasSent(error) && !opts.retry) {
      await deps.removeLink(own.publicKey);
      return { kind: "refused", link: own, error, message, removed: true };
    }
    deps.updateLink({ publicKey: own.publicKey, createError: message });
    return nothingWasSent(error) ? { kind: "refused", link: own, error, message, removed: false } : { kind: "unknown", link: own, error, message };
  }
  // 3. What the Worker answered goes on the record at once: the hash, and the funder the chain will show.
  const funder = answer.funderId ?? own.funder;
  deps.updateLink({ publicKey: own.publicKey, createTxHash: answer.txHash, relayerExplorerUrl: answer.explorerUrl, funder });
  const verdict = interpretOutcome(answer.outcome, own.amountUnits);
  if (!verdict.created) {
    deps.updateLink({ publicKey: own.publicKey, createError: `refunded: ${verdict.reason}` });
    return { kind: "refunded", link: { ...own, funder }, txHash: answer.txHash, explorerUrl: answer.explorerUrl, reason: verdict.reason };
  }
  return { kind: "created", link: { ...own, funder, createTxHash: answer.txHash }, txHash: answer.txHash, explorerUrl: answer.explorerUrl, kept };
}
