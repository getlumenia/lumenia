"use client";

/**
 * WelcomeNudge — the one pointer to /welcome, on /home.
 *
 * An onboarding screen nobody can reach is decoration, and a forced one would break the product's
 * only real promise: money first, always. So this is the compromise both of those rule out — a
 * single quiet row, on the screen you land on AFTER your money is on it, dismissible in one tap and
 * never shown again.
 *
 * IT COSTS NOTHING TO THE PEOPLE IT IS NOT FOR. The device flag is read first, and a device that
 * has already been through the welcome makes no request at all: the registry lookup only happens
 * for someone who has genuinely never seen this. It also disappears silently for anyone who
 * already has a name — having one is the thing it is nudging towards.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { handleOf } from "../../lib/handles";
import { markWelcomeSeen, welcomeSeen } from "../../lib/welcome";

export function WelcomeNudge() {
  const { account } = useWallet();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!account || welcomeSeen()) return;
    let live = true;
    void handleOf(account.address)
      .then((name) => {
        if (!live) return;
        // Already named → nothing to nudge towards, and remember that so the lookup never repeats.
        if (name) return markWelcomeSeen();
        setShow(true);
      })
      .catch(() => {
        // The registry being unreachable is not a reason to nag. Try again next visit.
      });
    return () => {
      live = false;
    };
  }, [account]);

  if (!show) return null;

  return (
    <div className="flex items-center gap-3 rounded-[16px] border border-line bg-surface px-4 py-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand-kit-assets/mascot-wave-cut.webp"
        alt=""
        aria-hidden="true"
        className="size-10 shrink-0 object-contain"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">Choose your @name</p>
        <p className="text-xs text-ink-soft">So people can pay you without the long address.</p>
      </div>
      <Link
        href="/welcome"
        className="shrink-0 rounded-full border border-line px-3 py-1.5 text-sm font-medium text-ink"
      >
        Open
      </Link>
      <button
        type="button"
        aria-label="Not now"
        onClick={() => {
          markWelcomeSeen();
          setShow(false);
        }}
        className="shrink-0 text-ink-soft"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
