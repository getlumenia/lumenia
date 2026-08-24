/**
 * Why a claim failed — in words the recipient can act on.
 *
 * The claim route used to catch every failure without binding it (`catch {}`) and render one
 * sentence: "We couldn't finish — your money is still safe. Try again." That is wrong in the most
 * common case. When a link has already been claimed there is nothing to retry and the money is not
 * "waiting" — it is already the recipient's, sitting in their account. Two different people, a
 * month apart, reported the product as broken when it had in fact already paid them.
 *
 * So: classify, then say the true thing. The kinds below are the ones a recipient can distinguish
 * by their next action — claim again, wait, or stop.
 *
 * Robustness rule for this file: it runs inside the claim's catch block, so it must never throw.
 * Every reader is defensive and the fallback is the old retryable message, which is safe advice
 * when we genuinely do not know.
 */

export type ClaimErrorKind =
  /** The balance is already claimed — usually by this same person, on an earlier tap. */
  | "already-claimed"
  /** Rate limited. Real, temporary, and retrying in a moment works. */
  | "busy"
  /** The service is deliberately paused. Retrying now will not help; later will. */
  | "paused"
  /** The device is offline or the service is unreachable. */
  | "offline"
  /** The link itself is incomplete — no bearer key or no balance id. */
  | "link-invalid"
  /** Anything we could not identify. Retryable advice, because we do not know better. */
  | "unknown";

export interface ClaimErrorInfo {
  kind: ClaimErrorKind;
  /** Short technical string, safe to display. Never contains the bearer key. */
  detail: string;
  /** Whether tapping the button again could plausibly succeed. */
  retryable: boolean;
}

/**
 * Horizon reports operation failures inside `extras.result_codes`, and the SDK hangs that off the
 * thrown error's `response.data`. The shape varies across error classes, so rather than trusting one
 * path we flatten the whole thing to a string once and look for the codes we know. Cheap, and it
 * survives an SDK refactor that moves the field.
 */
/**
 * Strip anything that could be a bearer credential before it reaches a screen or a console.
 *
 * The unknown-cause branch renders the raw error text so a bug report can name what happened, and
 * the claim's own key is one string substitution away from any message built along that path. The
 * self-test asserts this, and it caught a real leak here before this existed: keep it.
 *
 * Two shapes matter — a raw Ed25519 secret (`S…`, 56 chars of StrKey base32) and a password-locked
 * link fragment (`p1.<seed>`). Public keys are deliberately left alone; they are public, and
 * redacting them would cost real debuggability for nothing.
 */
function redact(s: string): string {
  return s.replace(/\bS[A-Z2-7]{55}\b/g, "S…").replace(/\bp1\.[A-Za-z0-9_-]{8,}/g, "p1.…");
}

function flatten(err: unknown): string {
  const parts: string[] = [];
  try {
    if (err instanceof Error) parts.push(err.message);
    const anyErr = err as { response?: { status?: number; data?: unknown }; message?: string };
    if (typeof anyErr?.message === "string") parts.push(anyErr.message);
    if (anyErr?.response?.status) parts.push(`status:${anyErr.response.status}`);
    if (anyErr?.response?.data !== undefined) parts.push(JSON.stringify(anyErr.response.data));
    if (parts.length === 0) parts.push(String(err));
  } catch {
    /* a value that resists both String() and JSON — fall through to whatever we collected */
  }
  return redact(parts.join(" ")).slice(0, 2000);
}

/** HTTP status, from either our own `postJson` message ("/feebump → 429: …") or an SDK error. */
function statusOf(blob: string): number | null {
  const arrow = blob.match(/→\s*(\d{3})/);
  if (arrow) return Number(arrow[1]);
  const tagged = blob.match(/status:(\d{3})/);
  if (tagged) return Number(tagged[1]);
  return null;
}

export function classifyClaimError(err: unknown): ClaimErrorInfo {
  const blob = flatten(err);
  const status = statusOf(blob);

  // Explicitly thrown by the claim button before any network call.
  if (/missing key|missing balance/i.test(blob)) {
    return { kind: "link-invalid", detail: blob.slice(0, 120), retryable: false };
  }

  /* Already claimed, seen from either end of runClaim:
   *   - `op_already_exists` — createAccount for an account that exists, i.e. this key claimed before
   *   - `op_does_not_exist` / CLAIMABLE_BALANCE_DOES_NOT_EXIST — the balance is gone, i.e. claimed
   * Both mean the same thing to the recipient: the money already moved. */
  if (/op_already_exists|op_does_not_exist|CLAIMABLE_BALANCE_DOES_NOT_EXIST|op_no_trust/i.test(blob)) {
    return { kind: "already-claimed", detail: "balance already claimed", retryable: false };
  }

  if (status === 429 || /rate limit|too many/i.test(blob)) {
    return { kind: "busy", detail: "rate limited", retryable: true };
  }

  if (status === 503 || /halt|paused|unavailable/i.test(blob)) {
    return { kind: "paused", detail: "service paused", retryable: false };
  }

  // A fetch that never reached a server throws a TypeError with no status.
  if (status === null && /failed to fetch|networkerror|load failed|timeout|aborted/i.test(blob)) {
    return { kind: "offline", detail: "could not reach the service", retryable: true };
  }

  return { kind: "unknown", detail: (status ? `${status} ` : "") + blob.slice(0, 120), retryable: true };
}
