"use client";

/**
 * The small pieces the NEAR screens share, in the rail's own classes (components/near/near.css):
 * a labelled field, a notice, a copy button, a spinner, the explorer link, and the state line
 * "Waiting -> Claimed | Expired -> Returned" that every link carries.
 *
 * The explorer link is deliberately quiet: the chain is the proof, never the call to action.
 */
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { LinkState } from "../../lib/near/link-state";

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="nr-field">
      <label className="nr-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="nr-hint">{hint}</p> : null}
    </div>
  );
}

export function Notice({
  kind = "soft",
  children,
  onRetry,
  retryLabel = "Try again",
}: {
  kind?: "soft" | "warn" | "error";
  children: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className={`nr-notice nr-notice--${kind}`} role={kind === "error" ? "alert" : undefined}>
      <div>{children}</div>
      {onRetry ? (
        <div>
          <button type="button" className="nr-btn nr-btn--sm" onClick={onRetry}>
            {retryLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Spinner() {
  return <span className="nr-spin" aria-hidden="true" />;
}

export function SmallButton({ children, busy, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button type="button" {...rest} disabled={busy || rest.disabled} aria-busy={busy || undefined} className={`nr-btn nr-btn--sm${className ? ` ${className}` : ""}`}>
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function CopyButton({ text, label = "Copy link", className }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1600);
  };
  return (
    <SmallButton onClick={() => void copy()} className={className}>
      {state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : label}
    </SmallButton>
  );
}

/** Secondary by design: the chain is the proof, not the call to action. */
export function ExplorerLink({ href, children = "View on the explorer" }: { href: string; children?: ReactNode }) {
  return (
    <a className="nr-link nr-link--quiet" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** Plain words, the current state highlighted: Waiting -> Claimed | Expired -> Returned. */
export function StateLine({ state, note }: { state: LinkState | null; note?: string }) {
  const step = (s: LinkState, label: string) => (
    <span className="nr-state-step" aria-current={state === s ? "step" : undefined}>
      {label}
    </span>
  );
  return (
    <div className="nr-state" aria-label={state ? `state: ${state}` : "state: not confirmed yet"}>
      {step("waiting", "Waiting")}
      <span className="nr-state-sep" aria-hidden="true">
        -&gt;
      </span>
      {step("claimed", "Claimed")}
      <span className="nr-state-sep" aria-hidden="true">
        |
      </span>
      {step("expired", "Expired")}
      <span className="nr-state-sep" aria-hidden="true">
        -&gt;
      </span>
      {step("returned", "Returned")}
      {note ? <span className="nr-state-note">{note}</span> : null}
    </div>
  );
}

/** Hands the browser a file to save. The key file and the CSV both go through here. */
export function downloadText(filename: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
