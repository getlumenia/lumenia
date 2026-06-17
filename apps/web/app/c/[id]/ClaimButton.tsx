"use client";

import { useState } from "react";
import { tr } from "../../../lib/copy";

/**
 * The claim action — runs AFTER the user has already seen their money.
 *
 * Real flow (to wire): detect environment → if a real browser, create a passkey
 * (WebAuthn PRF) for recovery; if WhatsApp's in-app webview, set up an Argon2id
 * password (or escape to the browser on Android via intent://). Then build the
 * sponsored claim inner tx, send it to the sponsor service for anti-drain
 * validation + fee-bump (see @lumenia/shared + Spikes #1/#1c). The bearer secret
 * lives in the URL fragment (window.location.hash) and never leaves the client.
 *
 * Stubbed here: the deferred-credential, value-first UX shell. One mental model
 * for recovery — "your password is the master key; Face ID is a shortcut."
 */
export default function ClaimButton({ claimId }: { claimId: string }) {
  const [state, setState] = useState<"idle" | "claiming" | "done">("idle");

  async function onClaim() {
    setState("claiming");
    // const secret = window.location.hash.slice(1); // bearer claim-key, client-only
    // TODO: environment-detect → recovery setup (Argon2id primary / PRF upgrade)
    // TODO: build inner claim tx (@lumenia/shared) → POST to sponsor /feebump
    await new Promise((r) => setTimeout(r, 1200)); // placeholder
    setState("done");
  }

  if (state === "done") {
    return <p style={{ fontWeight: 600 }}>{tr.claim.done}</p>;
  }
  return (
    <button className="btn" onClick={onClaim} disabled={state === "claiming"} data-claim-id={claimId}>
      {state === "claiming" ? tr.claim.claiming : tr.claim.claimCta}
    </button>
  );
}
