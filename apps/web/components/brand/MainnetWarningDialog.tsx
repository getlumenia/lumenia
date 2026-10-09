"use client";

/**
 * The one warning everyone reads once before their first switch to real money.
 *
 * While real money was invite-only, the warning lived on /pilot and only the people who asked to
 * join ever saw it. With the pilot retired (the sponsor answers "open"), the switch is one tap from
 * several screens, and none of them is a place for three sentences of caution. So the WalletProvider
 * shows this sheet the first time a device switches to real money, whatever screen asked, and
 * remembers the acknowledgement per device. It shows in pilot mode too: an approved wallet is not a
 * reason to skip the sentence about outside review.
 *
 * It also shows when the app OPENS on real money on a device that never acknowledged it (`arrived`):
 * a mainnet claim sets the network on the claim page, outside the provider, and a device can already
 * be on real money. There "Not now" means back to practice money (lib/pilot-access.ts
 * mainnetWarningPlan), so the buttons say so.
 *
 * Same modal skeleton as JoinPilotDialog (focus in, Escape out, page behind locked).
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { PrimaryButton } from "./PrimaryButton";
import { REAL_MONEY_WARNING, pilotCapsSentence } from "../../lib/real-money";

const SEEN_KEY = "lumenia.mainnet.warned.v1";

/** Has this device acknowledged the real-money warning? Blocked storage reads as "not yet". */
export function mainnetWarningSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markMainnetWarningSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode: the sheet simply shows again next time, which is the safe direction */
  }
}

export function MainnetWarningDialog({
  open,
  arrived = false,
  backToPractice = arrived,
  onConfirm,
  onClose,
}: {
  open: boolean;
  /** The device is already on real money (see above): closing the sheet goes back to practice money. */
  arrived?: boolean;
  /**
   * Arrival only: whether "Not now" takes the device back to practice money. False when the way back
   * to real money is closed to this account (the provider then keeps it where it is), so the button
   * must not promise practice money.
   */
  backToPractice?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const title = arrived ? "Before you use real money" : "Before you switch to real money";
  const cardRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab" || !cardRef.current) return;
      const focusables = Array.from(cardRef.current.querySelectorAll<HTMLElement>("button, [href]")).filter(
        (n) => !n.hasAttribute("disabled"),
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="app-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={cardRef} role="dialog" aria-modal="true" aria-label={title} className="app-modal">
        <button type="button" onClick={onClose} aria-label={backToPractice ? "Close and use practice money" : "Close"} className="app-modal-x">
          <X className="size-4" aria-hidden="true" />
        </button>
        <h2 className="app-modal-t">{title}</h2>
        {/* The warning verbatim (lib/real-money.ts, decision D1), then the caps as their own sentence. */}
        <p className="app-modal-s">{REAL_MONEY_WARNING}</p>
        <p className="app-modal-s">{pilotCapsSentence()}</p>
        <div className="mt-3 flex flex-col gap-2">
          <PrimaryButton ref={firstRef} onClick={onConfirm}>
            I understand
          </PrimaryButton>
          <button type="button" className="app-modal-ghost" onClick={onClose}>
            {backToPractice ? "Not now, use practice money" : "Not now"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
