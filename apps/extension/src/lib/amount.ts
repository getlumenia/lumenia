/**
 * The amount a person typed, as the two-decimal string the escrow is asked for.
 *
 * The field already runs every keystroke through sanitizeAmountInput (a decimal comma becomes a
 * point, nothing past two decimals survives); this is the second look, in the worker, because the
 * worker is what signs. Integer cents throughout: no float ever decides an amount.
 */
import { formatUsd, sanitizeAmountInput } from "../core";
import { MIN_USD, TESTNET_MAX_USD, TX_CAP_USD } from "../config";
import type { NetId } from "./types";
import { ExtError, MESSAGES } from "./errors";

/** Whole cents of a decimal-dollar string, or null when it is not one. */
export function centsOf(amount: string): bigint | null {
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(amount.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt(`${m[2] ?? ""}00`.slice(0, 2));
}

export function formatCents(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/**
 * What the amount field can hold: digits, and at most one decimal point or comma. The keystroke
 * sanitizer would turn "-5" into 5, "1e3" into 13 and "0x10" into 10; the field never shows such
 * text, so a request that carries it did not come from what the person saw, and is refused.
 */
const AMOUNT_TEXT = /^\s*\d{0,9}(?:[.,]\d*)?\s*$/;

/**
 * Parse what the person typed into "D.CC", applying the network's limits:
 * at least $0.01; at most $5 on real money (the pilot cap the sponsor enforces only AFTER the
 * transfer is signed, and masks on mainnet); at most $100 on practice money (the testnet sponsor's).
 */
export function parseAmount(raw: string, net: NetId): string {
  if (!AMOUNT_TEXT.test(raw) || !/\d/.test(raw)) throw new ExtError("bad-amount", MESSAGES["bad-amount"]);
  const cleaned = sanitizeAmountInput(raw);
  const cents = centsOf(cleaned);
  if (cents === null || cents <= 0n) throw new ExtError("bad-amount", MESSAGES["bad-amount"]);
  if (cents < centsOf(MIN_USD)!) throw new ExtError("bad-amount", `The smallest link is ${formatUsd(MIN_USD)}.`);
  if (net === "public" && cents > centsOf(TX_CAP_USD)!) throw new ExtError("over-cap", MESSAGES["over-cap"]);
  if (net === "testnet" && cents > centsOf(TESTNET_MAX_USD)!) {
    throw new ExtError("bad-amount", `Practice links go up to ${formatUsd(TESTNET_MAX_USD)}.`);
  }
  return formatCents(cents);
}

/** Is `amount` more than a balance read from Horizon (a 7-decimal string)? Unknown balance = no. */
export function exceedsBalance(amount: string, balance: string | null): boolean {
  if (balance === null) return false;
  const [whole = "0", frac = ""] = balance.split(".");
  const balanceCents = BigInt(whole || "0") * 100n + BigInt(`${frac}00`.slice(0, 2));
  return (centsOf(amount) ?? 0n) > balanceCents;
}
