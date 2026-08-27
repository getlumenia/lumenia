/**
 * /waitlist — the only PII Lumenia stores (FRONTEND_PLAN §1: notify-me emails).
 * Kept in an ISOLATED store, keyed by list name, NEVER joined to a pubkey or any
 * money data. Reuses the Upstash REST pair (if configured) as a set; falls back to
 * a structured log otherwise.
 *
 * Three lists, kept SEPARATE on purpose rather than merged into one "interested" bucket:
 *   "waitlist" — tell me when real money goes live (the landing's capture)
 *   "cashout"  — tell me when turning dollars into local cash is real
 *   "pilot"    — asked for a real-money invite from onboarding, with no account yet to approve
 * They are separate because each is a different question, and because the first one's count is
 * quoted as evidence in a funding document — folding a different intent into it would quietly
 * change a number somebody else is relying on.
 */
import { kvConfigFromEnv } from "./rate-limit.js";

const LISTS = new Set<string>(["waitlist", "cashout", "pilot"]);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Returns whether this address was NEW to the list. The caller uses it to decide whether anyone
 * needs telling: a set makes a repeat sign-up a no-op, and a repeat should not become a repeat
 * notification.
 */
export async function saveContact(list: string, email: string): Promise<{ ok: true; added: boolean }> {
  if (!LISTS.has(list)) throw new Error("unknown list");
  const clean = email.trim().toLowerCase();
  if (clean.length > 200 || !EMAIL_RE.test(clean)) throw new Error("invalid email");

  const kv = kvConfigFromEnv();
  if (!kv) {
    // No store configured — log it (isolated: list + email only, never a pubkey).
    console.log(`[contact:${list}] ${clean}`);
    return { ok: true, added: true };
  }
  const res = await fetch(`${kv.url}/sadd/lumenia:${list}/${encodeURIComponent(clean)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}` },
  });
  if (!res.ok) {
    console.log(`[contact:${list}] ${clean} (store returned ${res.status})`);
    return { ok: true, added: false };
  }
  // Upstash SADD answers 1 for a new member, 0 for one that was already there.
  const body = (await res.json().catch(() => ({}))) as { result?: number };
  return { ok: true, added: body.result === 1 };
}
