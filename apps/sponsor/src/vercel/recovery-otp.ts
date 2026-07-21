/**
 * Vercel function source — POST /recovery-otp (§12 step 3). Emails a single-use 6-digit
 * code proving control of the email that keys a recovery box; the code is stored hashed
 * with a short TTL (lib/recovery-otp.ts). Its OWN rate-limit bucket ("rec:"); signs
 * nothing. No raw email is persisted.
 */
import {
  applyCors,
  parseBody,
  clientIpFrom,
  enforceRateLimit,
  type VercelReq,
  type VercelRes,
} from "../lib/service.js";
import { requestOtp } from "../lib/recovery-otp.js";

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  try {
    const rl = await enforceRateLimit(`rec:${clientIpFrom(req.headers)}`);
    if (rl.limited) return res.status(429).json({ error: rl.reason });
    const { email } = parseBody(req.body) as { email?: unknown };
    await requestOtp(email);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
}
