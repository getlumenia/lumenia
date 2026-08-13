/**
 * Pilot join request — emails the OWNER that a wallet wants into the mainnet pilot,
 * plus the two applicant-facing outcome mails (approved / not-yet).
 *
 * This DOES persist, and the docstring used to claim otherwise. `startPilotRequest` records the
 * application state, a pubkey↔email mapping (so the outcome mail has somewhere to go), and a
 * marker that this address has applied — the last one keyed by HASH, never by the address itself.
 * The owner can still approve from the terminal with `pnpm --filter @lumenia/sponsor pilot approve
 * <pubkey>`, and the email carries that command ready to paste. Reuses the Resend owner-gate
 * (recovery-otp.ts): the shared onboarding sender only delivers to the Resend account owner —
 * exactly who should see these. If Resend isn't configured it logs (visible in `wrangler
 * tail`), so a request is never silently lost.
 *
 * All three mails share one branded, table-based HTML skeleton (`renderEmail`) so they render
 * consistently and Outlook-safely; every send carries BOTH a plain-text and an HTML body.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { capsFromEnv, stroopsToUsdc } from "./caps.js";
import { mintApprovalToken, startPilotRequest } from "./pilot.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ── Brand tokens (app / "Periwinkle" palette — verified) ───────────────────────────────
const PAPER = "#F5F3EF"; // background / paper
const ACCENT = "#6E5FCE"; // accent + primary button
const ACCENT_PRESSED = "#4E40A8"; // pressed accent — used for links (darker = more readable)
const CHIP = "#E8E3F7"; // accent-soft chip / plaque
const INK = "#1E1B22"; // ink
const INK_SOFT = "#67626E"; // ink-soft
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,Menlo,Consolas,monospace";
const ASSETS = "https://getlumenia.com/brand-kit-assets";

/** Escape a string for safe interpolation into HTML text or an attribute value. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A single bulletproof button cell (~44px tall, 12px radius) for a table-based button row. */
function buttonCell(url: string, label: string, bg: string, fg: string): string {
  return `<td align="center" bgcolor="${bg}" style="border-radius:12px;"><a href="${esc(url)}" style="display:inline-block;padding:13px 30px;font-family:${FONT};font-size:16px;line-height:18px;font-weight:600;color:${fg};text-decoration:none;border-radius:12px;">${esc(label)}</a></td>`;
}

/**
 * Shared branded email skeleton: table-based, single column, ≤600px, Outlook-safe (no flex/grid).
 * `bodyHtml` is inserted raw — build it with `esc()` around any dynamic value. Everything else is
 * treated as plain text and escaped here. When `buttonUrl`+`buttonLabel` are given, a bulletproof
 * primary button is rendered with the same URL echoed as tappable text beneath it.
 */
function renderEmail(opts: {
  preheader: string;
  mascotFile: string;
  mascotAlt: string;
  h1: string;
  bodyHtml: string;
  buttonUrl?: string;
  buttonLabel?: string;
  footer: string;
}): string {
  const { preheader, mascotFile, mascotAlt, h1, bodyHtml, buttonUrl, buttonLabel, footer } = opts;

  const buttonBlock =
    buttonUrl && buttonLabel
      ? `
      <tr><td align="center" style="padding:28px 32px 6px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;border-collapse:separate;"><tr>${buttonCell(buttonUrl, buttonLabel, ACCENT, "#FFFFFF")}</tr></table>
      </td></tr>
      <tr><td align="center" style="padding:2px 32px 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${INK_SOFT};word-break:break-all;">
        or open this link:<br><a href="${esc(buttonUrl)}" style="color:${ACCENT_PRESSED};text-decoration:underline;">${esc(buttonUrl)}</a>
      </td></tr>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
</head>
<body style="margin:0;padding:0;background:${PAPER};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAPER};opacity:0;">${esc(preheader)}&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${PAPER};border:1px solid ${CHIP};border-radius:16px;overflow:hidden;">
  <tr><td align="center" style="padding:32px 32px 4px;">
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;background:${CHIP};border-radius:24px;">
      <tr><td align="center" style="padding:20px;">
        <img src="${ASSETS}/${mascotFile}" alt="${esc(mascotAlt)}" width="200" height="200" style="max-width:100%;height:auto;display:block;border:0;outline:none;text-decoration:none;">
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:26px 32px 0;font-family:${FONT};font-size:24px;line-height:1.3;font-weight:700;color:${INK};">${esc(h1)}</td></tr>
  <tr><td style="padding:12px 32px 0;font-family:${FONT};font-size:16px;line-height:1.6;color:${INK};">${bodyHtml}</td></tr>${buttonBlock}
  <tr><td style="padding:28px 32px 34px;font-family:${FONT};font-size:13px;line-height:1.6;color:${INK_SOFT};">${esc(footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export async function notifyPilotRequest(
  pubkey: string,
  email: string,
  origin?: string,
): Promise<{ ok: true; already?: boolean }> {
  if (!StrKey.isValidEd25519PublicKey(pubkey)) throw new Error("invalid pubkey");
  const clean = email.trim().toLowerCase();
  if (clean.length > 200 || !EMAIL_RE.test(clean)) throw new Error("invalid email");

  // TASK 1 — idempotent: records a pending application; if this wallet OR email already applied,
  // send NO duplicate owner-mail and tell the caller so it can show "you've already applied".
  const { created, collision } = await startPilotRequest(pubkey, clean);
  // `already` is an honest answer about THIS wallet's own application. A collision — some other
  // wallet already applied with this address — gets the ordinary success shape instead, so the
  // response cannot be used to test whether a given address is in the pilot.
  if (!created) return collision ? { ok: true } : { ok: true, already: true };

  const to = process.env.OWNER_EMAIL;
  const key = process.env.RESEND_API_KEY;
  const network = process.env.STELLAR_NETWORK ?? "testnet";
  const approveCmd = `STELLAR_NETWORK=${network} pnpm --filter @lumenia/sponsor pilot approve ${pubkey}`;
  /**
   * One-tap approve/decline links. Two things are deliberate here:
   *
   * The HOST is configuration, never the incoming request. `origin` derives from the Host header
   * of whoever called /pilot-request, so any hostname routed to this Worker — a workers.dev alias,
   * a stale custom domain, a preview route — used to become the link the owner clicked. Building
   * it from `SPONSOR_ORIGIN` means the owner's tap always lands on us.
   *
   * The TOKEN is a per-wallet, per-action, expiring signature (lib/pilot.ts), not the shared
   * secret. Without a configured origin we simply omit the buttons and fall back to the CLI
   * command rather than mint a link pointing somewhere we cannot vouch for.
   */
  const base = (process.env.SPONSOR_ORIGIN ?? (network === "mainnet" ? "" : (origin ?? ""))).replace(/\/$/, "");
  const mint = async (action: "approve" | "reject") => {
    if (!base) return null;
    const t = await mintApprovalToken(action, pubkey, Date.now());
    return t ? `${base}/pilot-${action}?pubkey=${pubkey}&exp=${t.exp}&token=${t.token}` : null;
  };
  const approveUrl = await mint("approve");
  const rejectUrl = await mint("reject");

  if (!to || !key) {
    // No mailer configured — log it so the owner can still see the request and approve by hand.
    console.log(`[pilot:request] ${network} — wallet ${pubkey} — ${clean}`);
    return { ok: true };
  }

  // Buttons only when the one-tap links exist (else fall back to the CLI command).
  const actionHtml =
    approveUrl && rejectUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px auto 6px;border-collapse:separate;"><tr>${buttonCell(
          approveUrl,
          "Approve",
          ACCENT,
          "#FFFFFF",
        )}<td style="width:12px;">&nbsp;</td>${buttonCell(rejectUrl, "Decline", CHIP, INK)}</tr></table>
<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:${INK_SOFT};">Prefer the terminal? <code style="font-family:${MONO};font-size:12px;word-break:break-all;color:${ACCENT_PRESSED};">${esc(
          approveCmd,
        )}</code></p>`
      : `<p style="margin:22px 0 4px;font-size:15px;color:${INK};">Approve from the terminal:</p>
<p style="margin:0;"><code style="font-family:${MONO};font-size:12px;word-break:break-all;color:${ACCENT_PRESSED};">${esc(
          approveCmd,
        )}</code></p>`;

  const bodyHtml = `<p style="margin:0 0 16px;">A wallet asked to join the <strong>${esc(
    network,
  )}</strong> pilot. Approve to let them switch to real money, or decline to keep them in practice mode.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};border:1px solid ${CHIP};border-radius:12px;">
  <tr><td style="padding:14px 16px;font-family:${FONT};font-size:14px;line-height:1.6;color:${INK};">
    <span style="color:${INK_SOFT};">Wallet</span><br>
    <code style="font-family:${MONO};font-size:13px;word-break:break-all;color:${ACCENT_PRESSED};">${esc(
      pubkey,
    )}</code><br><br>
    <span style="color:${INK_SOFT};">Contact</span><br>
    <a href="mailto:${esc(clean)}" style="color:${ACCENT_PRESSED};text-decoration:none;">${esc(clean)}</a>
  </td></tr>
</table>
${actionHtml}`;

  const html = renderEmail({
    preheader: `Wallet ${pubkey.slice(0, 8)}… · tap to approve or decline`,
    mascotFile: "mark-link.webp",
    mascotAlt: "Lumenia",
    h1: "New pilot request",
    bodyHtml,
    footer:
      "You're getting this because you own the Lumenia Resend account — only your own emailed links can approve or decline a pilot request.",
  });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM ?? "Lumenia <onboarding@resend.dev>",
      to: [to],
      subject: `Pilot request — ${clean} (${network})`,
      text: `A wallet asked to join the ${network} pilot.\n\nWallet:  ${pubkey}\nContact: ${clean}\n\n${
        approveUrl
          ? `Approve: ${approveUrl}\nDecline: ${rejectUrl}\n\nor via CLI:\n  ${approveCmd}\n`
          : `Approve with:\n  ${approveCmd}\n`
      }`,
      html,
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

  const switchUrl = `${process.env.WEB_ORIGIN ?? "https://getlumenia.com"}/account?switch=mainnet`;
  // The cap this mail quotes is read from the SAME env the enforcement reads (lib/caps.ts,
  // MAX_DROP_USDC). It used to be a hardcoded "$1" — an aspirational number the mainnet Worker
  // never enforced (it has run $5 since day one), so the welcome mail promised a protection
  // the user did not have.
  const cap = `$${stroopsToUsdc(capsFromEnv().maxDropStroops)}`;
  const body =
    "Your account is ready to use Lumenia with real money. When you're set, turn it on in " +
    `one tap — and keep amounts small: every transfer in the pilot is capped at ${cap}, so you ` +
    "can get comfortable safely.";

  const html = renderEmail({
    preheader: `Turn on real money in one tap. Every transfer is capped at ${cap} in the pilot.`,
    mascotFile: "mascot-celebrate-cut.webp",
    mascotAlt: "Confetti celebration",
    h1: "You're approved for real money",
    bodyHtml: `<p style="margin:0;">${body}</p>`,
    buttonUrl: switchUrl,
    buttonLabel: "Switch to real money",
    footer:
      "You're getting this because you asked to join the Lumenia mainnet pilot. Reply to this email anytime — a real person reads it.",
  });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM ?? "Lumenia <onboarding@resend.dev>",
      to: [clean],
      subject: "You're in — Lumenia is ready for real money",
      text: `You're approved for real money.\n\n${body}\n\nSwitch to real money: ${switchUrl}\n\n— Lumenia\n`,
      html,
    }),
  });
  if (!res.ok) console.log(`[pilot:approved] resend ${res.status} — ${pubkey}`);
}

/**
 * Tell a not-yet applicant, gently (TASK 2). Not a cold "no" — a "not yet, we're working on it"
 * that keeps goodwill, points them at practice mode, and never uses a hard rejection word. Sent
 * on the shared branded skeleton. Best-effort; logs when Resend isn't configured.
 */
export async function notifyPilotRejected(pubkey: string, email: string): Promise<void> {
  const clean = email.trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) return;

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[pilot:rejected] ${pubkey} — ${clean} (no RESEND_API_KEY)`);
    return;
  }

  const homeUrl = `${process.env.WEB_ORIGIN ?? "https://getlumenia.com"}/home`;
  const p1 =
    "We're not able to open a real-money spot for you just yet. This isn't a no — it's a " +
    "not-yet. We're letting people in slowly on purpose, so we can support everyone properly " +
    "while it's early.";
  const p2 =
    "You're still on the list, and we'll email you the moment your spot is ready. In the " +
    "meantime, practice mode is open — it's the exact same Lumenia with no real money and no wait.";
  const p3 = "If something's holding you up, just reply to this email. A real person reads it.";

  const html = renderEmail({
    preheader: "Not yet — but you're still on the list, and practice mode is open now.",
    mascotFile: "avatar-heart-cut.webp",
    mascotAlt: "A warm heart",
    h1: "Not yet — but you're still on the list",
    bodyHtml: `<p style="margin:0 0 14px;">${p1}</p>
<p style="margin:0 0 14px;">${p2}</p>
<p style="margin:0 0 20px;">${p3}</p>
<p style="margin:0;"><a href="${esc(homeUrl)}" style="color:${ACCENT_PRESSED};text-decoration:underline;font-weight:600;">Open practice mode &rarr;</a></p>`,
    footer: "You're getting this because you asked to join the Lumenia mainnet pilot.",
  });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM ?? "Lumenia <onboarding@resend.dev>",
      to: [clean],
      subject: "An update on your Lumenia pilot request",
      text: `Not yet — but you're still on the list.\n\n${p1}\n\n${p2}\n\n${p3}\n\nOpen practice mode: ${homeUrl}\n\n— Lumenia\n`,
      html,
    }),
  });
  if (!res.ok) console.log(`[pilot:rejected] resend ${res.status} — ${pubkey}`);
}
