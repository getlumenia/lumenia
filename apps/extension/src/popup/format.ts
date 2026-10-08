/**
 * Small pure helpers for the popup: dates in words, a shortened address, whole cents, and the test
 * for "is this worker message a plain sentence a person can read".
 */
import type { PilotInfo } from "../lib/types";

/**
 * The header switch's description of real money, from the pilot answer this browser last got. It was
 * a fixed "invite-only, capped", which stayed on screen after the pilot was retired and told every
 * wallet the sponsor now admitted that it could not use real money. With no answer yet it names
 * only what is true either way: the caps.
 */
export function realMoneyTitle(pilot: PilotInfo | null): string {
  if (!pilot) return "Real money: capped per link";
  if (!pilot.pilot) return "Real money: open to everyone, capped per link";
  return pilot.approved ? "Real money: you're in the pilot, capped per link" : "Real money: invite-only, capped";
}

/** G12345...123456: six characters from each end. */
export function shortAddress(a: string): string {
  return a.length > 15 ? `${a.slice(0, 6)}...${a.slice(-6)}` : a;
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
