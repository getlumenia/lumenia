"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Keypair } from "@stellar/stellar-sdk";
import { copy } from "../../../lib/copy";
import { runClaim } from "../../../lib/sponsor";
import { sendEvent } from "../../../lib/events";
import { savePhase1 } from "../../../lib/keystore";
import { MoneyMovingAnimation } from "../../../components/brand/MoneyMovingAnimation";
import { Confetti } from "../../../components/brand/Confetti";

/**
 * The claim action — runs AFTER the user has already seen their money (value-first).
 * The bearer key is read from the URL #fragment, held in memory, and the fragment
 * is stripped from the URL immediately (owner caveat C3: read → memory → strip →
 * use-from-memory-on-click). The sponsor creates a 0-XLM account + trustline, then
 * fee-bumps the claim; the recipient holds 0 XLM and pays no gas.
 *
 * NO Motion/animation library on this route — the morph (button → money-moving
 * pulse → success bloom + confetti) is CSS-only. runClaim is unchanged.
 * Out of scope this sprint: recovery/passkeys/Argon2id — the key comes from the link.
 */
const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.vercel.app";
const explorer = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

type State = "idle" | "claiming" | "done" | "error";

export default function ClaimButton({
  claimId,
  balanceId,
  sender,
}: {
  claimId: string;
  balanceId?: string;
  sender: string;
}) {
  const [state, setState] = useState<State>("idle");
  const [hash, setHash] = useState("");
  const [slow, setSlow] = useState(false);
  // Optimistic: SSR + first paint show the claim button (the common case has a key
  // in the fragment). Only the rare no-key case (e.g. a reloaded, already-stripped
  // URL) swaps to the "open your original link" message after mount.
  const [noKey, setNoKey] = useState(false);
  const secretRef = useRef("");

  // C3 — read the bearer key at mount, keep it in memory, strip the fragment from
  // the URL right away (referrer/history/analytics leak surface). Fire claim_opened
  // (C2: hashed claim id, never the url/fragment).
  useEffect(() => {
    const frag = window.location.hash.slice(1);
    if (frag) {
      secretRef.current = frag;
      history.replaceState(null, "", window.location.pathname + window.location.search);
    } else if (!secretRef.current) {
      setNoKey(true);
    }
    void sendEvent("claim_opened", claimId);
  }, [claimId]);

  async function onClaim() {
    setState("claiming");
    setSlow(false);
    const slowTimer = setTimeout(() => setSlow(true), 4000);
    try {
      const bearerSecret = secretRef.current;
      if (!bearerSecret) throw new Error("This link is invalid (missing key).");
      if (!balanceId) throw new Error("This link is invalid (missing balance info).");
      const result = await runClaim({ sponsorUrl: SPONSOR_URL, bearerSecret, balanceId });
      setHash(result.hash);
      setState("done");
      void sendEvent("claim_succeeded", claimId);
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(30);
      // Phase 1 — persist the claimed account locally (WebCrypto-wrapped seed in
      // IndexedDB) so /home has it. Best-effort: never block the success screen.
      try {
        const kp = Keypair.fromSecret(bearerSecret);
        await savePhase1(kp.publicKey(), new Uint8Array(kp.rawSecretKey()));
      } catch {
        /* the money still landed; /home just won't show it on this device */
      }
    } catch {
      setState("error");
      void sendEvent("claim_failed", claimId);
    } finally {
      clearTimeout(slowTimer);
    }
  }

  // In-place morph — no navigation (webview back-buttons are landmines).
  if (state === "claiming") {
    return (
      <div className="w-full py-4">
        <MoneyMovingAnimation label={slow ? copy.claim.slow : copy.claim.claiming} />
      </div>
    );
  }

  if (state === "done") {
    return (
      <div className="relative flex w-full flex-col items-center gap-4" data-tx-hash={hash}>
        <Confetti />
        <div className="flex flex-col items-center gap-1">
          <p className="text-lg font-semibold text-money">{copy.claim.doneLabel}</p>
          <p className="text-ink-soft">{copy.claim.doneSub}</p>
        </div>
        <a
          href={explorer(hash)}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-ink-soft underline-offset-2 hover:underline"
        >
          {copy.claim.receipt} ↗
        </a>
        {/* Post-claim next action. "See my money" → /home is live (the claimed
            account is persisted locally). Send/Ask go live in Stage 5; honest
            "soon" until then, never a dead link. */}
        <div className="mt-2 flex w-full flex-col gap-2">
          <Link
            href="/home"
            prefetch={false}
            className="flex h-12 w-full items-center justify-center rounded-full bg-money text-sm font-semibold text-primary-foreground"
          >
            See my money
          </Link>
          <Link
            href="/send"
            prefetch={false}
            className="flex h-11 w-full items-center justify-center rounded-full border border-line text-sm font-medium text-ink"
          >
            {copy.claim.ctaSend}
          </Link>
          {/* /request shipped — this was still a disabled "soon" button long after it went live. */}
          <Link
            href="/request"
            prefetch={false}
            className="flex h-11 w-full items-center justify-center rounded-full border border-line text-sm font-medium text-ink"
          >
            {copy.claim.ctaRequest}
          </Link>
        </div>
      </div>
    );
  }

  // idle / error
  return (
    <div className="flex w-full flex-col items-center gap-3">
      {noKey ? (
        <p className="text-sm text-ink-soft">Open your original link to claim this money.</p>
      ) : (
        <button
          onClick={onClaim}
          data-claim-id={claimId}
          className="h-14 w-full rounded-full bg-money px-8 text-base font-semibold text-primary-foreground transition-colors hover:bg-money/90 active:bg-money-pressed"
        >
          {copy.claim.claimCta}
        </button>
      )}
      {state === "error" && <p className="text-sm text-danger">{copy.claim.error(sender)}</p>}
    </div>
  );
}
