/**
 * What a failure MEANS for the money, decided in one place.
 *
 * The line that matters is the deposit's `onPrepared` hook. Before it, nothing was signed and kept,
 * so any failure is simply "nothing happened". After it, the signed deposit may already be on the
 * ledger, and only the sponsor's OWN refusals prove it is not, each raised before anything is
 * submitted (apps/sponsor/src/worker.ts): the pilot gate (403), the rate limiter (429), the halt
 * switch and the busy network (503, told apart by their sentences, see sponsorWait), and the refusals
 * it states in words, such as the caps and the fee budget (400). Each must come with the sponsor's
 * JSON body: the same status with any other body (a platform error page, a proxy) may have been
 * produced after the submit. A plain 400 is UNCERTAIN on testnet, where every thrown reason is shown,
 * including RPC errors after the submit; on mainnet the Worker hides every reason that is not a
 * stated refusal behind "request failed", so a 400 in other words is a refusal. An uncertain link
 * is settled by reading the escrow, never by sending again.
 */
import { SENDER_DAY_CAP_USD } from "../config";
import { DepositUncertainError, formatUsd } from "../core";
import { CAPS_SENTENCE } from "./copy";
import type { ErrorCode } from "./types";

export class ExtError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExtError";
  }
}

export const NOTHING_MOVED = "It did not go through. Nothing moved, so you can send it again.";

export const MESSAGES: Record<ErrorCode, string> = {
  locked: "Unlock first. Your key is locked after a few minutes without use.",
  "no-account": "Restore your Lumenia account first.",
  "needs-consent": "Read and agree to what this extension sends before it can do anything.",
  "needs-password": "Real money needs an account locked with a password.",
  "needs-backup": "Real money needs this account backed up first. Until then it lives only in this browser.",
  "not-approved": "Real money is invite-only for now. Ask to join with this account.",
  "pilot-unknown": "We couldn't check real money for this account. Try again in a minute.",
  // The standings of LUMENIA ACCOUNT CONTRACT v1, 5.1, without the account's short address (the
  // worker adds it where it knows the account, and the popup shows the full lines).
  "pilot-pending": "You're on the list. We'll email you when this account is approved.",
  "pilot-declined": "Not approved for now. This account isn't approved for real money yet. If you think we got it wrong, reply to our email.",
  "pilot-revoked":
    "Real money is off for this account. Your money stays yours: you can still receive it, cash it out and take links back.",
  "pilot-code-required": "Confirm your email with a code first.",
  "email-taken": "This email already backs up another Lumenia account.",
  "backup-not-mine": "That email doesn't back up this account.",
  "slots-used": "You've used all your real-money sends in the pilot.",
  "over-cap": CAPS_SENTENCE,
  "rate-limited": "Too many tries in a minute. Wait a moment, then try again.",
  halted: "Sending is paused right now. Your money hasn't moved. Try again later.",
  "network-busy": "The network is busy right now. Your money hasn't moved. Try again in a moment.",
  "day-limit": "Lumenia has reached today's limit on what it can cover. Your money hasn't moved. Try again tomorrow, after midnight UTC.",
  offline: "We couldn't reach Lumenia. Your money hasn't moved. Check your connection and try again.",
  uncertain: "We sent it, but couldn't confirm it yet. Don't send it again: we keep checking, and it will show in Links.",
  "bad-amount": "Enter an amount, like 5 or 2.50.",
  "bad-email": "That doesn't look like an email address.",
  "bad-code": "That code is wrong or has expired.",
  "no-backup": "We couldn't find a backup for that email. Back up your account on your account page on getlumenia.com first.",
  "no-password-copy": "This backup opens with a passkey on getlumenia.com only. Add a password on your account page there, then try again.",
  "bad-password": "That password doesn't open this backup.",
  "weak-link-password": "Pick a stronger password for the link.",
  "weak-password": "Use at least 10 characters. This password is the only key to your money.",
  "backup-refused": "That email can't hold this backup. Use another email address.",
  "not-backed-up":
    "This account exists only in this browser. If you forget it here, it and any money in it are gone for good. Back it up first.",
  "unsupported-backup": "This backup has settings this extension doesn't support, so it wasn't opened.",
  "account-not-found": "This account isn't open on this network yet.",
  "not-enough-money": "That's more than you have.",
  busy: "A link is still being made. Wait for it to finish.",
  "open-send":
    "A link you made earlier isn't confirmed yet. If it went through, a new one puts the money in twice. Check Links first, or choose to send a new one anyway.",
  "open-links":
    "Some links you made here are still open, and only this browser lists them. If you forget the account here, you can't take them back later, even after you restore it.",
  "simulation-failed": "We couldn't prepare that transfer. Your money hasn't moved. Check your balance and try again.",
  "sponsor-refused": NOTHING_MOVED,
  "not-found": "That link isn't in this extension.",
  "not-reclaimable": "That link can't be taken back now.",
  "insert-failed": "We couldn't paste it there. Copy the link instead.",
  "host-access": "Allow Lumenia to reach its servers first.",
  internal: "Something went wrong. Your money hasn't moved. Try again.",
};

/**
 * Said before an account whose backup was never confirmed as its own (an older server never said,
 * or the server said it is not tied to it) leaves this browser: it may be lost for good.
 */
export const UNCONFIRMED_LOSS =
  "We can't confirm a backup that opens this account. If it has none, it and any money in it are gone for good once it leaves this browser.";

/**
 * "Forget this account" while links are open: what is at stake, in words. The worker refuses with
 * it and the popup shows it before asking, from the same records.
 */
export function openLinksMessage(open: { amount: string }[]): string {
  const cents = open.reduce((sum, r) => {
    const [whole = "0", frac = ""] = r.amount.split(".");
    return sum + Number(whole) * 100 + Number(`${frac}00`.slice(0, 2));
  }, 0);
  const total = formatUsd(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`);
  const what = open.length === 1 ? `a link that is still open (${total})` : `${open.length} links that are still open (${total} in all)`;
  return `You have ${what}. Only this browser lists ${open.length === 1 ? "it" : "them"}: if you forget the account here, you can't take ${open.length === 1 ? "it" : "them"} back later, even after you restore it. Anyone who has a link can still claim it.`;
}

export function fail(code: ErrorCode, message?: string): ExtError {
  return new ExtError(code, message ?? MESSAGES[code]);
}

const ARROW = "→"; // lumendrop.ts writes "/v2-deposit -> 403: ..." with this arrow

/** The route, status and body of an error lumendrop.ts threw for a non-2xx relay answer. */
export function parseRelayError(msg: string): { route: string; status: number; body: string } | null {
  const m = new RegExp(`^/(v2-deposit|v2-reclaim) ${ARROW} (\\d{3}): ([\\s\\S]*)$`).exec(msg);
  if (!m) return null;
  return { route: m[1]!, status: Number(m[2]), body: m[3] ?? "" };
}

/** The sponsor's own sentence from a `{"error": "..."}` body, if it sent one. */
export function reasonOf(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown };
    return typeof j.error === "string" ? j.error : "";
  } catch {
    return "";
  }
}

const sentence = (s: string): string => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}` : "");

/**
 * Which wait a sponsor sentence names, or null. Keyed on the WORDS, never on the status: the relays'
 * 503 means two different things, the operator's halt and a network that declined to queue the
 * transaction, and every JSON 503 used to read as "Sending is paused right now", so a congested
 * network was presented as Lumenia pausing. The fee budget comes as a 400 and is the third wait.
 * Each is raised before anything is submitted (the halt before the relay runs, the busy network when
 * the RPC refused to queue it, the fee budget before the sponsor signs), so each proves nothing moved.
 */
export function sponsorWait(reason: string): { code: "halted" | "network-busy" | "day-limit"; message: string } | null {
  if (/\bhalted\b/i.test(reason)) return { code: "halted", message: MESSAGES.halted };
  if (/network is busy/i.test(reason)) return { code: "network-busy", message: MESSAGES["network-busy"] };
  if (/fee budget is spent/i.test(reason)) return { code: "day-limit", message: MESSAGES["day-limit"] };
  return null;
}

/** A 403 from the pilot gate, in the words the popup shows. */
function pilotRefusal(reason: string): { code: ErrorCode; message: string } {
  if (/not on the pilot allowlist/i.test(reason)) return { code: "not-approved", message: MESSAGES["not-approved"] };
  if (/pilot limit reached/i.test(reason)) return { code: "slots-used", message: `${MESSAGES["slots-used"]} (${reason})` };
  if (/fail-closed|unavailable|unreadable/i.test(reason)) return { code: "halted", message: MESSAGES.halted };
  return { code: "sponsor-refused", message: reason ? `${sentence(reason)} Nothing moved.` : NOTHING_MOVED };
}

export type DepositVerdict = { kind: "uncertain"; why: string } | { kind: "failed"; code: ErrorCode; message: string };

/** The words the mainnet Worker puts on every reason it hides (apps/sponsor/src/worker.ts). */
export const REDACTED = "request failed";

/**
 * A 400 that is one of the sponsor's stated refusals, all raised before the submit: on mainnet any
 * words but the redaction; on testnet, where every reason is shown, only the deposit refusals we
 * know (apps/sponsor/src/lib/soroban-relay.ts, PublicRefusal).
 */
function isStatedRefusal(reason: string, mainnet: boolean): boolean {
  if (!reason || reason === REDACTED) return false;
  return mainnet || /^(canary cap:|a group link|each share is below|today's sponsor fee budget is spent)/i.test(reason);
}

/**
 * The sponsor's per-sender refusal ("your sends today add up to the per-sender limit of 25.0000000
 * USDC; try again tomorrow") in plain words. The figure is the sponsor's own when it names one, since
 * the sponsor is what enforces it; this build's figure only when it does not.
 */
function senderDayRefusal(why: string): string {
  const named = /per-sender limit of (\d{1,9}(?:\.\d+)?)/i.exec(why)?.[1];
  const usd = named ? formatUsd(named).replace(/\.00$/, "") : `$${SENDER_DAY_CAP_USD}`;
  return `That goes over your limit of ${usd} a day. Nothing moved. Try a smaller amount, or try again tomorrow.`;
}

/** A stated refusal, in the words the popup shows. */
function statedRefusal(reason: string): { code: ErrorCode; message: string } {
  const why = reason.replace(/^canary cap:\s*/i, "");
  const wait = sponsorWait(why);
  if (wait) return wait;
  if (/fail-closed/i.test(why)) return { code: "halted", message: MESSAGES.halted };
  if (/per-drop cap/i.test(why)) return { code: "over-cap", message: MESSAGES["over-cap"] };
  // One sender's share of the day (MAX_DAY_USDC_PER_SENDER): a smaller amount may still fit today.
  if (/per-sender limit/i.test(why)) return { code: "over-cap", message: senderDayRefusal(why) };
  if (/daily escrow cap/i.test(why)) {
    return { code: "sponsor-refused", message: "The pilot's limit for today is reached. Nothing moved. Try again tomorrow." };
  }
  if (/below the minimum/i.test(why)) {
    return { code: "sponsor-refused", message: "That amount is below the smallest link Lumenia covers. Nothing moved." };
  }
  return { code: "sponsor-refused", message: `${sentence(why)} Nothing moved.` };
}

/**
 * A failure AFTER the deposit was signed and kept: provably nothing moved, or uncertain.
 * `mainnet` is the network the deposit was posted to (it decides what a 400 can mean).
 */
export function judgeDepositFailure(e: unknown, ctx: { mainnet: boolean } = { mainnet: false }): DepositVerdict {
  if (e instanceof DepositUncertainError) return { kind: "uncertain", why: "accepted, not yet seen in the escrow" };
  const msg = e instanceof Error ? e.message : String(e);
  // lumendrop.ts read the escrow once, at the bare deadline, and found it empty. That is a strong
  // hint, not proof: this device's clock or a lagging node can be minutes behind the ledger. The
  // settle loop decides with a margin and a second read (links.ts onLanded).
  if (new RegExp(`^/v2-deposit ${ARROW} not submitted:`).test(msg)) return { kind: "uncertain", why: "the escrow was empty at the deadline" };
  if (msg === "couldn't reach the sponsor") return { kind: "uncertain", why: "no answer, and the escrow was empty at the deadline" };
  const r = parseRelayError(msg);
  if (r?.route === "v2-deposit") {
    const reason = reasonOf(r.body);
    if (reason) {
      if (r.status === 403) return { kind: "failed", ...pilotRefusal(reason) };
      if (r.status === 429) return { kind: "failed", code: "rate-limited", message: MESSAGES["rate-limited"] };
      // A 503 is a refusal only in one of the sponsor's own wait sentences; any other words fall
      // through to uncertain, the safe reading of a status alone.
      if (r.status === 503) {
        const wait = sponsorWait(reason);
        if (wait) return { kind: "failed", ...wait };
      }
      if (r.status === 400 && isStatedRefusal(reason, ctx.mainnet)) return { kind: "failed", ...statedRefusal(reason) };
    }
  }
  return { kind: "uncertain", why: r ? `the server answered ${r.status}` : "the answer did not say whether it went through" };
}

/**
 * A failure BEFORE anything was signed and kept: nothing can have moved. Named where we can tell
 * why, so the person is not told to retry something that cannot work.
 */
export function judgePreSubmitError(e: unknown): { code: ErrorCode; message: string } {
  if (e instanceof ExtError) return { code: e.code, message: e.message };
  const msg = e instanceof Error ? e.message : String(e);
  if (/deposit simulation failed/i.test(msg)) {
    // The Stellar Asset Contract's own codes: #10 = not enough balance, #13 = no trustline for it.
    if (/Error\(Contract, #10\)/.test(msg) || /insufficient|balance is not sufficient/i.test(msg)) {
      return { code: "not-enough-money", message: MESSAGES["not-enough-money"] };
    }
    if (/Error\(Contract, #13\)/.test(msg) || /trustline/i.test(msg)) {
      return { code: "account-not-found", message: "This account can't hold dollars on this network yet." };
    }
    return { code: "simulation-failed", message: MESSAGES["simulation-failed"] };
  }
  if (/Account not found/i.test(msg)) return { code: "account-not-found", message: MESSAGES["account-not-found"] };
  if (e instanceof TypeError || /Failed to fetch|NetworkError|network error|fetch failed/i.test(msg)) {
    return { code: "offline", message: MESSAGES.offline };
  }
  return { code: "internal", message: MESSAGES.internal };
}

/** Any error, as the `{code, message}` the popup receives. */
export function toFailure(e: unknown): { code: ErrorCode; message: string } {
  if (e instanceof ExtError) return { code: e.code, message: e.message };
  return judgePreSubmitError(e);
}
