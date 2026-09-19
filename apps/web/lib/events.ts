/**
 * Product-analytics beacon (owner caveat C2 — URL hygiene). The payload NEVER
 * contains location.href or the #fragment (the bearer key). Only an allowlisted
 * event name + a HASHED, truncated claim id — enough to measure the claim→first-send
 * funnel, never enough to reconstruct a link. Fire-and-forget; it must never break
 * or delay the claim (all failures swallowed).
 */
import { activeNetwork, type NetworkConfig } from "./network";

/**
 * Where a beacon goes: the sponsor for the network the money is ACTUALLY on.
 *
 * This used to be a module-level constant reading NEXT_PUBLIC_SPONSOR_URL, which is the testnet
 * Worker. Every other client module resolves per network through `activeNetwork()`; this one did
 * not, so every event fired while a device was on real money was posted to the testnet Worker and
 * the mainnet summary answered zero. Nothing that happened on mainnet was measurable, which is a
 * quiet way to have no evidence at all.
 *
 * Resolved per call rather than once at module load, because `activeNetwork()` reads localStorage
 * in the browser and a person can switch networks inside a single session.
 *
 * SECOND FIX (2026-09-18, T-PRE-2): the device flag is the wrong authority on the CLAIM route. A
 * recipient arrives with no prior state, and the link is the only thing that knows its network, so
 * `activeNetwork()` answered "testnet" for every mainnet claim opened on a fresh phone, and the
 * mainnet summary stayed at zero while the testnet one counted claims that never happened there.
 * A caller that knows the network (the claim route resolves it from `?n=`) passes it explicitly;
 * everyone else (send, cash-out, requests: screens a person reaches on their own device's network)
 * keeps the device flag.
 */
function sponsorUrl(net?: NetworkConfig): string {
  if (net?.sponsorUrl) return net.sponsorUrl;
  try {
    const url = activeNetwork().sponsorUrl;
    if (url) return url;
  } catch {
    /* fall through to the build-time default */
  }
  return process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
}
/**
 * Must stay in step with ALLOWED_EVENTS in apps/sponsor/src/lib/events.ts — this list is the one
 * that decides whether a beacon is sent at all, and it had drifted: the send half of the funnel was
 * fired by /send and accepted by the sponsor, but dropped silently HERE, so it was never measured.
 *
 * On ids. The claim events carry a hashed CLAIM id as `cid` and, once the claim has created an
 * account, that account hashed as `aid` (see `sendEvent` below); the send and cash-out events
 * carry the hashed account as both. `aid` is the one id space the funnel is joined on. The
 * request_* events are different, deliberately: all three carry the hashed request NONCE, so
 * created → opened → paid is joinable end-to-end (REQUEST_MONEY.md §5.3), and never to a person.
 * `request_paid` fires when the payer's money is escrowed (for a first-time ask that is
 * link-created time; the asker's own claim lands in the claim-id space).
 */
const ALLOWED = new Set([
  "claim_opened",
  "claim_succeeded",
  "claim_failed",
  "send_started",
  "send_link_created",
  // The share sheet or the copy button on a ready link. A link that was CREATED is not one that
  // was SENT, and the gap between the two is the send flow's own drop-off. Carries the hashed
  // account. Must stay in step with apps/sponsor/src/lib/events.ts.
  "link_shared",
  "request_created",
  "request_opened",
  "request_paid",
  // Cash-out INTENT (analyst rec): a recipient holding dollars tapping "how to turn
  // this into local money" — measures whether people even want to off-ramp vs. are
  // content to hold dollars (the dollarization thesis), instead of asserting it.
  // Carries the hashed account. Must stay in step with apps/sponsor/src/lib/events.ts.
  "cashout_guide_opened",
  // The off-ramp step actually TAKEN (/send-out): dollars sent to an exchange deposit
  // address. cashout_guide_opened measures curiosity; this measures follow-through, and
  // the gap between them is the honest answer to "do people want to off-ramp?".
  // Carries the hashed account. Must stay in step with apps/sponsor/src/lib/events.ts.
  "cashout_sent",
  // The same step through the SEP-6 anchor (/send-out/bank): lira on a bank rail. Kept apart so
  // the anchor leg, the one the hackathon jury weighs, has its own number.
  "cashout_bank_sent",
  // TRY in over SEP-6 (the deposit screen): opened, and completed on chain by the anchor.
  "deposit_started",
  "deposit_completed",
  // A link account funded from another chain via Circle CCTP (relayed by the sponsor).
  "cctp_funded",
  // A link funded by an external Stellar wallet through Stellar Wallets Kit.
  "wallet_funded",
]);

/** Short, non-reversible id for funnel correlation — SHA-256, first 8 bytes. */
async function hashId(id: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
    return Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}

export interface EventOptions {
  /**
   * The network this event belongs to, when the caller knows it better than the device does. The
   * claim route MUST pass the link's network (see `sponsorUrl`). Omit elsewhere.
   */
  net?: NetworkConfig;
  /**
   * The link was funded by the team for the event (public `seeded=1` in the link's query). The
   * sponsor counts seeded activity apart, and it never counts toward sender adoption (H3).
   */
  seeded?: boolean;
  /**
   * `claim_succeeded` only: whole seconds since the claim was opened, measured on this device. The
   * sponsor counts it into buckets (0-15, 15-30, 30-60, 60-120, 120+) and stores nothing per claim.
   */
  durationS?: number;
}

/**
 * `account` is what makes the funnel a funnel.
 *
 * The comment above describes the flaw honestly and then leaves it in place: claim events carried a
 * hashed CLAIM id, send events carried a hashed ACCOUNT, and two id spaces cannot be joined — so the
 * data could say how many claims happened and how many sends happened, and never whether the same
 * person did both. That is H3, the question this whole period exists to answer.
 *
 * The fix needed no new identifier and no change to the claim route. Every claim CREATES an account,
 * so the account was in hand at claim time all along; it simply was not sent. Passing it here puts
 * one id space — `aid` — across both halves, and claimed→acted becomes a set intersection.
 *
 * It stays as non-reversible as the other id: SHA-256 truncated to 8 bytes, hashed on this device,
 * so the server never receives the address it came from. A Stellar address is public data; joining
 * it to behaviour is the part that would be careless, and that is the part this avoids.
 */
export async function sendEvent(event: string, claimId: string, account?: string, opts: EventOptions = {}): Promise<void> {
  try {
    if (!ALLOWED.has(event)) return;
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
    const cid = await hashId(claimId);
    const aid = account ? await hashId(account) : undefined;
    const dur = typeof opts.durationS === "number" && Number.isFinite(opts.durationS) && opts.durationS >= 0 ? Math.floor(opts.durationS) : undefined;
    const body = JSON.stringify({
      event,
      cid,
      ...(aid ? { aid } : {}),
      ...(opts.seeded ? { seeded: 1 } : {}),
      ...(dur !== undefined ? { dur } : {}),
    }); // NEVER url / fragment (C2)
    // text/plain keeps this a "simple" CORS request (no preflight); response ignored.
    navigator.sendBeacon(`${sponsorUrl(opts.net)}/events`, new Blob([body], { type: "text/plain" }));
  } catch {
    /* analytics must never break the claim */
  }
}

/** The public marker a team-funded link carries in its query string (never in the fragment). */
export const SEEDED_PARAM = "seeded";

/** Does this page's URL carry the seeded marker? Read once on the claim route; false elsewhere. */
export function isSeededLink(search: string): boolean {
  try {
    return new URLSearchParams(search).get(SEEDED_PARAM) === "1";
  } catch {
    return false;
  }
}
