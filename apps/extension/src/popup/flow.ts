/**
 * The shapes of the send flow the shell keeps while the popup is open: what the person has typed,
 * and which of the four home views (the form, a send in progress, a link ready, a problem) shows.
 */
import { unconfirmedSend } from "../lib/links";
import type { LinkRecord, NetId } from "../lib/types";
import type { Problem } from "./problems";

/** What is in the form. `null` means "not touched: use the default for the money in use". */
export interface Draft {
  amount: string;
  from: string | null;
  lock: boolean | null;
  password: string;
}

export const EMPTY_DRAFT: Draft = { amount: "", from: null, lock: null, password: "" };

/** A refusal that belongs under one field, not in a panel. */
export interface FormError {
  field: "amount" | "password";
  text: string;
}

export type Flow =
  | { kind: "form" }
  | { kind: "sending"; amount: string | null; startedAt: number }
  | { kind: "ready"; record: LinkRecord; link: string | null; inserted: boolean }
  | { kind: "problem"; problem: Problem };

/** How long after making a link the popup still opens straight onto it. */
export const READY_WINDOW_MS = 10 * 60_000;

/** A link that was made a moment ago, confirmed, and still waiting: the one to show again on reopen. */
export function recentReady(records: LinkRecord[], now: number): LinkRecord | null {
  const newest = records[0];
  if (!newest) return null;
  if (newest.phase !== "confirmed" || newest.status !== "pending") return null;
  if (now - newest.createdAt > READY_WINDOW_MS || now >= newest.expiry * 1000) return null;
  return newest;
}

/**
 * A send on this network that is posted but not settled: the Send form asks before a second one is
 * made, with the same rule the worker enforces (lib/links.ts unconfirmedSend).
 */
export function openRecord(records: LinkRecord[], now: number, net: NetId): LinkRecord | null {
  return unconfirmedSend(records, net, now);
}
