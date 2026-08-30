"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Keypair } from "@stellar/stellar-sdk";
import { copy } from "../../../lib/copy";
import { runClaim } from "../../../lib/sponsor";
import { classifyClaimError, type ClaimErrorInfo } from "../../../lib/claim-error";
import { resolveNetwork } from "../../../lib/network";
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
const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
/* These links were minted on testnet and are claimable only there, so the network is pinned to the
 * link rather than taken from the device — a reader who has switched this device to mainnet would
 * otherwise build against one chain while the money sits on the other. */
const CLAIM_NETWORK = resolveNetwork(null);
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
  /** True when the key is gone because this page was reloaded, not because the link lacked one. */
  const [reloaded, setReloaded] = useState(false);
  /** Why the last attempt failed. Null until one does. */
  const [failure, setFailure] = useState<ClaimErrorInfo | null>(null);
  const secretRef = useRef("");

  /* Marker that THIS tab already saw a key for THIS claim, so a later mount without one can tell
   * "you reloaded" from "this link never had a key" and give the right instruction. It is a
   * boolean, never the key. The claim id is already in the URL and in browser history, so writing
   * it here reveals nothing new — and sessionStorage dies with the tab. */
  const seenKey = `lumenia.claim.seen.${claimId}`;

  // C3 — read the bearer key at mount, keep it in memory, strip the fragment from
  // the URL right away (referrer/history/analytics leak surface). Fire claim_opened
  // (C2: hashed claim id, never the url/fragment).
  useEffect(() => {
    const frag = window.location.hash.slice(1);
    if (frag) {
      secretRef.current = frag;
      try {
        sessionStorage.setItem(seenKey, "1");
      } catch {
        /* private mode or blocked storage — we just lose the nicer reload message */
      }
      history.replaceState(null, "", window.location.pathname + window.location.search);
    } else if (!secretRef.current) {
      /* Stripping the fragment means a reload lands here with no key — and the old copy told the
       * person to "open your original link", which is exactly where they already were. A dead end
       * on the one screen that must never have one. If we stripped a key in this tab, say what
       * actually happened and what actually works: tap the link in the chat again. */
      let strippedHere = false;
      try {
        strippedHere = sessionStorage.getItem(seenKey) === "1";
      } catch {
        /* storage unavailable — fall back to the generic message */
      }
      if (strippedHere) setReloaded(true);
      else setNoKey(true);
    }
    void sendEvent("claim_opened", claimId);
  }, [claimId, seenKey]);

  async function onClaim() {
    setState("claiming");
    setSlow(false);
    setFailure(null);
    const slowTimer = setTimeout(() => setSlow(true), 4000);
    try {
      const bearerSecret = secretRef.current;
      if (!bearerSecret) throw new Error("This link is invalid (missing key).");
      if (!balanceId) throw new Error("This link is invalid (missing balance info).");
      const result = await runClaim({
        sponsorUrl: SPONSOR_URL,
        bearerSecret,
        balanceId,
        network: CLAIM_NETWORK,
      });
      setHash(result.hash);
      setState("done");
      void sendEvent("claim_succeeded", claimId, Keypair.fromSecret(bearerSecret).publicKey());
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(30);
      // Phase 1 — persist the claimed account locally (WebCrypto-wrapped seed in
      // IndexedDB) so /home has it. Best-effort: never block the success screen.
      try {
        const kp = Keypair.fromSecret(bearerSecret);
        await savePhase1(kp.publicKey(), new Uint8Array(kp.rawSecretKey()));
      } catch {
        /* the money still landed; /home just won't show it on this device */
      }
    } catch (err) {
      // Bind it. The old `catch {}` discarded the cause, so every failure — already claimed, rate
      // limited, offline — rendered the same "your money is still safe, try again", which is false
      // advice for the commonest case and left us nothing to debug from a bug report.
      const info = classifyClaimError(err);
      setFailure(info);
      setState("error");
      // Safe to log: classifyClaimError never carries the bearer key, and this is the only place a
      // developer or a reporting user can see what actually happened.
      console.warn("[claim] failed:", info.kind, "—", info.detail);
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

  /* Already claimed is not an error state — the money arrived, on an earlier tap. Telling someone
   * their payment failed when they have in fact been paid is the worst thing this screen can do,
   * and it is what it used to do. So this reads like the success screen, minus the celebration. */
  if (state === "error" && failure?.kind === "already-claimed") {
    return (
      <div className="flex w-full flex-col items-center gap-4">
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-lg font-semibold text-money">{copy.claim.errAlreadyTitle}</p>
          <p className="text-ink-soft">{copy.claim.errAlreadyBody}</p>
        </div>
        <Link
          href="/home"
          prefetch={false}
          className="flex h-12 w-full items-center justify-center rounded-full bg-money text-sm font-semibold text-primary-foreground"
        >
          See my money
        </Link>
      </div>
    );
  }

  const failureBody = (() => {
    switch (failure?.kind) {
      case "busy":
        return copy.claim.errBusyBody;
      case "paused":
        return copy.claim.errPausedBody;
      case "offline":
        return copy.claim.errOfflineBody;
      case "link-invalid":
        return copy.claim.errLinkBody;
      case "refused":
        // We stopped before putting a signature on anything, so "try again" would be false advice:
        // the same answer refuses the same way. Nothing about the money changed.
        return "We stopped before signing anything — what came back didn't match what this app asked for. Your money is untouched. Open the link from the original message again a little later.";
      default:
        // Cause unknown — the original wording, which is honest when we do not know: the money has
        // not moved, and trying again is reasonable.
        return copy.claim.error(sender);
    }
  })();

  // idle / error
  return (
    <div className="flex w-full flex-col items-center gap-3">
      {reloaded ? (
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-base font-semibold text-ink">{copy.claim.reloadedTitle}</p>
          <p className="text-sm text-ink-soft">{copy.claim.reloadedBody}</p>
        </div>
      ) : noKey ? (
        <p className="text-sm text-ink-soft">Open your original link to claim this money.</p>
      ) : (
        // A failure we know cannot succeed on retry gets no button — offering one is an invitation
        // to fail again.
        (state !== "error" || failure?.retryable !== false) && (
          <button
            onClick={onClaim}
            data-claim-id={claimId}
            className="h-14 w-full rounded-full bg-money px-8 text-base font-semibold text-primary-foreground transition-colors hover:bg-money/90 active:bg-money-pressed"
          >
            {state === "error" ? copy.claim.retry : copy.claim.claimCta}
          </button>
        )
      )}
      {state === "error" && (
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-sm text-danger">{failureBody}</p>
          {/* Small, muted, and deliberately present: it is what turns "it didn't work" into a
              report we can act on. */}
          {failure?.detail && (
            <p className="text-xs text-ink-soft opacity-70">{copy.claim.errDetail(failure.detail)}</p>
          )}
        </div>
      )}
    </div>
  );
}
