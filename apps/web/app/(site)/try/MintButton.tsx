/**
 * MintButton — the one action on /demo. Mints a real claim link from the sponsor's
 * /demo-link (faucet-funded, aggressively rate-limited) and drops the visitor straight onto the
 * real claim screen.
 *
 * The mint + navigation logic is carried over unchanged from the page's warm-paper version. Two
 * parts of it are load-bearing and must not be "tidied":
 *   - `window.location.href`, NOT the router. The bearer key travels in the URL #fragment, and a
 *     client-side navigation would not set it on the claim page.
 *   - the balance id is truncated to its last 8 chars for the /c/[id] segment, while the FULL id
 *     goes in the `b` query param — the claim page needs both.
 *
 * The button is the only client boundary on the page; everything else stays server-rendered, so the
 * hero paints without waiting on this.
 */
"use client";

import { useState } from "react";

const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";

export function MintButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function mint() {
    setBusy(true);
    setError("");
    try {
      // `.catch(() => null)` rather than letting fetch reject: a network-level failure throws a
      // TypeError whose message is the browser's own ("Failed to fetch"), and the old code put that
      // string straight on the page. Measured against the live sponsor from localhost, where CORS
      // blocks the call, the demo's one and only button answered "Failed to fetch". The !res.ok
      // path below — where the sponsor sends a real, human reason — is unchanged.
      const res = await fetch(`${SPONSOR_URL}/demo-link`, { method: "POST" }).catch(() => null);
      if (!res) throw new Error("We couldn't reach it just now. Check your connection and try again.");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "This isn't available right now. Please try again in a moment.");
      const d = (await res.json()) as { balanceId: string; bearerSecret: string; amount: string; issuer: string; from: string };
      const id = d.balanceId.slice(-8);
      const q = `a=${encodeURIComponent(d.amount)}&s=${encodeURIComponent(d.from)}&b=${d.balanceId}&i=${d.issuer}`;
      // full navigation so the #fragment (bearer key) is set on the claim page
      window.location.href = `/c/${id}?${q}#${d.bearerSecret}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="dm-action">
      <button className="dm-btn" onClick={mint} disabled={busy}>
        {busy ? "Making your link…" : "Send myself a link"}
      </button>
      {/* aria-live so the failure is announced, not just painted. The button stays enabled after an
          error — the endpoint is rate-limited, and trying again is the right move. */}
      <p className="dm-error" role="status" aria-live="polite">
        {error}
      </p>
    </div>
  );
}
