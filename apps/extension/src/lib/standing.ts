/**
 * Where an account stands with real money, read from the mainnet sponsor's /pilot-status answer, and
 * the words for each standing (LUMENIA ACCOUNT CONTRACT v1, sections 4 and 5.1). The website keeps
 * its own copy of the same table and the same sentences; the self-tests hold both to the contract's
 * golden rows, so one account shows the same standing on every surface.
 *
 * Pure: no storage, no network. A failed ask is "unknown" and is never shown as "not approved".
 */
import { ExtError, MESSAGES } from "./errors";
import { shortAddress } from "./identity";
import type { ErrorCode } from "./types";

export type Standing = "open" | "none" | "pending" | "approved" | "no-sends" | "declined" | "revoked" | "unknown";

/**
 * The standing an answer means. `read` is the answer as the sponsor sent it or as the worker keeps it
 * (PilotInfo); null, or `failed`, is an ask that did not get one: a network error, any non-2xx
 * (429 and 503 included), a body that is not JSON. The rows are read top to bottom.
 */
export function pilotStanding(read: unknown, opts: { failed?: boolean } = {}): Standing {
  if (opts.failed || !read || typeof read !== "object") return "unknown";
  const r = read as Record<string, unknown>;
  if (typeof r.pilot !== "boolean") return "unknown";
  if (r.pilot === false) return "open";
  if (typeof r.state !== "string") return "unknown";
  const used = typeof r.used === "number" ? r.used : Number.NaN;
  const limit = typeof r.limit === "number" ? r.limit : Number.NaN;
  switch (r.state) {
    case "approved":
      if (r.approved !== true) return "revoked";
      return limit > 0 && used >= limit ? "no-sends" : "approved";
    case "pending":
      return "pending";
    case "rejected":
      return r.revoked === true ? "revoked" : "declined";
    case "none":
      return "none";
    default:
      return "unknown";
  }
}

export interface StandingCopy {
  title: string;
  line: string;
  /** the one thing to do about it, or null when there is nothing to do */
  action: string | null;
}

/** Said while a check is on its way. */
export const CHECKING = "Checking real money for this account.";

const KEEPS = "Your money stays yours: you can still receive it, cash it out and take links back.";

/**
 * The contract's words for a standing. `short` is the short address of the account in use; without
 * one (no account known yet) the sentences name "this account" alone. A limit the sponsor did not
 * report (0) is not read out as "0 of 0".
 */
export function standingCopy(s: Standing, v: { short: string; left?: number; limit?: number }): StandingCopy {
  const { short } = v;
  const limit = v.limit ?? 0;
  const left = v.left ?? 0;
  const This = short ? `This account (${short})` : "This account";
  const thisOne = short ? `this account (${short})` : "this account";
  switch (s) {
    case "none":
      return { title: "Real money is invite-only for now.", line: `Ask to join with ${thisOne}.`, action: "Ask to join" };
    case "pending":
      return { title: "You're on the list.", line: `We'll email you when ${thisOne} is approved.`, action: "Check again" };
    case "approved":
      return {
        title: "You're approved for real money.",
        line: limit > 0 ? `${This} has ${left} of ${limit} real-money sends left.` : `${This} is approved for real money.`,
        action: "Switch to real money",
      };
    case "no-sends":
      return {
        title: "No real-money sends left.",
        line: `${This} has used all ${limit > 0 ? `${limit} ` : ""}of its real-money sends. ${KEEPS}`,
        action: "Ask for more sends",
      };
    case "declined":
      return {
        title: "Not approved for now.",
        line: `${This} isn't approved for real money yet. If you think we got it wrong, reply to our email.`,
        action: null,
      };
    case "revoked":
      return { title: "Real money is off for this account.", line: `We took ${thisOne} off real money. ${KEEPS}`, action: null };
    case "open":
      return { title: "Real money is open to everyone.", line: "Every link is capped.", action: "Switch to real money" };
    case "unknown":
      return { title: "We couldn't check real money for this account.", line: "Try again in a minute.", action: "Try again" };
  }
}

/** Sends left on an answer, never below zero. */
export function sendsLeft(p: { used: number; limit: number }): number {
  return Math.max(0, p.limit - p.used);
}

/**
 * What a standing refuses, as the worker's error code, or null when it lets the person through.
 * Switching to real money lets a person with no sends left in (they can still see the balance and
 * take links back); making a link does not.
 */
export function standingRefusal(s: Standing, purpose: "switch" | "send"): ErrorCode | null {
  switch (s) {
    case "approved":
    case "open":
      return null;
    case "no-sends":
      return purpose === "send" ? "slots-used" : null;
    case "none":
      return "not-approved";
    case "pending":
      return "pilot-pending";
    case "declined":
      return "pilot-declined";
    case "revoked":
      return "pilot-revoked";
    case "unknown":
      return "pilot-unknown";
  }
}

/**
 * The worker's refusal for a standing, in the contract's words with the account's short address, or
 * null when the standing lets the person through.
 */
export function standingError(
  s: Standing,
  purpose: "switch" | "send",
  account: { pubkey: string; used?: number; limit?: number },
): ExtError | null {
  const code = standingRefusal(s, purpose);
  if (!code) return null;
  if (code === "pilot-unknown") return new ExtError(code, MESSAGES[code]);
  const limit = account.limit ?? 0;
  const c = standingCopy(s, { short: shortAddress(account.pubkey), limit, left: Math.max(0, limit - (account.used ?? 0)) });
  return new ExtError(code, `${c.title} ${c.line}`);
}
