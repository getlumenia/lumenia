/**
 * Product-analytics beacon (owner caveat C2 — URL hygiene). The payload NEVER
 * contains location.href or the #fragment (the bearer key). Only an allowlisted
 * event name + a HASHED, truncated claim id — enough to measure the claim→first-send
 * funnel, never enough to reconstruct a link. Fire-and-forget; it must never break
 * or delay the claim (all failures swallowed).
 */
const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
/**
 * Must stay in step with ALLOWED_EVENTS in apps/sponsor/src/lib/events.ts — this list is the one
 * that decides whether a beacon is sent at all, and it had drifted: the send half of the funnel was
 * fired by /send and accepted by the sponsor, but dropped silently HERE, so it was never measured.
 *
 * Honest caveat on what these can answer. The claim events carry a hashed CLAIM id; the send events
 * carry a hashed ACCOUNT. Two different id spaces, so they cannot be joined: this measures how many
 * claims and how many sends happen, NOT whether the same person did both. The real claim→first-send
 * funnel needs one shared id, and the only place to mint it is the claim route — which is frozen
 * grant evidence and out of this change's reach.
 *
 * The request_* events are different, deliberately: all three carry the hashed request NONCE — one
 * id space — so created → opened → paid IS joinable end-to-end (REQUEST_MONEY.md §5.3). A third id
 * space overall; still never joinable to a person. `request_paid` fires when the payer's money is
 * escrowed (for a first-time ask that is link-created time; the asker's own claim still lands in
 * the unjoined claim-id space).
 */
const ALLOWED = new Set([
  "claim_opened",
  "claim_succeeded",
  "claim_failed",
  "send_started",
  "send_link_created",
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
export async function sendEvent(event: string, claimId: string, account?: string): Promise<void> {
  try {
    if (!ALLOWED.has(event)) return;
    if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
    const cid = await hashId(claimId);
    const aid = account ? await hashId(account) : undefined;
    const body = JSON.stringify({ event, cid, ...(aid ? { aid } : {}) }); // NEVER url / fragment (C2)
    // text/plain keeps this a "simple" CORS request (no preflight); response ignored.
    navigator.sendBeacon(`${SPONSOR_URL}/events`, new Blob([body], { type: "text/plain" }));
  } catch {
    /* analytics must never break the claim */
  }
}
