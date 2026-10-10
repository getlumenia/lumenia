/**
 * Pilot join request — emails the OWNER that a wallet wants into the mainnet pilot,
 * plus the two applicant-facing outcome mails (approved / not-yet).
 *
 * This DOES persist, and the docstring used to claim otherwise. Both request paths record the
 * application state, a pubkey-to-email mapping (so the outcome mail has somewhere to go), and the
 * latest wallet that asked with this address, the last one keyed by HASH, never by the address.
 *
 * TWO PATHS (worker.ts /pilot-request):
 *  - SIGNED (`answerSignedPilotRequest`): the account signed the ask and the asker proved the email
 *    (a code mailed to it, or a backup row it protects). Filed per the account's state, and the
 *    owner mail says where it came from, how the email was proven, and which other wallet asked with
 *    the same email.
 *  - LEGACY (`notifyPilotRequest`): a page that does not sign. Answers exactly as before, so older
 *    pages keep working until PILOT_REQUIRE_PROOF=1 closes it. A collision is still not recorded,
 *    but it is logged and mailed to the owner instead of vanishing.
 *
 * The owner can still approve from the terminal with `pnpm --filter @lumenia/sponsor pilot approve
 * <pubkey>`, and the email carries that command ready to paste. Reuses the Resend owner-gate
 * (recovery-otp.ts): the shared onboarding sender only delivers to the Resend account owner —
 * exactly who should see these. A mail that cannot be sent (no mailer, a refusal, a throw) is one
 * log line with the wallet and the contact (visible in `wrangler tail`), never a failed request, so
 * a request is never silently lost.
 *
 * All the mails share one branded, table-based HTML skeleton (`renderEmail`) so they render
 * consistently and Outlook-safely; every send carries BOTH a plain-text and an HTML body.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { capsFromEnv, stroopsToUsdc } from "./caps.js";
import {
  mintApprovalToken,
  startPilotRequest,
  filePilotRequest,
  markOwnerMailed,
  ownerMailedRecently,
  getPilotState,
  getPilotSrc,
  pilotLimit,
  shortAddress,
  type InboxProof,
  type PilotSource,
  type PilotState,
} from "./pilot.js";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The address as every pilot path stores and compares it, or null when it is not one. */
export function normalizePilotEmail(email: string): string | null {
  const clean = email.trim().toLowerCase();
  return clean.length <= 200 && EMAIL_RE.test(clean) ? clean : null;
}

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

/** What one owner mail is about. */
interface OwnerMail {
  kind: "request" | "more-sends" | "collision";
  pubkey: string;
  /** The contact, normalized. */
  email: string;
  /** Where the ask came from; undefined for an older page that sends no source. */
  src?: PilotSource;
  /** How the email was proven; null when it was not (an older page asks for no code). */
  inbox: InboxProof | null;
  /** Another wallet that asked with this email, and where it stands. */
  other?: { pubkey: string; state: PilotState };
  used?: number;
  limit?: number;
}

function askedFromLine(src: PilotSource | undefined): string {
  if (src === "ext") return "Asked from: the extension";
  if (src === "web") return "Asked from: the website";
  return "Asked from: an older page";
}

function inboxLine(inbox: InboxProof | null): string {
  if (inbox === "code") return "Email confirmed by a code";
  if (inbox === "backup") return "Email confirmed by the backup it protects";
  return "Email not confirmed: an older page does not ask for a code";
}

function alsoLine(other: OwnerMail["other"]): string | null {
  return other ? `This email also asked for ${shortAddress(other.pubkey)} (${other.state}).` : null;
}

/**
 * Mail the owner about one ask. Resolves true only when Resend ACCEPTED it; every other outcome (no
 * mailer configured, a refusal, a throw) is exactly one log line naming the wallet and the contact,
 * and false. Never throws: a mail must not fail the ask it reports.
 */
async function mailOwner(m: OwnerMail, origin?: string): Promise<boolean> {
  const to = process.env.OWNER_EMAIL;
  const key = process.env.RESEND_API_KEY;
  const network = process.env.STELLAR_NETWORK ?? "testnet";
  if (!to || !key) {
    console.log(`[pilot:request] ${network} wallet ${m.pubkey} ${m.email} (no mailer)`);
    return false;
  }
  try {
    const mail = await composeOwnerMail(m, network, origin);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM ?? "Lumenia <onboarding@resend.dev>",
        to: [to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
    });
    if (res.ok) return true;
  } catch {
    /* reported by the one line below */
  }
  console.log(`[pilot:request] ${network} wallet ${m.pubkey} ${m.email} (mail failed)`);
  return false;
}

async function composeOwnerMail(
  m: OwnerMail,
  network: string,
  origin?: string,
): Promise<{ subject: string; text: string; html: string }> {
  const { pubkey, email } = m;
  const approveCmd = `STELLAR_NETWORK=${network} pnpm --filter @lumenia/sponsor pilot approve ${pubkey}`;
  const resetCmd = `STELLAR_NETWORK=${network} pnpm --filter @lumenia/sponsor pilot reset ${pubkey}`;
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
   * command rather than mint a link pointing somewhere we cannot vouch for. Each link opens a
   * confirmation page; nothing is decided until the owner presses its button (worker.ts).
   */
  const base = (process.env.SPONSOR_ORIGIN ?? (network === "mainnet" ? "" : (origin ?? ""))).replace(/\/$/, "");
  const mint = async (action: "approve" | "reject") => {
    if (!base) return null;
    const t = await mintApprovalToken(action, pubkey, Date.now());
    return t ? `${base}/pilot-${action}?pubkey=${pubkey}&exp=${t.exp}&token=${t.token}` : null;
  };

  // The facts every owner mail carries, in this order, in both bodies.
  const facts: string[] = [askedFromLine(m.src), inboxLine(m.inbox)];
  if (m.kind === "more-sends") facts.push(`Used: ${m.used ?? 0} of ${m.limit ?? pilotLimit()} sends`);
  const also = alsoLine(m.other);
  if (also) facts.push(also);

  const factsHtml = facts.map((f) => `${esc(f)}<br>`).join("");
  const walletBox = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};border:1px solid ${CHIP};border-radius:12px;">
  <tr><td style="padding:14px 16px;font-family:${FONT};font-size:14px;line-height:1.6;color:${INK};">
    <span style="color:${INK_SOFT};">Wallet</span><br>
    <code style="font-family:${MONO};font-size:13px;word-break:break-all;color:${ACCENT_PRESSED};">${esc(pubkey)}</code><br><br>
    <span style="color:${INK_SOFT};">Contact</span><br>
    <a href="mailto:${esc(email)}" style="color:${ACCENT_PRESSED};text-decoration:none;">${esc(email)}</a><br><br>
    ${factsHtml}
  </td></tr>
</table>`;
  const code = (cmd: string) =>
    `<code style="font-family:${MONO};font-size:12px;word-break:break-all;color:${ACCENT_PRESSED};">${esc(cmd)}</code>`;
  const footer =
    "You're getting this because you own the Lumenia Resend account. Only your own emailed links can approve or decline a pilot request.";

  if (m.kind === "more-sends") {
    const lead = `An approved wallet on the ${network} pilot has used all ${m.limit ?? pilotLimit()} of its real-money sends and asks for more.`;
    const html = renderEmail({
      preheader: `Wallet ${shortAddress(pubkey)} asks for more sends.`,
      mascotFile: "mark-link.webp",
      mascotAlt: "Lumenia",
      h1: "More sends asked",
      bodyHtml: `<p style="margin:0 0 16px;">${esc(lead)}</p>
${walletBox}
<p style="margin:22px 0 4px;font-size:15px;color:${INK};">Give it its sends again from the terminal:</p>
<p style="margin:0;">${code(resetCmd)}</p>`,
      footer,
    });
    return {
      subject: `Pilot: more sends asked - ${email} (${network})`,
      text: `${lead}\n\nWallet:  ${pubkey}\nContact: ${email}\n${facts.join("\n")}\n\nGive it its sends again:\n  ${resetCmd}\n`,
      html,
    };
  }

  if (m.kind === "collision") {
    const lead =
      `A wallet asked to join the ${network} pilot from an older page, with an email that another wallet asked with first. ` +
      "It was not recorded: an older page does not confirm the email, so this could be somebody else using that address.";
    const next = "If it is the same person, ask them to ask again from the latest page, which confirms the email with a code.";
    const html = renderEmail({
      preheader: `Wallet ${shortAddress(pubkey)} was not recorded.`,
      mascotFile: "mark-link.webp",
      mascotAlt: "Lumenia",
      h1: "Pilot request not recorded",
      bodyHtml: `<p style="margin:0 0 16px;">${esc(lead)}</p>
${walletBox}
<p style="margin:16px 0 0;">${esc(next)}</p>`,
      footer,
    });
    return {
      subject: `Pilot request not recorded - ${email} (${network})`,
      text: `${lead}\n\nWallet:  ${pubkey}\nContact: ${email}\n${facts.join("\n")}\n\n${next}\n`,
      html,
    };
  }

  const approveUrl = await mint("approve");
  const rejectUrl = await mint("reject");
  // Buttons only when the one-tap links exist (else fall back to the CLI command).
  const actionHtml =
    approveUrl && rejectUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px auto 6px;border-collapse:separate;"><tr>${buttonCell(
          approveUrl,
          "Approve",
          ACCENT,
          "#FFFFFF",
        )}<td style="width:12px;">&nbsp;</td>${buttonCell(rejectUrl, "Decline", CHIP, INK)}</tr></table>
<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:${INK_SOFT};">Prefer the terminal? ${code(approveCmd)}</p>`
      : `<p style="margin:22px 0 4px;font-size:15px;color:${INK};">Approve from the terminal:</p>
<p style="margin:0;">${code(approveCmd)}</p>`;
  const lead = `A wallet asked to join the ${network} pilot. Approve to let them switch to real money, or decline to keep them in practice mode.`;
  const html = renderEmail({
    preheader: `Wallet ${shortAddress(pubkey)}: tap to approve or decline.`,
    mascotFile: "mark-link.webp",
    mascotAlt: "Lumenia",
    h1: "New pilot request",
    bodyHtml: `<p style="margin:0 0 16px;">${esc(lead)}</p>
${walletBox}
${actionHtml}`,
    footer,
  });
  return {
    subject: `Pilot request - ${email} (${network})`,
    text: `${lead}\n\nWallet:  ${pubkey}\nContact: ${email}\n${facts.join("\n")}\n\n${
      approveUrl ? `Approve: ${approveUrl}\nDecline: ${rejectUrl}\n\nor via CLI:\n  ${approveCmd}\n` : `Approve with:\n  ${approveCmd}\n`
    }`,
    html,
  };
}

/**
 * The LEGACY ask: no signature, no proven email (pages from before the signed ask). Answers exactly
 * as it always has: {ok:true} for a filed or swallowed ask, {ok:true, already:true} when this
 * wallet already has a state. A collision (another wallet asked with this address first) is still
 * not recorded, for the reason in lib/pilot.ts `startPilotRequest`; it is now one
 * `[pilot:collision]` log line per ask and one owner mail per wallet a week, so the owner can act by
 * hand. Throws on a store problem (the route answers 503).
 */
export async function notifyPilotRequest(
  pubkey: string,
  email: string,
  origin?: string,
): Promise<{ ok: true; already?: boolean }> {
  if (!StrKey.isValidEd25519PublicKey(pubkey)) throw new Error("invalid pubkey");
  const clean = normalizePilotEmail(email);
  if (!clean) throw new Error("invalid email");
  const network = process.env.STELLAR_NETWORK ?? "testnet";

  const { created, collision, other } = await startPilotRequest(pubkey, clean);
  if (!created) {
    if (!collision) return { ok: true, already: true };
    console.log(`[pilot:collision] ${network} wallet ${pubkey} asked with an email already used by ${other ?? "another wallet"}; not recorded`);
    if (!(await ownerMailedRecently(pubkey))) {
      const otherInfo = other ? { pubkey: other, state: await getPilotState(other) } : undefined;
      if (await mailOwner({ kind: "collision", pubkey, email: clean, inbox: null, other: otherInfo }, origin)) {
        await markOwnerMailed(pubkey).catch(() => {});
      }
    }
    // The ordinary success shape: the answer must not tell this wallet whether the address applied.
    return { ok: true };
  }
  if (await mailOwner({ kind: "request", pubkey, email: clean, inbox: null }, origin)) {
    await markOwnerMailed(pubkey).catch(() => {});
  }
  return { ok: true };
}

/** The answer to a signed ask (contract 3.2). */
export interface SignedPilotAnswer {
  ok: true;
  state: "pending" | "approved" | "rejected";
  /** For the first ask, always true; for a re-ask, whether an owner mail went out now. */
  filed: boolean;
  already?: true;
  /** short(G) of another wallet that asked with this email in the last 90 days. */
  emailAlsoFor?: string;
}

/**
 * The SIGNED ask, after worker.ts has verified the account's signature and the email (a code, or a
 * backup row bound to this account). Files it (lib/pilot.ts `filePilotRequest`), sends the owner
 * the mail the filing calls for, and records the mail only when Resend accepted it, so a failed mail
 * is retried by the next ask instead of being counted. Throws on a store problem (503).
 */
export async function answerSignedPilotRequest(
  pubkey: string,
  email: string,
  src: PilotSource | undefined,
  inboxProof: InboxProof,
  origin?: string,
): Promise<SignedPilotAnswer> {
  const filing = await filePilotRequest(pubkey, email, src, { inboxProof });
  let mailed = false;
  if (filing.mail) {
    mailed = await mailOwner(
      { kind: filing.mail, pubkey, email, src, inbox: inboxProof, other: filing.other, used: filing.used, limit: filing.limit },
      origin,
    );
    if (mailed) await markOwnerMailed(pubkey).catch(() => {});
  }
  return {
    ok: true,
    state: filing.state,
    filed: filing.already ? mailed : true,
    ...(filing.already ? { already: true as const } : {}),
    ...(filing.other ? { emailAlsoFor: shortAddress(filing.other.pubkey) } : {}),
  };
}

/**
 * Tell the owner that somebody with NO ACCOUNT asked for real money.
 *
 * The account path (`notifyPilotRequest`) has always emailed; this one had nothing at all. A person
 * who has not opened an account yet has no public key to approve, so their ask is stored on the
 * waitlist — and the store is silent by design, which meant the ask reached a database and nobody
 * else. Somebody asking to be let in and hearing nothing back, from anyone, ever, is the failure
 * this closes.
 *
 * Best-effort, exactly like its sibling: a mail that will not send must not fail the ask. And it is
 * only called for an address that was NEW to the list, so a second attempt from the same person
 * does not become a second email.
 */
export async function notifyPilotInterest(email: string, origin?: string): Promise<void> {
  const clean = email.trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) return;
  const to = process.env.OWNER_EMAIL;
  const key = process.env.RESEND_API_KEY;
  const network = process.env.STELLAR_NETWORK ?? "testnet";
  if (!to || !key) {
    // Visible in `wrangler tail` even without a mailer, so the ask is never invisible everywhere.
    console.log(`[pilot:interest] ${clean} (${network}) — no OWNER_EMAIL/RESEND_API_KEY`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM ?? "Lumenia <onboarding@resend.dev>",
      to: [to],
      subject: `Real-money interest — ${clean} (${network})`,
      text:
        `Somebody asked for real money from onboarding, with no account yet.\n\n` +
        `Contact: ${clean}\n` +
        `Where:   ${origin ?? "unknown"}\n\n` +
        `There is no wallet to approve — they have not opened an account. When they do, they can ` +
        `ask from /pilot and that request will carry their address.\n`,
    }),
  });
  if (!res.ok) console.log(`[pilot:interest] resend ${res.status} — ${clean}`);
}

/**
 * The real-money warning, word for word as every surface shows it (the web dialog, /pilot, the
 * extension's one-time note, the store listings, and the approval mail below). Any cap sentence
 * follows it separately.
 */
export const REAL_MONEY_WARNING =
  "Real money on Lumenia is an early pilot. It has not been reviewed by an outside security firm yet. You can lose money, so keep amounts small.";

/**
 * The pilot's caps in the wording every surface uses, read from the SAME env the enforcement reads
 * (lib/caps.ts): the per-transfer cap, the per-sender day cap (`MAX_DAY_USDC_PER_SENDER`) and the
 * day cap across the whole pilot. On the mainnet Worker that is "$5 a link and up to $25 a day from
 * you ($50 a day across the whole pilot)", and `short` is "$5 a link, $25 a day". Where no per-sender
 * cap is tighter than the day's (testnet leaves it unset), the day cap is the one a sender meets.
 */
export function pilotCaps(): { full: string; short: string } {
  const caps = capsFromEnv();
  const usd = (stroops: bigint) => `$${stroopsToUsdc(stroops)}`;
  const link = usd(caps.maxDropStroops);
  const day = usd(caps.maxDayStroops);
  const sender = caps.maxDaySenderStroops ?? caps.maxDayStroops;
  if (sender < caps.maxDayStroops) {
    return {
      full: `${link} a link and up to ${usd(sender)} a day from you (${day} a day across the whole pilot)`,
      short: `${link} a link, ${usd(sender)} a day`,
    };
  }
  return { full: `${link} a link and up to ${day} a day across the whole pilot`, short: `${link} a link, ${day} a day` };
}

/**
 * Tell an approved user they are in the mainnet pilot. Best-effort: logs (visible in
 * `wrangler tail`) when Resend isn't configured, so an approval is never blocked by mail.
 * Sending to a real user's inbox needs a VERIFIED sender domain (RESEND_FROM =
 * you@getlumenia.com); until then the shared onboarding sender only reaches the owner.
 *
 * Resolves true only when Resend ACCEPTED the mail. The Worker ignores the result; the owner CLI
 * must not, or a refused send (unverified sender, bad key) reads as "emailed" and the owner
 * records a date for a mail nobody received.
 */
export async function notifyPilotApproved(pubkey: string, email: string): Promise<boolean> {
  const clean = email.trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) return false;

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // The wallet only, as /privacy says of a failed answer mail: the address stays in the store.
    console.log(`[pilot:approved] ${pubkey}: not mailed (no RESEND_API_KEY)`);
    return false;
  }

  /* The mail names the ACCOUNT it approves. One person can hold a website account and an extension
     account (two keys), and a mail that said only "you're approved" sent them to whichever account
     their browser happened to hold. `#for=` lets /account check it is the right one; the fragment
     never reaches a server log. Where the ask came from and the send limit are read here, best
     effort, so the Worker's link and the owner CLI send the same mail. */
  const switchUrl = `${process.env.WEB_ORIGIN ?? "https://getlumenia.com"}/account?switch=mainnet#for=${pubkey}`;
  const src = await getPilotSrc(pubkey);
  const limit = pilotLimit();
  /* The caps this mail quotes are read from the SAME env the enforcement reads (lib/caps.ts). They
     used to be a hardcoded "$1", an aspirational number the mainnet Worker never enforced (it has run
     $5 since day one), so the welcome mail promised a protection the user did not have. The warning
     comes first, word for word as everywhere else, and the caps in a sentence of their own. */
  const caps = pilotCaps();
  const ready = "Your account is ready to use Lumenia with real money. When you're set, turn it on in one tap.";
  const forAccount = `This approval is for account ${shortAddress(pubkey)}.`;
  const sends = `You can make ${limit} real-money links from this account.`;
  const extension = src === "ext" ? "Open the Lumenia extension and choose Real money." : null;
  const limits = `Pilot limits: ${caps.full}.`;
  const paragraphs = [ready, forAccount, sends, ...(extension ? [extension] : []), REAL_MONEY_WARNING, limits];

  const html = renderEmail({
    preheader: `Turn on real money in one tap. Pilot limits: ${caps.short}.`,
    mascotFile: "mascot-celebrate-cut.webp",
    mascotAlt: "Confetti celebration",
    h1: "You're approved for real money",
    bodyHtml: paragraphs
      .map((p, i, all) => `<p style="margin:0${i < all.length - 1 ? " 0 14px" : ""};">${esc(p)}</p>`)
      .join("\n"),
    buttonUrl: switchUrl,
    buttonLabel: "Switch to real money",
    footer:
      "You're getting this because you asked to join the Lumenia mainnet pilot. Reply to this email anytime. A real person reads it.",
  });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM ?? "Lumenia <onboarding@resend.dev>",
      to: [clean],
      subject: "You're in: Lumenia is ready for real money",
      text: `You're approved for real money.\n\n${paragraphs.join("\n\n")}\n\nSwitch to real money: ${switchUrl}\n\nLumenia\n`,
      html,
    }),
  });
  if (!res.ok) console.log(`[pilot:approved] resend ${res.status}: ${pubkey}`);
  return res.ok;
}

/**
 * Tell a not-yet applicant, gently (TASK 2). Not a cold "no", and no longer a promise either: it
 * used to say "you're still on the list, and we'll email you the moment your spot is ready", and
 * nothing in the pilot ever sends that email. It names the account the answer is for, points at
 * practice mode, and says how to ask again (reply). Sent on the shared branded skeleton.
 * Best-effort; logs when Resend isn't configured. Resolves true only when Resend accepted the mail
 * (same contract as notifyPilotApproved).
 */
export async function notifyPilotRejected(pubkey: string, email: string): Promise<boolean> {
  const clean = email.trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) return false;

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // The wallet only, as /privacy says of a failed answer mail: the address stays in the store.
    console.log(`[pilot:rejected] ${pubkey}: not mailed (no RESEND_API_KEY)`);
    return false;
  }

  const homeUrl = `${process.env.WEB_ORIGIN ?? "https://getlumenia.com"}/home`;
  const forAccount = `This answer is for account ${shortAddress(pubkey)}.`;
  const p1 =
    "We're not able to open a real-money spot for you just yet. This isn't a no, it's a " +
    "not-yet. We're letting people in slowly on purpose, so we can support everyone properly " +
    "while it's early.";
  const p2 =
    "This isn't a no forever. If you'd like us to look again, reply to this email. In the " +
    "meantime, practice mode is open: it's the exact same Lumenia with no real money and no wait.";
  const p3 = "If something's holding you up, just reply to this email. A real person reads it.";

  const html = renderEmail({
    preheader: "Not approved for now. Practice mode is open.",
    mascotFile: "avatar-heart-cut.webp",
    mascotAlt: "A warm heart",
    h1: "Not approved for now",
    bodyHtml: `<p style="margin:0 0 14px;">${esc(forAccount)}</p>
<p style="margin:0 0 14px;">${esc(p1)}</p>
<p style="margin:0 0 14px;">${esc(p2)}</p>
<p style="margin:0 0 20px;">${esc(p3)}</p>
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
      text: `Not approved for now.\n\n${forAccount}\n\n${p1}\n\n${p2}\n\n${p3}\n\nOpen practice mode: ${homeUrl}\n\nLumenia\n`,
      html,
    }),
  });
  if (!res.ok) console.log(`[pilot:rejected] resend ${res.status}: ${pubkey}`);
  return res.ok;
}
