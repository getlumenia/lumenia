/**
 * /feedback — "report a problem" inbox. Free-text product feedback, stored in an
 * ISOLATED Upstash list (never joined to a pubkey or any money data), mirroring
 * the /waitlist isolation posture. The contact field is optional and
 * user-volunteered — the product never requires it. Falls back to a structured
 * log when no KV store is configured.
 *
 * Notification: when RESEND_API_KEY + FEEDBACK_NOTIFY_TO are set, each report is
 * ALSO emailed to the owner via Resend (fire-and-forget — a mail failure never
 * fails the request; the KV list stays the store of record). Without the envs
 * the endpoint behaves exactly as before (store/log only).
 */
import { kvConfigFromEnv } from "./rate-limit.js";

/** Where in the product the report came from — an allowlist, not a free string. */
const CATEGORIES = new Set<string>(["claim", "send", "request", "money", "site", "other"]);

const MAX_MESSAGE = 500;
const MAX_CONTACT = 200;
const STORE_KEY = "lumenia:feedback:v1";
/** Newest entries kept; the list is capped so an abuse burst can never grow the
 *  shared KV store unbounded (it also backs the rate limiter + waitlist). */
const MAX_ENTRIES = 2000;

/** Strip terminal/markup-hostile control chars (keep \n and \t) — these entries
 *  are read by a human in a terminal or dashboard later. */
function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** User-supplied text goes into the HTML body — escape EVERYTHING interpolated. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Branded notification email (Periwinkle — brand.md §4 values inlined; email
 * clients ignore stylesheets, so everything is inline styles on tables/divs).
 * A plain-text part rides along for clients that prefer it. If the reporter
 * left a valid email as contact, it becomes reply_to — "Reply" in the owner's
 * inbox answers the USER directly.
 */
function renderEmail(category: string, message: string, contact: string, at: string): { html: string; text: string } {
  const when = `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
  const msgHtml = escapeHtml(message).replace(/\n/g, "<br>");
  const contactHtml = contact
    ? EMAIL_RE.test(contact)
      ? `<a href="mailto:${escapeHtml(contact)}" style="color:#6E5FCE;">${escapeHtml(contact)}</a>`
      : escapeHtml(contact)
    : '<span style="color:#67626E;">not left</span>';

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F5F3EF;">
<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(message.slice(0, 90))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F3EF;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FBFAF8;border:1px solid #E5DFE8;border-radius:16px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <tr><td style="background:#6E5FCE;padding:18px 28px;">
    <span style="font-size:18px;font-weight:700;color:#F6F4FD;letter-spacing:.01em;">Lumenia</span>
    <span style="font-size:13px;color:#E8E3F7;float:right;margin-top:3px;">problem report</span>
  </td></tr>
  <tr><td style="padding:26px 28px 8px;">
    <span style="display:inline-block;background:#E8E3F7;color:#4E40A8;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:5px 12px;">${escapeHtml(category)}</span>
    <span style="font-size:12.5px;color:#67626E;margin-left:10px;">${escapeHtml(when)}</span>
  </td></tr>
  <tr><td style="padding:16px 28px 4px;">
    <div style="background:#F5F3EF;border-left:3px solid #6E5FCE;border-radius:0 10px 10px 0;padding:14px 16px;font-size:15px;line-height:1.55;color:#1E1B22;">${msgHtml}</div>
  </td></tr>
  <tr><td style="padding:14px 28px 24px;">
    <p style="margin:0;font-size:13px;color:#67626E;">Reach them at: ${contactHtml}</p>
  </td></tr>
  <tr><td style="border-top:1px solid #E5DFE8;padding:14px 28px;">
    <p style="margin:0;font-size:11.5px;color:#67626E;">Sent by the report-a-problem form &middot; Lumenia is in pilot on a test network &middot; stored in the isolated feedback inbox</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const text = `Category: ${category}\nWhen: ${at}\n${contact ? `Contact: ${contact}\n` : ""}\n${message}\n`;
  return { html, text };
}

/**
 * Email the report to the owner (Resend REST — no SDK, keeps the esbuild bundle
 * lean). Uses Resend's shared onboarding sender until a domain is verified, which
 * can only deliver to the Resend account owner's own address — fine here, the
 * inbox IS the owner. Never throws.
 */
async function notifyByEmail(category: string, message: string, contact: string, at: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.FEEDBACK_NOTIFY_TO;
  if (!key || !to) return;
  try {
    const { html, text } = renderEmail(category, message, contact, at);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM ?? "Lumenia Feedback <onboarding@resend.dev>",
        to: [to],
        subject: `[Lumenia] Problem report — ${category}`,
        html,
        text,
        // "Reply" in the owner's inbox answers the reporter directly.
        ...(contact && EMAIL_RE.test(contact) ? { reply_to: contact } : {}),
      }),
    });
    if (!res.ok) console.log(`[feedback:notify] resend returned ${res.status}`);
  } catch {
    /* mail must never break the endpoint */
  }
}

export interface FeedbackInput {
  category?: string;
  message?: string;
  contact?: string;
}

export async function saveFeedback(input: FeedbackInput): Promise<{ ok: true }> {
  const category = (input.category ?? "").trim().toLowerCase();
  if (!CATEGORIES.has(category)) throw new Error("unknown category");

  const message = sanitize((input.message ?? "").trim());
  if (message.length === 0) throw new Error("message is required");
  if (message.length > MAX_MESSAGE) throw new Error(`message too long (max ${MAX_MESSAGE})`);

  const contact = sanitize((input.contact ?? "").trim());
  if (contact.length > MAX_CONTACT) throw new Error(`contact too long (max ${MAX_CONTACT})`);

  const at = new Date().toISOString();
  const entry = JSON.stringify({
    category,
    message,
    ...(contact ? { contact } : {}),
    at,
  });

  // Push notification to the owner's inbox (no-op until the Resend envs exist).
  await notifyByEmail(category, message, contact, at);

  const kv = kvConfigFromEnv();
  if (!kv) {
    // No store configured — log it (isolated: never a pubkey, never money data).
    console.log(`[feedback:${category}] ${entry}`);
    return { ok: true };
  }
  const res = await fetch(`${kv.url}/rpush/${STORE_KEY}/${encodeURIComponent(entry)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}` },
  });
  if (!res.ok) {
    console.log(`[feedback:${category}] ${entry} (store returned ${res.status})`);
  } else {
    // Cap the list at the newest MAX_ENTRIES so growth stays bounded.
    await fetch(`${kv.url}/ltrim/${STORE_KEY}/-${MAX_ENTRIES}/-1`, {
      method: "POST",
      headers: { authorization: `Bearer ${kv.token}` },
    }).catch(() => {});
  }
  return { ok: true };
}
