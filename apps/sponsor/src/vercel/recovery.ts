/**
 * Vercel function source — POST /recovery (store a zero-knowledge recovery box, §12).
 * Bundled by build-vercel.mjs; served at /recovery. Stores a ciphertext-only box AFTER
 * verifying the single-use email code (proves control of the email that keys the box).
 * Its OWN rate-limit bucket ("rec:"); touches NO signing key and NO anti-drain policy —
 * isolated from all money data.
 */
import {
  applyCors,
  parseBody,
  clientIpFrom,
  enforceRateLimit,
  type VercelReq,
  type VercelRes,
} from "../lib/service.js";
import { putBox } from "../lib/recovery-store.js";
import { verifyOtp } from "../lib/recovery-otp.js";

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  try {
    const rl = await enforceRateLimit(`rec:${clientIpFrom(req.headers)}`);
    if (rl.limited) return res.status(429).json({ error: rl.reason });
    const { id, box, code } = parseBody(req.body) as { id?: unknown; box?: unknown; code?: unknown };
    if (!(await verifyOtp(id, code))) return res.status(401).json({ error: "invalid or expired code" });
    await putBox(id, box);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
}
