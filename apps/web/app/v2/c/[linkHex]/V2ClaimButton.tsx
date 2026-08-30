"use client";

/**
 * The v2 claim action. Reads the link's #fragment, strips it from the URL immediately, and on tap
 * runs the walletless/gasless v2 claim: a fresh sponsored account is created for the recipient and
 * the drop is paid straight into it via the /v2-claim relayer. The claimed account is persisted
 * locally (Phase 1) so /home shows it. No wallet, no gas.
 *
 * Two kinds of link arrive here (see lib/claim-password.ts):
 *   - a plain bearer link — the fragment IS the key, and this is one tap, unchanged.
 *   - a password-locked link — the fragment is only half the key. The other half is the password
 *     the sender shared some other way, and the key is derived from both, on this device. A wrong
 *     password fails here, locally, against the link id in the URL: nothing is sent, nothing leaks,
 *     and no wrong guess ever reaches the escrow.
 *
 * Every tap that reaches the relayer mints a fresh sponsored account and trustline, so a tap that
 * cannot succeed is not free. The escrow's own answer decides what this screen says and whether a
 * retry button exists at all: a drop that has already been claimed, expired or was never there is
 * a final answer, not a failure to try again.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  claimV2ToSponsoredAccount,
  isTerminalClaimOutcome,
  type V2ClaimOutcome,
} from "../../../../lib/lumendrop";
import { parseLinkFragment, unlockLink } from "../../../../lib/claim-password";
import { classifyClaimError, type ClaimErrorInfo } from "../../../../lib/claim-error";
import { copy } from "../../../../lib/copy";
import { savePhase1 } from "../../../../lib/keystore";
import { sendEvent } from "../../../../lib/events";
import { resolveNetwork, setActiveNetwork, type NetworkConfig } from "../../../../lib/network";

const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
const explorer = (hash: string, net: NetworkConfig) =>
  `https://stellar.expert/explorer/${net.isMainnet ? "public" : "testnet"}/tx/${hash}`;

type State = "idle" | "unlocking" | "claiming" | "done" | "settled" | "error";

/** A settled drop is not a failed claim, so it gets its own words and no way to try again. */
type SettledKind = Exclude<V2ClaimOutcome["kind"], "claimed">;

function settledCopy(kind: SettledKind, sender: string): { title: string; body: string; home: boolean } {
  switch (kind) {
    case "already-claimed":
      /* Deliberately not "it's in your account". The escrow keeps ONE flag and both exits set it:
         a recipient's `claim` and the sender's post-expiry `reclaim` leave a drop in the identical
         state, and `get_drop` returns no payout address to separate them. The only thing that
         would — `reclaim` is refused before expiry, so a drop settled early can only have been
         claimed — is not carried on the claim result this screen receives. So the words name both
         outcomes and /home answers which, honestly empty if the money went back. */
      return {
        title: "This link has already been used",
        body: `This money is no longer waiting here — it was claimed, or ${sender} took it back after the link expired. If you claimed it on this phone, it's in your account.`,
        home: true,
      };
    case "expired":
      /* The group-drop answer: a share stops being claimable at expiry. A one-to-one drop has no
         such gate — it stays claimable until the sender takes it back — so it never lands here. */
      return {
        title: "This link has expired",
        body: `This one can't be claimed any more, and ${sender} can take the money back now that it's expired. Ask them to send it again.`,
        home: false,
      };
    case "no-such-drop":
      /* No escrow holds a record for this link. That covers a drop that settled and was later
         cleared AND one that was never funded at all, and nothing on chain says which — so this
         says neither. Naming a claim or a take-back here would be a history the ledger never
         reported. */
      return {
        title: "There's nothing on this link",
        body: `We can't find any money held for this link — it may already have been paid out, or this link may never have carried any. Ask ${sender} for a new one.`,
        home: false,
      };
    default:
      /* A settled answer this screen has no words for yet. Say only what every settled answer has
         in common, never the convenient guess about where the money went. */
      return {
        title: "This link isn't paying out",
        body: `Nothing can be claimed from this link. Ask ${sender} for a new one.`,
        home: false,
      };
  }
}

export default function V2ClaimButton({
  linkHex,
  sender,
}: {
  linkHex: string;
  amount: string;
  sender: string;
}) {
  const [state, setState] = useState<State>("idle");
  /* The account this claim creates, captured the instant the relayer reports it. A ref, not state:
     it is read inside the same async function that sets it, and a re-render would be pointless. */
  const claimedAccount = useRef<string | null>(null);
  const [hash, setHash] = useState("");
  const [noKey, setNoKey] = useState(false);
  /** The escrow's settled answer about this drop. Null until it gives one. */
  const [settled, setSettled] = useState<SettledKind | null>(null);
  /** Why the last attempt failed, when it failed for a reason that isn't the drop itself. */
  const [failure, setFailure] = useState<ClaimErrorInfo | null>(null);
  /** This deployment cannot serve the network this link names — no tap will change that. */
  const [unreachableNetwork, setUnreachableNetwork] = useState(false);
  const [locked, setLocked] = useState(false);
  const [password, setPassword] = useState("");
  const [wrongPassword, setWrongPassword] = useState(false);
  /** The derivation didn't run — a fact about this phone, never about the password. */
  const [unlockBroke, setUnlockBroke] = useState(false);
  // The link carries its own network (`?n=public`). The product is testnet; a handful of mainnet
  // links exist as real-money evidence, and this is what keeps one deployment able to serve both.
  const [net, setNet] = useState<NetworkConfig | null>(null);
  const secretRef = useRef("");
  const seedRef = useRef<Uint8Array | null>(null);
  /* Set the instant a tap is accepted, not on the re-render that follows it. A second tap lands
     inside the first one's `await`, where state is still whatever it was at paint — so two full
     claims used to run, each minting its own sponsored account and trustline, and whichever
     finished last painted over the other's result. */
  const inFlight = useRef(false);

  useEffect(() => {
    try {
      setNet(resolveNetwork(new URLSearchParams(window.location.search).get("n")));
    } catch {
      setUnreachableNetwork(true);
    }
    const frag = window.location.hash.slice(1);
    if (frag) {
      const parsed = parseLinkFragment(frag);
      if (parsed?.kind === "password") {
        seedRef.current = parsed.seed;
        setLocked(true);
      } else if (parsed?.kind === "key") {
        secretRef.current = parsed.secret;
      } else {
        setNoKey(true);
      }
      history.replaceState(null, "", window.location.pathname + window.location.search);
      /* The TOP of the funnel: somebody arrived holding a real key. Fired only when a key is
         actually present, so a crawler or a link preview opening this URL is not counted as a
         person about to claim — the completion rate is only honest if the denominator is. There is
         no account yet, so this one carries the link id alone. */
      void sendEvent("claim_opened", linkHex);
    } else if (!secretRef.current && !seedRef.current) {
      setNoKey(true);
    }
    // Deliberately mount-only: it reads the URL fragment, which is stripped on the first pass, so a
    // re-run would find nothing and fire nothing. `linkHex` comes from the route and cannot change
    // without a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function claimWith(secret: string) {
    setState("claiming");
    setFailure(null);
    try {
      if (!net) throw new Error("Still loading. Please tap again.");
      const outcome = await claimV2ToSponsoredAccount({
        linkSecret: secret,
        sponsorUrl: net.isMainnet ? net.sponsorUrl : SPONSOR_URL,
        net,
        /* Save the key the MOMENT the account exists, before the money is sent to it. If the claim
           then fails or the connection drops, the worst case is an empty account on this phone —
           not money sitting somewhere whose only key we threw away. */
        onAccountReady: async (publicKey, seed) => {
          claimedAccount.current = publicKey;
          try {
            await savePhase1(publicKey, seed);
          } catch {
            /* storage blocked (private mode, a locked-down webview). Not fatal, and NOT a reason to
               tell someone their claim failed — the money still moves and the receipt still shows
               the address. */
          } finally {
            seed.fill(0);
          }
        },
      });

      if (outcome.kind !== "claimed") {
        if (!isTerminalClaimOutcome(outcome)) {
          /* An answer this screen has no words for. "Try again" is the only honest advice left, and
             it is safe: nothing was created, because the escrow was asked first. */
          setFailure({ kind: "unknown", detail: outcome.kind, retryable: true });
          setState("error");
          return;
        }
        /* The drop is spent, gone or past its window — and the escrow said so BEFORE anything was
           minted for it. No `claim_failed` beacon: this is a settled drop, not a claim that failed,
           and counting a second look at money already taken as a failure would understate the very
           funnel this route was instrumented to measure. */
        setSettled(outcome.kind);
        setState("settled");
        return;
      }
      outcome.seed.fill(0); // the callback already stored it; don't keep a second copy around

      /* The money is on MAINNET but this device's flag still says practice, so /home would read the
         testnet ledger and greet a recipient who just received real dollars with "$0.00". The link
         is the only thing that knows which network this was, so the moment it lands is the only
         moment we can set it. */
      setActiveNetwork(net.id);

      setHash(outcome.hash);
      setState("done");
      /* THE FUNNEL'S INPUT SIDE, which this route did not have. v2 is the live money loop — every
         link /send hands out today is a v2 link — and it emitted no events at all, so "how many
         people claimed" was being answered from the v1 route almost nobody arrives on any more.
         The account goes with it: it is the id that joins a claim to whatever that person does
         next, and this is the moment it comes into existence. */
      void sendEvent("claim_succeeded", linkHex, claimedAccount.current ?? undefined);
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(30);
    } catch (e) {
      const info = classifyClaimError(e);
      // The classifier redacts bearer material; the raw error must never reach a console on this
      // route, because the link secret is one string substitution away from anything built here.
      console.warn("[v2-claim] failed:", info.kind, "—", info.detail);
      if (info.kind === "already-claimed") {
        /* The escrow answered "claimable" and the relayer then found it gone — another device won
           the race between the two. Same settled answer, so it gets the settled screen rather than
           a failure the recipient is invited to retry. */
        setSettled("already-claimed");
        setState("settled");
        return;
      }
      setFailure(info);
      setState("error");
      void sendEvent("claim_failed", linkHex, claimedAccount.current ?? undefined);
    }
  }

  async function onClaim() {
    if (inFlight.current) return;
    const secret = secretRef.current;
    if (!secret) {
      setFailure({ kind: "link-invalid", detail: "missing key", retryable: false });
      setState("error");
      return;
    }
    inFlight.current = true;
    try {
      await claimWith(secret);
    } finally {
      inFlight.current = false;
    }
  }

  async function onUnlock() {
    if (inFlight.current) return;
    const seed = seedRef.current;
    if (!seed || !password) return;
    setWrongPassword(false);
    setUnlockBroke(false);
    setState("unlocking");
    inFlight.current = true;
    try {
      // Deriving the key is deliberately slow (memory-hard) — that slowness IS the
      // protection, since guessing happens on the guesser's own device.
      let result: Awaited<ReturnType<typeof unlockLink>>;
      try {
        result = await unlockLink(seed, password, linkHex);
      } catch (e) {
        /* 48 MiB of Argon2id WASM is the one step this screen cannot do everywhere: a memory-tight
           in-app webview — the surface most of these links are opened in — can refuse the
           allocation outright. Unhandled, the rejection left "Checking…" on screen forever, on the
           one screen that must never dead-end. Only a mismatched key is evidence about the
           password; this is evidence about the phone, and it says so. */
        console.warn("[v2-unlock] derivation failed:", (e as Error)?.name ?? "error");
        setUnlockBroke(true);
        setState("idle");
        return;
      }
      if (!result.ok) {
        setWrongPassword(true);
        setState("idle");
        return;
      }
      secretRef.current = result.secret;
      setPassword("");
      await claimWith(result.secret);
    } finally {
      inFlight.current = false;
    }
  }

  if (state === "unlocking") {
    return <p className="py-4 text-money">Checking…</p>;
  }

  if (state === "claiming") {
    return <p className="py-4 text-money">Moving your money…</p>;
  }

  if (state === "done") {
    return (
      <div className="flex w-full flex-col items-center gap-4">
        <p className="text-lg font-semibold text-money">It&apos;s yours 🎉</p>
        <a
          href={explorer(hash, net ?? resolveNetwork(undefined))}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-ink-soft underline-offset-2 hover:underline"
          data-tx-hash={hash}
        >
          See the public record ↗
        </a>
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

  if (state === "settled" && settled) {
    const said = settledCopy(settled, sender);
    return (
      <div className="flex w-full flex-col items-center gap-4">
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-lg font-semibold text-money">{said.title}</p>
          <p className="text-ink-soft">{said.body}</p>
        </div>
        {said.home && (
          <Link
            href="/home"
            prefetch={false}
            className="flex h-12 w-full items-center justify-center rounded-full bg-money text-sm font-semibold text-primary-foreground"
          >
            {/* Not "See my money": the screen above it can't promise there is any. */}
            Check my account
          </Link>
        )}
      </div>
    );
  }

  /* A failure that cannot succeed on retry gets no button. Offering one is an invitation to fail
     again, and here it is worse than cosmetic: each tap that reaches the relayer mints another
     sponsored account and trustline at the sponsor's expense. */
  const canRetry = state !== "error" || failure?.retryable !== false;

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
        // Cause unknown — and then the old wording is the honest one: the escrow was asked before
        // anything was created, so the money has not moved and trying again is reasonable.
        return copy.claim.error(sender);
    }
  })();

  return (
    <div className="flex w-full flex-col items-center gap-3">
      {unreachableNetwork ? (
        <p className="text-sm text-ink-soft">
          This link is for a network this site cannot reach right now.
        </p>
      ) : noKey ? (
        <p className="text-sm text-ink-soft">Open your original link to claim this money.</p>
      ) : !canRetry ? null : locked ? (
        <>
          <p className="text-sm text-ink-soft">
            {/* Explicit {" "}: the text block below contains an entity (&apos;), which splits it
                into fragments and drops the leading space — this shipped as "Mericput a password"
                and was caught by watching the demo film rather than by reading the code. */}
            {sender}
            {" "}put a password on this one. Ask them for it if you don&apos;t have it. They sent it
            separately, not in this link.
          </p>
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setWrongPassword(false);
              setUnlockBroke(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onUnlock();
            }}
            autoComplete="off"
            placeholder="Password"
            aria-label="Password"
            className="h-12 w-full rounded-full border border-line bg-surface px-5 text-center text-base text-ink outline-none"
          />
          {wrongPassword && (
            <p className="text-sm text-danger">That password doesn&apos;t match. Try again.</p>
          )}
          {unlockBroke && (
            <p className="text-sm text-danger">
              We couldn&apos;t check the password on this phone just now. Try again, or open this
              link in your browser.
            </p>
          )}
          <button
            onClick={onUnlock}
            disabled={!password}
            data-link={linkHex}
            className="h-14 w-full rounded-full bg-money px-8 text-base font-semibold text-primary-foreground transition-colors hover:bg-money/90 active:bg-money-pressed disabled:opacity-50"
          >
            Claim my money
          </button>
        </>
      ) : (
        <button
          onClick={onClaim}
          data-link={linkHex}
          className="h-14 w-full rounded-full bg-money px-8 text-base font-semibold text-primary-foreground transition-colors hover:bg-money/90 active:bg-money-pressed"
        >
          {state === "error" ? copy.claim.retry : "Claim my money"}
        </button>
      )}
      {state === "error" && failure && (
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-sm text-danger">{failureBody}</p>
          {/* Small, muted, and deliberately present: it is what turns "it didn't work" into a
              report we can act on. */}
          {failure.detail && (
            <p className="text-xs text-ink-soft opacity-70">{copy.claim.errDetail(failure.detail)}</p>
          )}
        </div>
      )}
    </div>
  );
}
