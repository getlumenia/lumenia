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
import { PublicRefusal } from "./caps.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ID_RE = /^[0-9a-f]{64}$/;
const TTL_SEC = 600; // 10 minutes
const MAX_TRIES = 5;

/* PER-ID VERIFY BUDGET (F3). `tries` inside the record is not a limit an attacker has to respect:
 * it was a read-modify-write, so N concurrent verifies all read tries=0 and all wrote back tries=1
 * — the 5-try cap simply did not exist under parallelism. It also reset to 0 on every new code, so
 * requesting a fresh code bought another 5 guesses. Both holes close the same way: a SEPARATE
 * counter, incremented ATOMICALLY (one Redis INCR, no read-modify-write), living on its OWN rolling
 * window so re-requesting a code cannot reset it. 6 digits stays (bank-standard, and 8 would hurt
 * the one flow a scared user runs); what makes 6 safe is that the budget below is hard. */
const MAX_VERIFY_PER_WINDOW = 12;
const VERIFY_WINDOW_SEC = 3600;

interface OtpRecord {
  codeHash: string;
  exp: number;
  tries: number;
}
const mem = new Map<string, OtpRecord>(); // local/test fallback (no KV)
const tryMem = new Map<string, { n: number; exp: number }>(); // ditto, for the verify budget

/**
 * What a person is told when either per-email budget is spent: the request cap below, or the verify
 * budget. Both used to look like something else (a request that "worked" and mailed nothing, a right
 * code answered as a wrong one), so a person locked out for the hour kept asking for codes that could
 * not help. The answer says nothing about any account: the counters are per email whether or not a
 * backup exists, and whoever spent them already knows they did.
 */
export const OTP_BUDGET_ERROR = "Too many tries for this email in the last hour. Wait, then ask for a new code.";
export const OTP_BUDGET_BODY = { error: OTP_BUDGET_ERROR, code: "otp-budget" } as const;

/** Thrown by `requestOtp` over the per-email request cap. The routes answer it with 429 OTP_BUDGET_BODY. */
export class OtpBudgetExceeded extends Error {
  readonly isOtpBudgetExceeded = true;
  constructor() {
    super(OTP_BUDGET_ERROR);
    this.name = "OtpBudgetExceeded";
  }
}

export function isOtpBudgetExceeded(e: unknown): boolean {
  return e instanceof OtpBudgetExceeded || (e as { isOtpBudgetExceeded?: boolean })?.isOtpBudgetExceeded === true;
}

/**
 * The verify budget could not be read, so the code was not compared (the budget fails CLOSED). Not
 * a spent budget and not a wrong code: telling the person to wait an hour, or that their right code
 * is wrong, would both be untrue. A PublicRefusal, so its sentence reaches the screen on any host.
 */
export const OTP_UNAVAILABLE_ERROR = "We couldn't check the code just now. Try again in a minute.";
export class OtpCheckUnavailable extends PublicRefusal {
  constructor() {
    super(OTP_UNAVAILABLE_ERROR, "otp-unavailable");
    this.name = "OtpCheckUnavailable";
  }
}

/** Why a code was mailed. Only the wording of the mail changes; the code itself is the same kind. */
export type OtpPurpose = "recovery" | "pilot";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compare two hex digests without an early exit, so response time carries no information. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

/**
 * The lines of the code mail. A backup code ends with what a stranger's request means for this
 * person, because a code nobody asked for is the one sign they get that somebody is trying their
 * email on our restore page; a real-money code does not open anything and keeps the plain line.
 */
export function codeEmailLines(purpose: OtpPurpose): { first: string; expiry: string } {
  if (purpose === "pilot") {
    return {
      first: "Your code to ask for real money:",
      expiry: "It expires in 10 minutes. If you didn't ask for this, ignore this email.",
    };
  }
  return {
    first: "Your code to secure or restore your money:",
    expiry:
      "It expires in 10 minutes. If you didn't ask for this, someone may be trying to open your Lumenia backup. It stays locked by your password.",
  };
}

async function sendCodeEmail(email: string, code: string, purpose: OtpPurpose): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // "Never in prod" was a comment, not a control: a Worker deployed or rotated without the
    // mailer secret printed every recovery code into the log stream while still storing a valid
    // one, so anyone with log access could open any box. Now a deployed environment refuses
    // outright, and only an explicitly-flagged local run prints anything.
    if (process.env.RECOVERY_ALLOW_MEMORY_STORE !== "1") {
      throw new Error("recovery email is not configured");
    }
    console.log(`[recovery:otp] (local, no RESEND_API_KEY) code for ${email.slice(0, 3)}…: ${code}`);
    return;
  }
  const lines = codeEmailLines(purpose);
  // A real-money code can come from the mainnet Worker, where "a test network" would be untrue.
  const footer = purpose === "pilot" ? "Real money on Lumenia is an early pilot." : "Lumenia is in pilot on a test network.";
  const html = `<!doctype html><html><body style="margin:0;background:#F5F3EF;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F3EF;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#FBFAF8;border:1px solid #E5DFE8;border-radius:16px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="background:#6E5FCE;padding:18px 28px;"><span style="font-size:18px;font-weight:700;color:#F6F4FD;">Lumenia</span></td></tr>
<tr><td style="padding:26px 28px 6px;font-size:15px;color:#1E1B22;">${lines.first}</td></tr>
<tr><td style="padding:8px 28px 6px;"><div style="font-size:34px;font-weight:700;letter-spacing:8px;color:#4E40A8;font-family:ui-monospace,Menlo,Consolas,monospace;">${code}</div></td></tr>
<tr><td style="padding:6px 28px 24px;font-size:13px;color:#67626E;">${lines.expiry}</td></tr>
<tr><td style="border-top:1px solid #E5DFE8;padding:14px 28px;font-size:11.5px;color:#67626E;">${footer}</td></tr>
</table></td></tr></table></body></html>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM ?? "Lumenia <onboarding@resend.dev>",
        to: [email],
        subject: `Your Lumenia code: ${code}`,
        html,
        text: `${lines.first} ${code}\n\n${lines.expiry}\n`,
      }),
    });
    if (!res.ok) console.log(`[recovery:otp] resend returned ${res.status}`);
  } catch {
    /* mail must never break the endpoint */
  }
}

/* PER-ID request cap (DEFERRED.md F3). The IP limiter alone does not stop the griefing shape that
 * matters: one attacker spread across addresses can hammer a SINGLE victim's email, both as an
 * inbox flood and as a way to keep invalidating the code the victim is trying to use. Counted per
 * box id over a rolling window, so a normal user (a couple of tries, maybe a resend) never notices
 * and a flood stops at the eleventh.
 *
 * Over the cap the caller is TOLD (429, OTP_BUDGET_BODY) and no email is sent. It used to answer
 * the ordinary 200 so as not to "confirm the address exists", but the counter is per email whether
 * or not any backup exists, so a 429 confirms nothing beyond the requests the caller made itself,
 * while the silent 200 left the real owner waiting for a code that was never coming. */
const MAX_OTP_PER_WINDOW = 10;
const OTP_WINDOW_SEC = 3600;
const reqMem = new Map<string, { n: number; exp: number }>();

async function overRequestCap(id: string): Promise<boolean> {
  const kv = kvConfigFromEnv();
  const key = `lumenia:recovery-otpreq:${id}`;
  if (!kv) {
    const now = Date.now();
    const rec = reqMem.get(id);
    if (!rec || now > rec.exp) {
      reqMem.set(id, { n: 1, exp: now + OTP_WINDOW_SEC * 1000 });
      return false;
    }
    rec.n += 1;
    return rec.n > MAX_OTP_PER_WINDOW;
  }
  try {
    const res = await fetch(`${kv.url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(OTP_WINDOW_SEC), "NX"],
      ]),
    });
    if (!res.ok) return false; // the store is the limiter's problem, never the user's
    const [first] = (await res.json()) as Array<{ result?: unknown }>;
    return Number(first?.result ?? 0) > MAX_OTP_PER_WINDOW;
  } catch {
    return false;
  }
}

/**
 * Email a fresh single-use code for `email` and store it hashed under its box id. `purpose` changes
 * the wording of the mail only ("pilot": the code that confirms an email when asking to join real
 * money, worker.ts /pilot-request). Throws OtpBudgetExceeded over the per-email request cap.
 */
export async function requestOtp(rawEmail: unknown, purpose: OtpPurpose = "recovery"): Promise<{ ok: true }> {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (email.length > 200 || !EMAIL_RE.test(email)) throw new Error("invalid email");
  const id = await idForEmail(email);
  if (await overRequestCap(id)) {
    console.log(`[recovery:otp] per-id cap hit for ${id.slice(0, 8)}...: no email sent`);
    throw new OtpBudgetExceeded();
  }
  const code = sixDigit();
  const rec: OtpRecord = { codeHash: await sha256Hex(`${id}:${code}`), exp: Date.now() + TTL_SEC * 1000, tries: 0 };
  const kv = kvConfigFromEnv();
  if (!kv) mem.set(id, rec);
  else await kvSetJson(kv, otpKey(id), rec, TTL_SEC);
  await sendCodeEmail(email, code, purpose === "pilot" ? "pilot" : "recovery");
  return { ok: true };
}

/**
 * Spend one unit of the per-id verify budget, ATOMICALLY, and report whether the budget is now
 * blown. Counted BEFORE the code is compared, so a wrong guess and a right guess cost the same —
 * an attacker cannot buy attempts by racing, and cannot reset the counter by requesting a new code
 * (this key has its own window and `requestOtp` never touches it).
 */
async function overVerifyBudget(id: string): Promise<boolean> {
  const kv = kvConfigFromEnv();
  const key = `lumenia:recovery-otptry:${id}`;
  if (!kv) {
    const now = Date.now();
    const rec = tryMem.get(id);
    if (!rec || now > rec.exp) {
      tryMem.set(id, { n: 1, exp: now + VERIFY_WINDOW_SEC * 1000 });
      return false;
    }
    rec.n += 1;
    return rec.n > MAX_VERIFY_PER_WINDOW;
  }
  try {
    const res = await fetch(`${kv.url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(VERIFY_WINDOW_SEC), "NX"],
      ]),
    });
    // A store outage must not open the door: this counter IS the brute-force defence, so it fails
    // CLOSED. The cost is that an outage pauses recovery; the alternative is unlimited guessing.
    if (!res.ok) throw new OtpCheckUnavailable();
    const [first] = (await res.json()) as Array<{ result?: unknown }>;
    return Number(first?.result ?? 0) > MAX_VERIFY_PER_WINDOW;
  } catch {
    throw new OtpCheckUnavailable();
  }
}

/**
 * Verify AND consume the code for `id`: "ok" only for a correct, unexpired, unused code; "budget"
 * when this email's verify budget for the hour is spent (the code was not even compared); "wrong"
 * for everything else, a malformed id or code included. The routes answer "budget" with 429
 * OTP_BUDGET_BODY, so a person locked out for the hour is told so instead of "wrong code". Throws
 * OtpCheckUnavailable when the budget cannot be read (nothing is compared, nothing is consumed).
 */
export async function verifyOtpDetailed(rawId: unknown, rawCode: unknown): Promise<"ok" | "wrong" | "budget"> {
  const id = typeof rawId === "string" && ID_RE.test(rawId) ? rawId : "";
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  if (!id || !/^\d{6}$/.test(code)) return "wrong";
  // The hard cap comes first — before any store read, so a flood costs the attacker a budget unit
  // whatever else happens.
  if (await overVerifyBudget(id)) return "budget";
  const kv = kvConfigFromEnv();
  const key = otpKey(id);
  const rec = kv ? await kvGetJson(kv, key) : (mem.get(id) ?? null);
  if (!rec) return "wrong";
  if (Date.now() > rec.exp || rec.tries >= MAX_TRIES) {
    if (kv) await kvDel(kv, key);
    else mem.delete(id);
    return "wrong";
  }
  if (!timingSafeEqualHex(await sha256Hex(`${id}:${code}`), rec.codeHash)) {
    rec.tries += 1;
    const remainSec = Math.max(1, Math.ceil((rec.exp - Date.now()) / 1000));
    if (kv) await kvSetJson(kv, key, rec, remainSec);
    else mem.set(id, rec);
    return "wrong";
  }
  // correct → single-use: consume it
  if (kv) await kvDel(kv, key);
  else mem.delete(id);
  return "ok";
}

/**
 * Verify AND consume the code for `id`. True only on a correct, unexpired, unused code. The boolean
 * API the identity routes use: an unreadable budget is false here, as it always was.
 */
export async function verifyOtp(rawId: unknown, rawCode: unknown): Promise<boolean> {
  try {
    return (await verifyOtpDetailed(rawId, rawCode)) === "ok";
  } catch (e) {
    if (e instanceof OtpCheckUnavailable) return false;
    throw e;
  }
}
