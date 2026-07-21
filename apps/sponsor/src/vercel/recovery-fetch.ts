/**
 * Vercel function source — POST /recovery-fetch (§12 step 3). Returns a ciphertext-only
 * recovery box AFTER verifying the single-use email code. A POST (not GET) because the
 * verify consumes the code — it has a side effect. Its OWN rate-limit bucket ("rec:");
 * signs nothing; ciphertext-only.
 */
import {
  applyCors,
  parseBody,
  clientIpFrom,
  enforceRateLimit,
  type VercelReq,
  type VercelRes,
} from "../lib/service.js";
import { getBox } from "../lib/recovery-store.js";
import { verifyOtp } from "../lib/recovery-otp.js";

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  try {
    const rl = await enforceRateLimit(`rec:${clientIpFrom(req.headers)}`);
    if (rl.limited) return res.status(429).json({ error: rl.reason });
    const { id, code } = parseBody(req.body) as { id?: unknown; code?: unknown };
    if (!(await verifyOtp(id, code))) return res.status(401).json({ error: "invalid or expired code" });
    const box = await getBox(id);
    if (!box) return res.status(404).json({ error: "not found" });
    return res.status(200).json({ box });
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
}
