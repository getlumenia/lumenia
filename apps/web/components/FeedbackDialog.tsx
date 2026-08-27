"use client";

/**
 * FeedbackDialog — the product's "report a problem" channel. Posts to the sponsor
 * /feedback endpoint, which keeps entries in an ISOLATED store (lib/feedback.ts on
 * the sponsor), never joined to a pubkey or any money data. The contact field is
 * optional and clearly framed — we never require PII to hear about a problem.
 *
 * The overlay is PORTALED to document.body: rendered in-flow (e.g. inside the
 * footer) it inherits a transformed ancestor as its containing block, so
 * position:fixed is not the viewport and the z-50 SiteNav out-stacks it — the
 * documented trap. Portaling also keeps the open dialog's <div> out of the <p>
 * error lines that mount the inline trigger (valid DOM nesting). Because the
 * portal escapes the .pg/.app-pw token scopes, feedback.css carries its own
 * self-contained light+dark palette keyed on data-theme. Never mounted on the
 * frozen claim route.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copy } from "../lib/copy";
import "./feedback.css";

const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";

/** Mirrors CATEGORIES in apps/sponsor/src/lib/feedback.ts — keep in step. */
const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: "claim", label: copy.feedback.catClaim },
  { value: "send", label: copy.feedback.catSend },
  { value: "request", label: copy.feedback.catRequest },
  { value: "money", label: copy.feedback.catMoney },
  { value: "site", label: copy.feedback.catSite },
  { value: "other", label: copy.feedback.catOther },
];

const MAX_MESSAGE = 500;
const MAX_CONTACT = 200;

export function FeedbackDialog({
  trigger,
  triggerClassName = "fb-trigger-link",
  triggerAriaLabel,
  defaultCategory = "other",
}: {
  /** Button content — a label string, or an icon node (pass triggerAriaLabel with icons). */
  trigger: React.ReactNode;
  triggerClassName?: "fb-trigger-link" | "fb-trigger-inline" | "fb-trigger-pill" | "fb-trigger-nav";
  triggerAriaLabel?: string;
  defaultCategory?: "claim" | "send" | "request" | "money" | "site" | "other";
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<string>(defaultCategory);
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // A text-selection drag that ends on the backdrop fires a click ON the backdrop
  // (mousedown target ≠ mouseup target → click lands on the common ancestor) —
  // close only when the press STARTED on the backdrop too, or a drag out of the
  // textarea silently throws the typed report away.
  const pressStartedOnOverlay = useRef(false);

  useEffect(() => {
    if (!open) return;
    messageRef.current?.focus();
    // Scroll-lock the page behind the modal; restore whatever was there before.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
        return;
      }
      // Minimal focus trap — aria-modal promises focus stays inside the card.
      if (e.key === "Tab" && cardRef.current) {
        const focusables = Array.from(
          cardRef.current.querySelectorAll<HTMLElement>("button, input, select, textarea, [href]"),
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
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
     
  }, [open]);

  function openDialog() {
    setDone(false);
    setError(""); // a failure from a previous (possibly cancelled) attempt must not resurface
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setError("");
    triggerRef.current?.focus();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (message.trim().length === 0) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${SPONSOR_URL}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category,
          message: message.trim(),
          ...(contact.trim() ? { contact: contact.trim() } : {}),
        }),
      });
      if (!res.ok) throw new Error();
      setDone(true);
      setMessage("");
      setContact("");
    } catch {
      setError(copy.feedback.error);
    } finally {
      setBusy(false);
    }
  }

  const overlay = (
    <div
      className="fb-overlay"
      onMouseDown={(e) => {
        pressStartedOnOverlay.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressStartedOnOverlay.current) close();
      }}
    >
      <div ref={cardRef} role="dialog" aria-modal="true" aria-label={copy.feedback.title} className="fb-card">
        {done ? (
          <>
            <p className="fb-done">{copy.feedback.done}</p>
            <p className="fb-sub">{copy.feedback.doneSub}</p>
            <div className="fb-actions">
              <button type="button" autoFocus className="fb-btn fb-btn-primary" onClick={close}>
                {copy.feedback.close}
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} className="contents">
            <div>
              <h2 className="fb-title">{copy.feedback.title}</h2>
              <p className="fb-sub">{copy.feedback.sub}</p>
            </div>

            <div>
              <label className="fb-label" htmlFor="fb-category">{copy.feedback.categoryLabel}</label>
              <select
                id="fb-category"
                className="fb-field"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="fb-label" htmlFor="fb-message">{copy.feedback.messageLabel}</label>
              <textarea
                id="fb-message"
                ref={messageRef}
                className="fb-field"
                required
                maxLength={MAX_MESSAGE}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={copy.feedback.messagePlaceholder}
              />
              <p className="fb-count">{message.length}/{MAX_MESSAGE}</p>
            </div>

            <div>
              <label className="fb-label" htmlFor="fb-contact">{copy.feedback.contactLabel}</label>
              <input
                id="fb-contact"
                className="fb-field"
                maxLength={MAX_CONTACT}
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder={copy.feedback.contactPlaceholder}
              />
            </div>

            {error && <p className="fb-error" role="alert">{error}</p>}

            <div className="fb-actions">
              <button type="button" className="fb-btn fb-btn-quiet" onClick={close}>
                {copy.feedback.cancel}
              </button>
              <button type="submit" disabled={busy || message.trim().length === 0} className="fb-btn fb-btn-primary">
                {busy ? copy.feedback.sending : copy.feedback.submit}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );

  return (
    <>
      <button ref={triggerRef} type="button" className={triggerClassName} aria-label={triggerAriaLabel} onClick={openDialog}>
        {trigger}
      </button>
      {/* `open` can only become true after a click, so document always exists here. */}
      {open && createPortal(overlay, document.body)}
    </>
  );
}
