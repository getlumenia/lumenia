"use client";

/**
 * LinkReadyCard — the money link is ready to share (FRONTEND_PLAN component
 * inventory: LinkReadyCard + ShareToWhatsAppButton + ReclaimNotice). Share the way
 * you share everything else: a link in a chat. The bearer key lives in the link's
 * #fragment — treat it like cash in an envelope (surfaced honestly).
 */
import { useState } from "react";
import Link from "next/link";
import { Copy, Check } from "lucide-react";
import { MoneyCard } from "./MoneyCard";
import { copy as uiCopy } from "../../lib/copy";
import { shareMoneyLink } from "../../lib/share";

export function LinkReadyCard({
  link,
  balanceId,
  from,
  requestName,
  locked = false,
}: {
  link: string;
  balanceId: string;
  from: string;
  /** set when this link answers an ask — the share text sends it BACK to the asker. */
  requestName?: string;
  /** the sender put a claim password on this link (lib/claim-password.ts). */
  locked?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [fellBack, setFellBack] = useState(false);
  const sentId = balanceId.slice(-8);
  // The link is appended by the share sheet itself (as `url`), so the message must not repeat it.
  const shareText = requestName
    ? uiCopy.pay.sendBackWaText("").trim()
    : `${from} sent you money 💸 Tap to receive it:`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the share button still works */
    }
  }

  async function share() {
    const outcome = await shareMoneyLink({ text: shareText, link });
    if (outcome === "shared") return;
    // No share sheet (desktop, mostly): the link is on the clipboard and the user pastes it into
    // the chat themselves. It never touches a third-party server either way.
    setFellBack(true);
    if (outcome === "copied") {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <MoneyCard className="flex flex-col gap-3 p-5">
      <p className="font-semibold text-ink">
        {requestName ? uiCopy.pay.sendBackTitle(requestName) : "Your money link is ready"}
      </p>
      <p
        data-testid="money-link"
        className="break-all rounded-[14px] border border-line bg-paper px-3 py-2 text-xs text-ink-soft"
      >
        {link}
      </p>

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
      <button
        onClick={copy}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-full border border-line text-sm font-medium text-ink"
      >
        {copied ? <Check className="size-4 text-money" /> : <Copy className="size-4" />}
        {copied ? "Copied" : "Copy link"}
      </button>

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
