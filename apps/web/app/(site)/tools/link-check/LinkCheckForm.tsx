"use client";

/**
 * Paste a money link → is it still waiting, claimed, or returned? CLIENT-SIDE ONLY, and it NEVER
 * transmits the link's #fragment (the bearer key = cash): it reads only the public balance id from
 * the query and checks the ledger. The disclosure below says so explicitly. Logic unchanged.
 */
import { useState } from "react";
import { loadLinkStatus } from "../../../../lib/horizon";

export function LinkCheckForm() {
  const [link, setLink] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "pending" | "settled" | "error">("idle");

  async function check(e: React.FormEvent) {
    e.preventDefault();
    let balanceId = "";
    try {
      const u = new URL(link.trim());
      balanceId = u.searchParams.get("b") ?? ""; // ONLY the public id — never the #fragment
    } catch {
      /* not a URL */
    }
    if (!/^[a-f0-9]{72}$/i.test(balanceId)) {
      setState("error");
      return;
    }
    setState("loading");
    try {
      setState(await loadLinkStatus(balanceId));
    } catch {
      setState("error");
    }
  }

  return (
    <>
      <div className="tool-notice">
        This check happens entirely in your browser. We only look at the public part of the link — the
        secret key part is never sent anywhere. Still, treat a money link like cash: keep it private.
      </div>
      <form onSubmit={check} className="tool-form" style={{ marginTop: "18px" }}>
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Paste a money link"
          aria-label="Money link"
          className="tool-input"
        />
        <button className="pg-btn pg-btn-primary tool-submit">Check</button>
      </form>

      {state === "loading" && <p className="tool-status">Checking…</p>}
      {state === "error" && <p className="tool-error">That doesn&apos;t look like a valid money link.</p>}
      {state === "pending" && (
        <div className="tool-card">
          <p className="tool-note">
            ⏳ Still waiting to be claimed. If nobody claims it, it comes back to the sender after 7 days.
          </p>
        </div>
      )}
      {state === "settled" && (
        <div className="tool-card">
          <p className="tool-note">
            ✓ This link is done — the money has been claimed or returned to the sender.
          </p>
        </div>
      )}
    </>
  );
}
