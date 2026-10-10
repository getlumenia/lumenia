"use client";

/**
 * "Real money is invite-only", and here is how you ask, for a device with NO account yet.
 *
 * Tapping the real-money option used to end in a refusal and nothing else, which is a door with no
 * handle. This is the handle. It is mounted only where there is no account (the money choice on
 * /welcome), and there is nothing to approve there: approval is granted to one account at a time,
 * by hand, and a person who has not opened an account does not have one yet. So it says that, and
 * offers the two honest ways on: make the account first and ask from it (on /pilot, where the ask
 * is signed by that account, lib/pilot-ask.ts), or leave an email to hear when real money opens to
 * everyone (the isolated waitlist store, never joined to a pubkey).
 *
 * It used to carry an account branch too, posting an unsigned ask with a typed email: that branch
 * could never mount (there is no account where this sheet lives), and an unsigned ask is what let
 * anybody file for any key. It is gone. Before the waitlist form it shows the real-money warning
 * verbatim (lib/real-money.ts, decision D1), the same words as /pilot and the sheet before the
 * first switch.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { X } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { mainnetConfig, activeNetwork } from "../../lib/network";
import { REAL_MONEY_WARNING } from "../../lib/real-money";
import { PrimaryButton } from "./PrimaryButton";

type View = "form" | "sent";

export function JoinPilotDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { pilotState, switchNetwork } = useWallet();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("form");
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** A drag that starts inside and ends on the backdrop must not throw away what was typed. */
  const pressedOverlay = useRef(false);

  // Same a11y contract the feedback dialog keeps: focus in, Escape out, page behind locked.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab" || !cardRef.current) return;
      const focusables = Array.from(
        cardRef.current.querySelectorAll<HTMLElement>("button, input, [href]"),
      ).filter((n) => !n.hasAttribute("disabled"));
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      const inside = cardRef.current.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError("");
      // The pilot lives on the MAINNET worker: the namespace the owner approves in.
      const target = mainnetConfig()?.sponsorUrl ?? activeNetwork().sponsorUrl;
      try {
        // No account: there is no key to approve, so this is the waitlist — an isolated store that
        // is never joined to any account or any money.
        //
        // The mainnet worker, deliberately. Asking is not a money operation, so routing it at
        // whichever network this device happens to be flipped to would file the same question in
        // two different places depending on a setting the person did not make for this purpose.
        const res = await fetch(`${target.replace(/\/$/, "")}/waitlist`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ list: "pilot", email }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "Please try again.");
        }
        setView("sent");
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [email],
  );

  if (!open || typeof document === "undefined") return null;

  // The pilot is retired: there is nothing to ask for, and the switch is one tap away (the
  // once-only warning sheet shows on the switch itself).
  const retired = pilotState === "open";

  const body = retired ? (
    <>
      <h2 className="app-modal-t">Real money is open to everyone</h2>
      <p className="app-modal-s">
        No invite needed any more. Transfers are capped, and the first switch shows you the one
        thing to know before you use real money here.
      </p>
      <button
        type="button"
        className="app-modal-cta"
        onClick={() => {
          onClose();
          switchNetwork("public");
        }}
      >
        Switch to real money
      </button>
      <button type="button" className="app-modal-ghost" onClick={onClose}>
        Not now
      </button>
    </>
  ) : view === "sent" ? (
    <>
      <h2 className="app-modal-t">You&apos;re on the waitlist</h2>
      <p className="app-modal-s">We&apos;ll email you when real money opens to everyone.</p>
      <button type="button" className="app-modal-ghost" onClick={onClose}>
        Close
      </button>
    </>
  ) : (
    <>
      <h2 className="app-modal-t">Ask for real money</h2>
      <p className="app-modal-s">{REAL_MONEY_WARNING}</p>
      <p className="app-modal-s">
        Real money is approved one account at a time. Make your account first, then ask from it.
      </p>
      <Link href="/start" className="app-modal-cta" onClick={onClose}>
        Make my account first
      </Link>
      <p className="app-modal-s">Or leave your email, and we&apos;ll tell you when real money opens to everyone.</p>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
        <input
          ref={inputRef}
          type="email"
          required
          value={email}
          onChange={(ev) => setEmail(ev.target.value)}
          placeholder="you@example.com"
          autoCapitalize="none"
          autoCorrect="off"
          className="h-12 rounded-[14px] border border-line bg-surface px-3 text-ink outline-none"
        />
        <PrimaryButton type="submit" loading={busy} loadingLabel="Sending…" disabled={email.length < 5}>
          Join the waitlist
        </PrimaryButton>
      </form>
      <p className="app-modal-fine">
        Your email is used to tell you when real money opens and nothing else. It is kept on its own,
        never joined to any account or any money.
      </p>
      {error && <p className="app-modal-err">{error}</p>}
    </>
  );

  return createPortal(
    <div
      className="app-modal-overlay"
      onMouseDown={(e) => {
        pressedOverlay.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedOverlay.current) onClose();
      }}
    >
      <div ref={cardRef} role="dialog" aria-modal="true" aria-label="Ask for real money" className="app-modal">
        <button type="button" onClick={onClose} aria-label="Close" className="app-modal-x">
          <X className="size-4" aria-hidden="true" />
        </button>
        {body}
      </div>
    </div>,
    document.body,
  );
}
