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

import { useEffect, useState } from "react";

const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
const RESUME_KEY = "lumenia.try.link";

export function MintButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resume, setResume] = useState<string | null>(null);

  // If a link was minted in this tab and the visitor came back here — the natural move after a
  // reload wiped the key from the claim page's address bar — offer it again instead of letting
  // them mint a second one and strand the first.
  useEffect(() => {
    try {
      setResume(sessionStorage.getItem(RESUME_KEY));
    } catch {
      /* storage blocked */
    }
  }, []);

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
      const link = `/c/${id}?${q}#${d.bearerSecret}`;
      // Keep the link where a RELOAD can find it again.
      //
      // The claim route strips the #fragment from the address bar the moment it reads it, which is
      // correct — the bearer key must not sit in history, in a screenshot, or in a Referer header.
      // But a real link also lives in the chat it arrived through, so the recipient can always
      // reopen it. A link minted here has never been anywhere: press reload once and the only copy
      // of the key is gone, leaving money that nobody can claim until the sponsor reclaims it.
      // sessionStorage is the right scope — this tab, this visit, cleared when the tab closes.
      try {
        sessionStorage.setItem("lumenia.try.link", link);
      } catch {
        /* storage blocked — the claim still works, a reload just can't be rescued */
      }
      // full navigation so the #fragment (bearer key) is set on the claim page
      window.location.href = link;
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
      {resume && !busy && (
        <p className="dm-error" role="status">
          You already have a link waiting.{" "}
          <a href={resume} style={{ fontWeight: 600, textDecoration: "underline" }}>
            Open it again
          </a>
        </p>
      )}
      {/* aria-live so the failure is announced, not just painted. The button stays enabled after an
          error — the endpoint is rate-limited, and trying again is the right move. */}
      <p className="dm-error" role="status" aria-live="polite">
        {error}
      </p>
    </div>
  );
}
