/**
 * Pilot join request — emails the OWNER that a wallet wants into the mainnet pilot.
 *
 * NO persistent store and NO server-side pubkey↔email join: this is a one-shot notification
 * the owner acts on with `pnpm --filter @lumenia/sponsor pilot approve <pubkey>`. The email
 * itself carries the ready-to-paste approve command. Reuses the Resend owner-gate
 * (recovery-otp.ts): the shared onboarding sender only delivers to the Resend account owner —
 * exactly who should see these. If Resend isn't configured it logs (visible in `wrangler
 * tail`), so a request is never silently lost.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { storePilotEmail } from "./pilot.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function notifyPilotRequest(pubkey: string, email: string): Promise<{ ok: true }> {
  if (!StrKey.isValidEd25519PublicKey(pubkey)) throw new Error("invalid pubkey");
  const clean = email.trim().toLowerCase();
  if (clean.length > 200 || !EMAIL_RE.test(clean)) throw new Error("invalid email");

  // Remember who asked, so approving them later can send the "you're in" mail (best-effort).
  await storePilotEmail(pubkey, clean);

  const to = process.env.OWNER_EMAIL;
  const key = process.env.RESEND_API_KEY;
  const network = process.env.STELLAR_NETWORK ?? "testnet";
  const approveCmd = `STELLAR_NETWORK=${network} pnpm --filter @lumenia/sponsor pilot approve ${pubkey}`;

  if (!to || !key) {
    // No mailer configured — log it so the owner can still see the request and approve by hand.
    console.log(`[pilot:request] ${network} — wallet ${pubkey} — ${clean}`);
    return { ok: true };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM ?? "Lumenia <onboarding@resend.dev>",
      to: [to],
      subject: `Lumenia pilot request (${network})`,
      text: `A wallet asked to join the ${network} pilot.\n\nWallet:  ${pubkey}\nContact: ${clean}\n\nApprove with:\n  ${approveCmd}\n`,
    }),
  });
  if (!res.ok) console.log(`[pilot:request] resend ${res.status} — wallet ${pubkey} — ${clean}`);
  return { ok: true };
}

/**
 * Tell an approved user they are in the mainnet pilot. Best-effort: logs (visible in
 * `wrangler tail`) when Resend isn't configured, so an approval is never blocked by mail.
 * Sending to a real user's inbox needs a VERIFIED sender domain (RESEND_FROM =
 * you@getlumenia.com); until then the shared onboarding sender only reaches the owner.
 */
export async function notifyPilotApproved(pubkey: string, email: string): Promise<void> {
  const clean = email.trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) return;

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[pilot:approved] ${pubkey} — ${clean} (no RESEND_API_KEY)`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM ?? "Lumenia <onboarding@resend.dev>",
      to: [clean],
      subject: "You're in — Lumenia with real money",
      text:
        "Good news: your account is approved to use Lumenia on mainnet, with real money.\n\n" +
        'Open Lumenia, go to your account, and choose "Switch to real money". Keep amounts small ' +
        "while we're in the pilot — every transfer is capped at $1.\n\n— Lumenia\n",
    }),
  });
  if (!res.ok) console.log(`[pilot:approved] resend ${res.status} — ${pubkey}`);
}
