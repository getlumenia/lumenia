"use client";

/**
 * The small pieces the practice-money screens share, in their own classes (components/near/
 * near.css): a labelled field, a notice, a copy button, a spinner, the explorer link, the state
 * line "Waiting -> Claimed | Expired -> Returned" that every link carries, and the two pieces the
 * one-product rule rests on:
 *
 *   - Details: the one consumer place where the network is named. Every payment row and every done
 *     screen gets this small disclosure (date and time, status, amount, network fee, a Network row,
 *     and last the explorer link), the pattern wallets and payment apps settled on. Headings,
 *     buttons and leads never name a network.
 *   - PracticeBand: the quiet, persistent "Practice mode: no real money moves" band on the screens
 *     that make or claim practice links, the way sandboxes and test networks are labelled elsewhere.
 *
 * The explorer link is deliberately quiet: the ledger is the proof, never the call to action.
 */
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { LinkState } from "../../lib/near/link-state";
import { NEAR_CONTRACT_ID, NEAR_IS_TESTNET, NEAR_NETWORK, explorerAccountUrl } from "../../lib/near/config";

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

/** Secondary by design: the ledger is the proof, not the call to action. */
export function ExplorerLink({ href, children = "View on explorer" }: { href: string; children?: ReactNode }) {
  return (
    <a className="nr-link nr-link--quiet" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** The Network row's value, as every Details disclosure and receipt prints it: "NEAR testnet". */
export const NETWORK_LABEL = `NEAR ${NEAR_NETWORK}`;

export type DetailRow = [label: string, value: ReactNode];

/**
 * The Details disclosure. Rows in the order the pattern fixes (date and time, status, amount,
 * network fee, then Network), the explorer link last. `network` is added by default so a caller
 * cannot forget the one row the whole rule hangs on; the summary stays "Details" everywhere.
 */
export function Details({
  rows,
  explorer,
  network = true,
  summary = "Details",
  className,
}: {
  rows: ReadonlyArray<DetailRow | null | undefined | false>;
  /** One or more explorer links, each [label, href]; rendered last. */
  explorer?: ReadonlyArray<[label: string, href: string]>;
  network?: boolean;
  summary?: ReactNode;
  className?: string;
}) {
  const shown = rows.filter((r): r is DetailRow => Array.isArray(r));
  return (
    <details className={`nr-details${className ? ` ${className}` : ""}`}>
      <summary>{summary}</summary>
      <dl className="nr-details-rows">
        {shown.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        {network ? (
          <div>
            <dt>Network</dt>
            <dd>{NETWORK_LABEL}</dd>
          </div>
        ) : null}
      </dl>
      {explorer && explorer.length ? (
        <p className="nr-details-links">
          {explorer.map(([label, href]) => (
            <ExplorerLink key={href} href={href}>
              {label}
            </ExplorerLink>
          ))}
        </p>
      ) : null}
    </details>
  );
}

/** The escrow's own rows, for the Details under a form: where the money waits while a link is open. */
export function escrowRows(): DetailRow[] {
  return [
    ["Held by", <span key="escrow" className="nr-mono">{NEAR_CONTRACT_ID}</span>],
    ["Held as", "USDC, a dollar-denominated asset"],
  ];
}

export function escrowExplorer(): [string, string][] {
  return [["View the escrow on explorer", explorerAccountUrl(NEAR_CONTRACT_ID)]];
}

/**
 * The practice-mode band: persistent, quiet, on every screen that makes or claims a practice link.
 * Nothing on a real network, so it says nothing there.
 */
export function PracticeBand({ className }: { className?: string }) {
  if (!NEAR_IS_TESTNET) return null;
  return (
    <p className={`nr-practice${className ? ` ${className}` : ""}`} role="note">
      <span className="nr-practice-dot" aria-hidden="true" />
      Practice mode: no real money moves. These are practice dollars.
    </p>
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
