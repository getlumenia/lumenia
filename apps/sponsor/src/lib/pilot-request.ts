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

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function notifyPilotRequest(pubkey: string, email: string): Promise<{ ok: true }> {
  if (!StrKey.isValidEd25519PublicKey(pubkey)) throw new Error("invalid pubkey");
  const clean = email.trim().toLowerCase();
  if (clean.length > 200 || !EMAIL_RE.test(clean)) throw new Error("invalid email");

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
      from: "Lumenia <onboarding@resend.dev>",
      to: [to],
      subject: `Lumenia pilot request (${network})`,
      text: `A wallet asked to join the ${network} pilot.\n\nWallet:  ${pubkey}\nContact: ${clean}\n\nApprove with:\n  ${approveCmd}\n`,
    }),
  });
  if (!res.ok) console.log(`[pilot:request] resend ${res.status} — wallet ${pubkey} — ${clean}`);
  return { ok: true };
}
