"use client";

/**
 * Recovery API client — talks to the sponsor's zero-knowledge recovery endpoints
 * (RECOVERY_ARCHITECTURE §12). The box is BUILT/OPENED in lib/recovery.ts (the seed
 * never leaves the browser); this module only ships CIPHERTEXT + a one-time email code.
 * The id is SHA-256(normalized email) — computed identically to the sponsor (idForEmail),
 * so the server never needs the raw email to find the box.
 */
import type { RecoveryBox } from "./recovery";

const SPONSOR_URL = (process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.vercel.app").replace(/\/$/, "");

/** The box id for an email — must match the sponsor's idForEmail exactly. */
export async function emailToId(email: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${SPONSOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorFrom(res: Response, fallback: string): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  return j.error ?? fallback;
}

/** Email a single-use code proving control of `email`. */
export async function requestRecoveryOtp(email: string): Promise<void> {
  const res = await post("/recovery-otp", { email });
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't send the code — try again."));
}

/** Store the ciphertext-only box for `email`, gated by the emailed code. */
export async function storeRecoveryBox(email: string, code: string, box: RecoveryBox): Promise<void> {
  const id = await emailToId(email);
  const res = await post("/recovery", { id, box, code });
  if (res.status === 401) throw new Error("That code is wrong or has expired.");
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't secure your money — try again."));
}

/** Fetch the box for `email`, gated by the code. Returns null if there is no backup. */
export async function fetchRecoveryBox(email: string, code: string): Promise<RecoveryBox | null> {
  const id = await emailToId(email);
  const res = await post("/recovery-fetch", { id, code });
  if (res.status === 404) return null;
  if (res.status === 401) throw new Error("That code is wrong or has expired.");
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't restore your money — try again."));
  const data = (await res.json()) as { box?: RecoveryBox };
  return data.box ?? null;
}
