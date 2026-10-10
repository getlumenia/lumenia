/**
 * Small pure helpers for the popup: dates in words, a shortened address, a masked email, the
 * account line, the restore and ask-to-join results, whole cents, and the test for "is this worker
 * message a plain sentence a person can read".
 */
import type { ResponseMap } from "../lib/messages";
import { maskEmail, shortAddress } from "../lib/identity";
import { pilotStanding, standingCopy } from "../lib/standing";
import type { PilotInfo } from "../lib/types";

export { maskEmail, shortAddress };

/**
 * The header switch's description of real money, from the pilot answer this browser last got, in the
 * standing's own words (lib/standing.ts), so the switch never says "invite-only" to an account that
 * is waiting, declined or approved. With no answer yet it names only what is true either way: the caps.
 */
export function realMoneyTitle(pilot: PilotInfo | null, short = ""): string {
  if (!pilot) return "Real money: capped per link";
  const { title } = standingCopy(pilotStanding(pilot), { short, left: Math.max(0, pilot.limit - pilot.used), limit: pilot.limit });
  return /real[- ]money/i.test(title) ? title : `Real money. ${title}`;
}

/** What one account line says (LUMENIA ACCOUNT CONTRACT v1, 5.3), and the one thing to do about it. */
export interface AccountLine {
  text: string;
  action: { kind: "add-email" | "back-up-again"; label: string } | null;
}

/**
 * The account in use, as every surface names it: its short address and the email it is backed up
 * with. `needed`: the account may exist only in this browser (BackupView.needed).
 */
export function accountLine(a: { pubkey: string; email: string | null; bound: boolean | null }, needed: boolean): AccountLine {
  const short = shortAddress(a.pubkey);
  // The way to back it up sits right next to this line on every screen that shows it (the banner,
  // the Settings note), so the line itself carries no second "Back it up".
  if (needed) return { text: `${short}, not backed up yet`, action: null };
  if (a.bound === false) return { text: `${short}, backup not tied to this account yet`, action: { kind: "back-up-again", label: "Back it up again" } };
  if (a.email) return { text: `${short}, backed up with ${maskEmail(a.email)}`, action: null };
  return { text: `${short}, backed up`, action: { kind: "add-email", label: "Add your backup email" } };
}

/** A restore's result (LUMENIA ACCOUNT CONTRACT v1, 5.5): "This is GCFIRY...XVYOJR, backed up with f***@example.com." */
export function restoredLine(r: { pubkey: string; email: string }): string {
  return `This is ${shortAddress(r.pubkey)}, backed up with ${maskEmail(r.email)}.`;
}

/**
 * What an ask to join real money (or for more sends) answered, in the contract's words (5.2),
 * naming the account and the masked email. A request that turned out to be decided already is said
 * as that standing.
 */
export function askResultCopy(
  a: ResponseMap["pilot.request"],
  v: { short: string; masked: string; limit: number; left: number },
): { title: string; line: string } {
  const { short, masked } = v;
  if (a.state === "rejected" || a.standing === "declined" || a.standing === "revoked") {
    const c = standingCopy(a.standing === "revoked" ? "revoked" : "declined", v);
    return { title: c.title, line: c.line };
  }
  if (a.state === "approved") {
    if (a.standing === "approved" || a.standing === "open") {
      const c = standingCopy(a.standing, v);
      return { title: c.title, line: c.line };
    }
    const line = `We'll email ${masked} when this account (${short}) can send again.`;
    return a.filed ? { title: "Asked for more sends.", line } : { title: "You've already asked for more sends.", line };
  }
  if (a.already) return { title: "You've already asked.", line: `This account (${short}) is on the list. We'll email ${masked} when it is approved.` };
  return { title: "Request sent.", line: `We'll email ${masked} when this account (${short}) is approved.` };
}

/** Whole cents of a decimal string ("12.5" is 1250), or null when it is not a plain amount. No float rounding. */
export function centsOf(s: string | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  const m = /^(\d{1,12})(?:\.(\d*))?$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number(`${m[2] ?? ""}00`.slice(0, 2));
}

/** "Oct 3, 2:15 PM" in the person's own locale. */
export function when(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** "October 10" in the person's own locale, from unix seconds. */
export function dayWords(unixSeconds: number): string {
  try {
    return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { month: "long", day: "numeric" });
  } catch {
    return "";
  }
}

// Words that mean the message is a log line, not a sentence for a person.
const TECHNICAL =
  /\b(xdr|soroban|fee[- ]?bump|https?|rpc|horizon|stack|exception|undefined|null|nan|json|api)\b|[{}<>\\]|\b[45]\d\d\b|Error\(|\bop_|\btx_|0x[0-9a-f]{4,}/i;
// Words the product never says on a money screen.
const OFF_LIMITS = /\b(gasless|bank|yield|savings|deposit|interest|trustless)\b/i;

/**
 * The worker's own sentence, when it is one: starts with a capital, ends with a stop, is not too
 * short or too long, carries no technical term, and loses any trailing "(detail)". Otherwise null,
 * and the caller uses its own copy.
 */
export function plainSentence(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (s.length < 8 || s.length > 260) return null;
  if (!/^[A-Z]/.test(s) || !/[.!?]$/.test(s)) return null;
  if (TECHNICAL.test(s) || OFF_LIMITS.test(s)) return null;
  return s;
}
