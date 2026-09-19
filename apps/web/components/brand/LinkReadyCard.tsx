"use client";

/**
 * LinkReadyCard — the money link is ready to share (FRONTEND_PLAN component
 * inventory: LinkReadyCard + ShareToWhatsAppButton + ReclaimNotice). Share the way
 * you share everything else: a link in a chat. The bearer key lives in the link's
 * #fragment — treat it like cash in an envelope (surfaced honestly).
 *
 * Two additions for the event (2026-09-18):
 *   - `link_shared`: the share sheet or the copy button fires a beacon, so "made a link" and
 *     "sent it" are two numbers instead of one. Carries the hashed account, like the send events.
 *   - a QR of the link, so a person standing next to the sender can claim on their own phone
 *     without any chat in between. Opened by default on a team-funded (seeded) link, because that
 *     is the one that gets scanned at a table; a tap away on every other link.
 */
import { useState } from "react";
import Link from "next/link";
import { Copy, Check, QrCode } from "lucide-react";
import QRCode from "react-qr-code";
import { MoneyCard } from "./MoneyCard";
import { copy as uiCopy } from "../../lib/copy";
import { sendEvent } from "../../lib/events";
import { shareMoneyLink } from "../../lib/share";

export function LinkReadyCard({
  link,
  balanceId,
  from,
  requestName,
  locked = false,
  account,
  seeded = false,
}: {
  link: string;
  balanceId: string;
  from: string;
  /** set when this link answers an ask — the share text sends it BACK to the asker. */
  requestName?: string;
  /** the sender put a claim password on this link (lib/claim-password.ts). */
  locked?: boolean;
  /** the sender's account, hashed on this device for the `link_shared` beacon; omit to send none. */
  account?: string;
  /** the team funded this link for the event; it carries a public `seeded=1` marker. */
  seeded?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [fellBack, setFellBack] = useState(false);
  const [showQr, setShowQr] = useState(seeded);
  const sentId = balanceId.slice(-8);
  // The link is appended by the share sheet itself (as `url`), so the message must not repeat it.
  const shareText = requestName
    ? uiCopy.pay.sendBackWaText("").trim()
    : `${from} sent you money 💸 Tap to receive it:`;

  /* Fired once per gesture, never with the link itself: the beacon carries the hashed link id and
     the hashed account, and nothing that could rebuild the URL (owner caveat C2). */
  const shared = () => void sendEvent("link_shared", balanceId, account);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      shared();
    } catch {
      /* clipboard blocked — the share button still works */
    }
  }

  async function share() {
    const outcome = await shareMoneyLink({ text: shareText, link });
    if (outcome === "shared") return shared();
    // No share sheet (desktop, mostly): the link is on the clipboard and the user pastes it into
    // the chat themselves. It never touches a third-party server either way.
    setFellBack(true);
    if (outcome === "copied") {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      shared();
    }
  }

  return (
    <MoneyCard className="flex flex-col gap-3 p-5">
      <p className="font-semibold text-ink">
        {requestName ? uiCopy.pay.sendBackTitle(requestName) : "Your money link is ready"}
      </p>
      {seeded ? (
        <p className="text-xs text-ink-soft">
          Team-funded link for the event. It carries a public <span className="font-mono">seeded=1</span> marker
          and is counted apart from organic use.
        </p>
      ) : null}
      <p
        data-testid="money-link"
        className="break-all rounded-[14px] border border-line bg-paper px-3 py-2 text-xs text-ink-soft"
      >
        {link}
      </p>

      {showQr ? (
        <div className="flex flex-col items-center gap-2">
          <div className="rounded-[14px] bg-white p-3">
            <QRCode value={link} size={176} bgColor="#FFFFFF" fgColor="#000000" level="M" />
          </div>
          <p className="text-xs text-ink-soft">Whoever scans this can claim the money, like whoever holds the link.</p>
        </div>
      ) : null}

      <button
        onClick={share}
        className="flex h-12 w-full items-center justify-center rounded-full bg-money text-sm font-semibold text-primary-foreground"
      >
        Share the link
      </button>
      {fellBack ? (
        <p className="text-xs text-ink-soft">
          Sharing isn&apos;t available on this device, so the link is on your clipboard — paste it
          into the chat yourself.
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          onClick={copy}
          className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full border border-line text-sm font-medium text-ink"
        >
          {copied ? <Check className="size-4 text-money" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy link"}
        </button>
        <button
          type="button"
          onClick={() => setShowQr((v) => !v)}
          aria-pressed={showQr}
          className="flex h-11 flex-1 items-center justify-center gap-2 rounded-full border border-line text-sm font-medium text-ink"
        >
          <QrCode className="size-4" />
          {showQr ? "Hide QR" : "Show QR"}
        </button>
      </div>

      {locked ? (
        <p className="text-xs text-ink-soft">
          Now send them the password a different way: a call, or another app. In the same chat as
          the link, it protects nothing. If nobody claims it, the money comes back to you after 7 days.
        </p>
      ) : (
        <p className="text-xs text-ink-soft">
          Share it privately with the person it&apos;s for. Whoever holds the link can claim it, like cash in an
          envelope. If nobody claims it, the money comes back to you after 7 days.
        </p>
      )}
      <Link href={`/sent/${sentId}`} className="text-sm font-semibold text-money underline-offset-2 hover:underline">
        Track this link →
      </Link>
    </MoneyCard>
  );
}
