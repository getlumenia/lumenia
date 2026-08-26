"use client";

/**
 * "Real money is invite-only" — and here is how you ask.
 *
 * Tapping the real-money option used to end in a refusal and nothing else, which is a door with no
 * handle. This is the handle. But it deliberately does NOT become a shortcut around the two things
 * the pilot depends on, because the point of the pilot is that the money is real:
 *
 *   - WITH NO ACCOUNT there is nothing to approve. Approval is granted to a public key by hand, and
 *     a person who has not opened an account does not have one. What they can do is leave an email
 *     and be told when real money opens — the isolated waitlist store, never joined to a pubkey.
 *
 *   - WITH AN ACCOUNT the request carries that account's address, and /pilot's precondition holds:
 *     real money must never sit under a device-only key, so an account that is not locked AND
 *     backed up is sent to do that first rather than being quietly let in. This dialog states the
 *     rule and hands over; it does not restate the pilot's own honest warnings, which is why the
 *     full page still exists.
 *
 * A repeat ask is idempotent on the server (`already: true`), and is reported as reassurance rather
 * than as a fresh submission.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { X } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { hasBackup } from "../../lib/recovery-api";
import { mainnetConfig, activeNetwork } from "../../lib/network";
import { PrimaryButton } from "./PrimaryButton";

type View = "form" | "sent" | "already";

export function JoinPilotDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { account, pilotState } = useWallet();
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
      // The allowlist lives on the MAINNET worker — the namespace the owner approves in.
      const target = mainnetConfig()?.sponsorUrl ?? activeNetwork().sponsorUrl;
      try {
        if (account) {
          const res = await fetch(`${target.replace(/\/$/, "")}/pilot-request`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pubkey: account.address, email }),
          });
          const body = (await res.json().catch(() => ({}))) as { already?: boolean; error?: string };
          if (!res.ok) throw new Error(body.error ?? "Please try again.");
          setView(body.already ? "already" : "sent");
          return;
        }
        // No account: there is no key to approve, so this is the waitlist — an isolated store that
        // is never joined to any account or any money.
        //
        // SAME TARGET as the account path, deliberately. Asking to join is not a money operation,
        // so routing it at whichever network this device happens to be flipped to would file the
        // same question in two different places depending on a setting the person did not make for
        // this purpose. The pilot allowlist lives on the mainnet worker, so that is where asks go.
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
    [account, email],
  );

  if (!open || typeof document === "undefined") return null;

  /* Locked AND backed up — `phase === 2` alone would let someone who locked from /home skip the
     backup and then be told they had one (the same trap /pilot documents). */
  const readyToAsk = !account || (account.phase === 2 && hasBackup(account.address));
  const asked = pilotState === "pending";

  const body = asked ? (
    <>
      <h2 className="app-modal-t">You&apos;re already on the list</h2>
      <p className="app-modal-s">
        We turn real money on for each account by hand, and we&apos;ll email you the moment your spot
        opens. Nothing else to do.
      </p>
      <button type="button" className="app-modal-ghost" onClick={onClose}>
        Close
      </button>
    </>
  ) : view === "sent" ? (
    <>
      <h2 className="app-modal-t">Asked</h2>
      <p className="app-modal-s">
        {account
          ? "We got it. We turn real money on for each account by hand, and we'll email you when yours is ready."
          : "We'll email you when real money opens up. Your email is kept on its own, never tied to any account or any money."}
      </p>
      <button type="button" className="app-modal-ghost" onClick={onClose}>
        Close
      </button>
    </>
  ) : view === "already" ? (
    <>
      <h2 className="app-modal-t">You&apos;ve already asked</h2>
      <p className="app-modal-s">
        We have your request for this account — no need to send it again. We&apos;ll email you when
        your spot opens.
      </p>
      <button type="button" className="app-modal-ghost" onClick={onClose}>
        Close
      </button>
    </>
  ) : !readyToAsk ? (
    <>
      <h2 className="app-modal-t">One thing first</h2>
      <p className="app-modal-s">
        Real money must never sit under a key that anyone holding this phone could use. Lock your
        money with a password and back it up, and then you can ask to join.
      </p>
      <Link href="/pilot" className="app-modal-cta" onClick={onClose}>
        Lock it and ask to join
      </Link>
      <button type="button" className="app-modal-ghost" onClick={onClose}>
        Not now
      </button>
    </>
  ) : (
    <>
      <h2 className="app-modal-t">Ask for real money</h2>
      <p className="app-modal-s">
        Real money is an early pilot, opened one account at a time by hand. Leave your email and
        we&apos;ll tell you when yours is ready.
      </p>
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
          Ask to join
        </PrimaryButton>
      </form>
      <p className="app-modal-fine">
        Your email is used to tell you about the pilot and nothing else. It is kept on its own, never
        joined to your account or your money.
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
