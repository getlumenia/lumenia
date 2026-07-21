/**
 * Recovery OTP — proves control of the email that keys a recovery box before the box
 * can be stored or fetched (RECOVERY_ARCHITECTURE §12 step 3). A 6-digit code is emailed
 * (Resend REST, same path as feedback) and stored HASHED with a short TTL, tied to the
 * box id (= SHA-256 of the normalized email, computed identically on the client). The
 * code is single-use (consumed on a correct verify) and attempt-limited. No raw email is
 * persisted — it is used only to send the code, then discarded; the store holds only
 * { codeHash, exp, tries }, keyed by the (non-reversible-in-practice) box id.
 *
 * OWNER GATE: Resend's shared onboarding sender only delivers to the Resend account
 * owner's own address until a DOMAIN is verified. So OTP email to REAL users needs
 * getlumenia.com verified in Resend (Cloudflare Email Routing already exists). Until then
 * this path works end-to-end only for the owner's own address (and logs the code when no
 * RESEND_API_KEY is set, for local/dev).
 */
import { kvConfigFromEnv } from "./rate-limit.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ID_RE = /^[0-9a-f]{64}$/;
const TTL_SEC = 600; // 10 minutes
const MAX_TRIES = 5;

interface OtpRecord {
  codeHash: string;
  exp: number;
  tries: number;
}
const mem = new Map<string, OtpRecord>(); // local/test fallback (no KV)

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The box id for an email — SHA-256(normalized email). The client computes the identical value. */
export async function idForEmail(email: string): Promise<string> {
  return sha256Hex(email.trim().toLowerCase());
}

function sixDigit(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return n.toString().padStart(6, "0");
}

/* ---- Upstash REST helpers (a keyed value with TTL; in-memory fallback elsewhere) ---- */
function otpKey(id: string): string {
  return `lumenia:recovery-otp:${id}`;
}
async function kvSetJson(kv: { url: string; token: string }, key: string, val: unknown, ttlSec: number): Promise<void> {
  const res = await fetch(`${kv.url}/set/${key}?EX=${ttlSec}`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}` },
    body: JSON.stringify(val),
  });
  if (!res.ok) throw new Error(`otp store returned ${res.status}`);
}
async function kvGetJson(kv: { url: string; token: string }, key: string): Promise<OtpRecord | null> {
  const res = await fetch(`${kv.url}/get/${key}`, { headers: { authorization: `Bearer ${kv.token}` } });
  if (!res.ok) throw new Error(`otp store returned ${res.status}`);
  const data = (await res.json()) as { result?: string | null };
  return data.result ? (JSON.parse(data.result) as OtpRecord) : null;
}
async function kvDel(kv: { url: string; token: string }, key: string): Promise<void> {
  await fetch(`${kv.url}/del/${key}`, { method: "POST", headers: { authorization: `Bearer ${kv.token}` } }).catch(() => {});
}

async function sendCodeEmail(email: string, code: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // Local/dev with no mailer — log the code so the flow is testable. Never in prod.
    console.log(`[recovery:otp] (no RESEND_API_KEY) code for ${email.slice(0, 3)}…: ${code}`);
    return;
  }
  const html = `<!doctype html><html><body style="margin:0;background:#F5F3EF;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F3EF;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#FBFAF8;border:1px solid #E5DFE8;border-radius:16px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="background:#6E5FCE;padding:18px 28px;"><span style="font-size:18px;font-weight:700;color:#F6F4FD;">Lumenia</span></td></tr>
<tr><td style="padding:26px 28px 6px;font-size:15px;color:#1E1B22;">Your code to secure or restore your money:</td></tr>
<tr><td style="padding:8px 28px 6px;"><div style="font-size:34px;font-weight:700;letter-spacing:8px;color:#4E40A8;font-family:ui-monospace,Menlo,Consolas,monospace;">${code}</div></td></tr>
<tr><td style="padding:6px 28px 24px;font-size:13px;color:#67626E;">It expires in 10 minutes. If you didn't ask for this, ignore this email.</td></tr>
<tr><td style="border-top:1px solid #E5DFE8;padding:14px 28px;font-size:11.5px;color:#67626E;">Lumenia is in pilot on a test network.</td></tr>
</table></td></tr></table></body></html>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: "Lumenia <onboarding@resend.dev>",
        to: [email],
        subject: `Your Lumenia code: ${code}`,
        html,
        text: `Your Lumenia code is ${code}. It expires in 10 minutes.`,
      }),
    });
    if (!res.ok) console.log(`[recovery:otp] resend returned ${res.status}`);
  } catch {
    /* mail must never break the endpoint */
  }
}

/** Email a fresh single-use code for `email` and store it hashed under its box id. */
export async function requestOtp(rawEmail: unknown): Promise<{ ok: true }> {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (email.length > 200 || !EMAIL_RE.test(email)) throw new Error("invalid email");
  const id = await idForEmail(email);
  const code = sixDigit();
  const rec: OtpRecord = { codeHash: await sha256Hex(`${id}:${code}`), exp: Date.now() + TTL_SEC * 1000, tries: 0 };
  const kv = kvConfigFromEnv();
  if (!kv) mem.set(id, rec);
  else await kvSetJson(kv, otpKey(id), rec, TTL_SEC);
  await sendCodeEmail(email, code);
  return { ok: true };
}

/** Verify AND consume the code for `id`. Returns true only on a correct, unexpired, unused code. */
export async function verifyOtp(rawId: unknown, rawCode: unknown): Promise<boolean> {
  const id = typeof rawId === "string" && ID_RE.test(rawId) ? rawId : "";
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  if (!id || !/^\d{6}$/.test(code)) return false;
  const kv = kvConfigFromEnv();
  const key = otpKey(id);
  const rec = kv ? await kvGetJson(kv, key) : (mem.get(id) ?? null);
  if (!rec) return false;
  if (Date.now() > rec.exp || rec.tries >= MAX_TRIES) {
    if (kv) await kvDel(kv, key);
    else mem.delete(id);
    return false;
  }
  if ((await sha256Hex(`${id}:${code}`)) !== rec.codeHash) {
    rec.tries += 1;
    const remainSec = Math.max(1, Math.ceil((rec.exp - Date.now()) / 1000));
    if (kv) await kvSetJson(kv, key, rec, remainSec);
    else mem.set(id, rec);
    return false;
  }
  // correct → single-use: consume it
  if (kv) await kvDel(kv, key);
  else mem.delete(id);
  return true;
}
