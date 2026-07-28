/**
 * POST /events — ONE structured-log beacon for the claim→first-send funnel
 * (FRONTEND_PLAN §4.3). Not Mixpanel/PostHog/dashboards — just allowlisted event
 * names written to stdout (Vercel logs). No PII: the client sends only an event
 * name + a HASHED, truncated claim id (see apps/web/lib/events.ts, owner caveat C2).
 */
const ALLOWED_EVENTS = new Set<string>([
  "claim_opened",
  "claim_succeeded",
  "claim_failed",
  "send_started",
  "send_link_created",
  // request money — all three carry the hashed request NONCE (one joinable id
  // space; see apps/web/lib/events.ts). Must stay in step with that file.
  "request_created",
  "request_opened",
  "request_paid",
  // Cash-out intent — a recipient tapping "how to turn dollars into local money".
  // Measures off-ramp demand vs. hold-dollars behavior. Carries the hashed account.
  // Must stay in step with apps/web/lib/events.ts.
  "cashout_guide_opened",
  // The off-ramp step actually TAKEN — dollars sent out to an exchange deposit
  // address (/send-out). Paired with cashout_guide_opened it separates people who
  // read about cashing out from people who did it. Carries the hashed account.
  "cashout_sent",
]);

export interface EventInput {
  event?: string;
  cid?: string;
}

/** Validate + log. Throws on an unknown event (caller may still 200 the beacon). */
export function handleEvent(input: EventInput): { ok: true } {
  if (!input.event || !ALLOWED_EVENTS.has(input.event)) {
    throw new Error("unknown event");
  }
  const cid = typeof input.cid === "string" ? input.cid.slice(0, 32) : null;
  console.log(`[event] ${JSON.stringify({ event: input.event, cid })}`);
  return { ok: true };
}
