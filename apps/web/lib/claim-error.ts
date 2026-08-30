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
  /** The service is deliberately paused. Whether a retry is worth offering depends on how long. */
  | "paused"
  /** The device is offline or the service is unreachable. */
  | "offline"
  /** The link itself is incomplete — no bearer key or no balance id. */
  | "link-invalid"
  /** The device refused to sign what the server sent back. Nothing moved; nothing to retry. */
  | "refused"
  /** Anything we could not identify. Retryable advice, because we do not know better. */
  | "unknown";

export interface ClaimErrorInfo {
  kind: ClaimErrorKind;
  /**
   * Short string, safe to display — our own label, or the server's own wording where that carries
   * a next step the recipient can take. Both claim screens render it. Never contains the bearer key.
   */
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
  // Each distinct part once. A plain Error satisfies both of the first two readers, so an
  // un-deduplicated join prints its message twice — and the message is exactly what the server
  // wrote for the recipient to read on screen, so the doubling is visible, not just untidy.
  const push = (s: string) => {
    if (!parts.includes(s)) parts.push(s);
  };
  try {
    if (err instanceof Error) push(err.message);
    const anyErr = err as { response?: { status?: number; data?: unknown }; message?: string };
    if (typeof anyErr?.message === "string") push(anyErr.message);
    if (anyErr?.response?.status) push(`status:${anyErr.response.status}`);
    if (anyErr?.response?.data !== undefined) push(JSON.stringify(anyErr.response.data));
    if (parts.length === 0) push(String(err));
  } catch {
    /* a value that resists both String() and JSON — fall through to whatever we collected */
  }
  return redact(parts.join(" ")).slice(0, 2000);
}

/**
 * The server's own words for a refusal, when they carry a next step.
 *
 * The sponsor writes its cap and budget refusals for the person who hits them — they name the
 * limit and say when to come back — and marks them so they survive the redaction that collapses
 * every other reason to a reference (apps/sponsor/src/lib/caps.ts). Replacing one with a fixed
 * label discards the only part a recipient can act on: "paused for today … try again tomorrow"
 * and "paused right now; try again shortly" are hours apart and this screen showed both as a
 * short wait.
 *
 * Only a sentence that tells the recipient what to do next is forwarded — the class the sponsor
 * writes deliberately. An operator-facing string ("sponsor temporarily halted") is not one, and
 * stays behind our own label rather than reaching a money screen.
 *
 * Two wire shapes arrive here: lib/sponsor.ts formats a non-2xx as "/path → 400: <body>", while
 * lib/lumendrop.ts rethrows the body's `error` field on its own. The blob is already redacted.
 */
function actionableRefusal(blob: string): string | null {
  const wrapped = blob.match(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const sentence = (wrapped ? wrapped[1]!.replace(/\\(.)/g, "$1") : blob).trim();
  if (!/try again/i.test(sentence)) return null;
  // A refusal written to be read is one sentence long; anything longer is some other error that
  // happens to contain the phrase, and belongs in the fallback.
  return sentence.length <= 160 ? sentence : null;
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

  /* A tx-guard refusal (or the /health canary). It carries no HTTP status and no result code, so
   * without this it landed in "unknown" — which offers a retry that refuses identically forever.
   * The one phrase both refusals end on is the marker; keep it in step with lib/tx-guard.ts. */
  if (/nothing was signed/i.test(blob)) {
    return { kind: "refused", detail: "the server's answer did not match what this app asked for", retryable: false };
  }

  /* Already claimed, seen from either end of runClaim:
   *   - `op_already_exists` — createAccount for an account that exists, i.e. this key claimed before
   *   - `op_does_not_exist` / CLAIMABLE_BALANCE_DOES_NOT_EXIST — the balance is gone, i.e. claimed
   * Both mean the same thing to the recipient: the money already moved.
   *
   * `op_no_trust` does NOT belong here, though it sat here for a while: it means the destination
   * has no USDC trustline yet, and telling someone they already have money they do not is the one
   * thing this screen must never do. It falls through to the retryable fallback, which is true —
   * a retry re-opens the missing trustline. */
  if (/op_already_exists|op_does_not_exist|CLAIMABLE_BALANCE_DOES_NOT_EXIST/i.test(blob)) {
    return { kind: "already-claimed", detail: "balance already claimed", retryable: false };
  }

  if (status === 429 || /rate limit|too many/i.test(blob)) {
    return { kind: "busy", detail: "rate limited", retryable: true };
  }

  /* Three different waits land here: an operator halt (indefinite), a day's onboarding budget
   * spent (until UTC midnight), and a counter the sponsor could not read (seconds). Only the last
   * is worth a button — the screens hide the retry when `retryable` is false, and on the claim
   * route a reload is no substitute, because the bearer key was stripped from the address. So the
   * server's own sentence decides: it is the only thing that knows which wait this is. */
  if (status === 503 || /halt|paused|unavailable/i.test(blob)) {
    const said = actionableRefusal(blob);
    return {
      kind: "paused",
      detail: said ?? "service paused",
      retryable: said !== null && /\bshortly\b|\bin a moment\b/i.test(said),
    };
  }

  // A fetch that never reached a server throws a TypeError with no status.
  if (status === null && /failed to fetch|networkerror|load failed|timeout|aborted/i.test(blob)) {
    return { kind: "offline", detail: "could not reach the service", retryable: true };
  }

  return { kind: "unknown", detail: (status ? `${status} ` : "") + blob.slice(0, 120), retryable: true };
}
