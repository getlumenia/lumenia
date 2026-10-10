"use client";

/**
 * /start: the one way into Lumenia.
 *
 * The brief, kept literally: show as little as possible and still let the whole brand come through.
 * The first screen is the landing's greeting and one button, and every screen after it asks one
 * thing, with the messenger at each beat:
 *
 *   hello    "Hey, I've got a message for you."  [Get started]
 *   ask      "Do you already have a Lumenia account?"  [No, I'm new here] [Yes, bring it here]
 *   new      "You're in."  (shown only after the account is really open)
 *   restore  the existing restore, unchanged: Face ID where this device has it, else email, a code
 *            and the password. The same components, the same calls, as the no-account /account page.
 *
 * WHERE YOU ARE LIVES IN THE URL (?step=...), written with the native history API. Next mirrors
 * those calls into useSearchParams without asking the server for anything, and the browser's back
 * button walks the steps like pages. Every entry this page pushes carries how deep into the flow it
 * is. That is what lets the Back link pop history instead of stacking more of it, and lets leaving
 * for /home rewind the flow first, so Back on /home does not land on a step that would only bounce.
 *
 * AN ACCOUNT ON THIS DEVICE ENDS THE FLOW. If there is one when the page opens, this page is not
 * for them and they go straight to /home. That check reads the keystore's first answer only: an
 * account that appears BECAUSE of this page (opened or brought back here) gets its closing beat.
 * Going back to hello or the question with an account in hand also goes home, so the question can
 * never be answered twice and open a second account.
 *
 * ONE EXCEPTION: ?step=restore with an account already here is "bring ANOTHER account here" (the
 * approval email's "Bring it here", /activate's "Bring my money back"). It used to bounce to /home,
 * so the only way to bring a second account in was to remove the first. It renders the add flow
 * instead (RecoveryFlow mode "add"): the account in use stays, and nothing switches until the
 * person chooses "Use it now".
 *
 * NOTHING HAPPENS ON ARRIVAL. Link previews and crawlers open URLs too, and every new account parks
 * a reserve with the sponsor. The tap on "No, I'm new here" is the gesture; ?step=new opened cold,
 * with no account behind it, falls back to the question.
 *
 * REAL MONEY GOES TO /welcome. A device switched to real money cannot open an account without a
 * pilot invite, and /welcome is where that is explained and asked for (the same hand-off /send
 * makes). Everything opened here is on practice money, and the closing beat says so.
 *
 * AFTER "YOU'RE IN", /home. /send records why /welcome was taken off the main path (nothing about
 * setting up may come before the money), and /home's WelcomeNudge offers the @name from there.
 */
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useWallet } from "../../../lib/wallet";
import { activeNetwork } from "../../../lib/network";
import { isPlatformAuthenticatorAvailable } from "../../../lib/passkey-prf";
import { Mascot, mascotSrc } from "../../../components/brand/Mascot";
import { LumenField } from "../../../components/brand/LumenField";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";
import { FindWithFaceId } from "../../../components/brand/FindWithFaceId";
import { RecoveryFlow } from "../../../components/brand/RecoveryFlow";
import { backupRecord } from "../../../lib/backup-record";
import { maskEmail, shortAddress } from "../../../lib/account-label";
import "./start.css";

type Step = "hello" | "ask" | "new" | "restore";
type HeadingRef = RefObject<HTMLHeadingElement | null>;

const STEPS: readonly Step[] = ["hello", "ask", "new", "restore"];

/** Where Back leads from each step, for someone who arrived mid-flow with no history to pop. */
const PARENT: Record<Step, Step | null> = { hello: null, ask: "hello", new: "ask", restore: "ask" };

/** The key each entry this page pushes carries: how many steps past the arrival entry it is. */
const DEPTH = "lumeniaStartDepth";

const toStep = (raw: string | null): Step => STEPS.find((s) => s === raw) ?? "hello";
const urlFor = (step: Step) => (step === "hello" ? "/start" : `/start?step=${step}`);

function depthHere(): number {
  const d = (window.history.state as Record<string, unknown> | null)?.[DEPTH];
  return typeof d === "number" && d > 0 ? d : 0;
}

/** Opening an account fails for connection reasons almost every time. Say that, never the raw error. */
function createErrorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : "";
  // The one refusal that is about this phone, not the connection, and it is already plain words.
  if (/accounts on this phone/i.test(message)) return message;
  return "We couldn't open your account just now. Check your connection and try again.";
}

export default function StartPage() {
  // useSearchParams needs a Suspense boundary. Its fallback is the first beat without its button,
  // so even a static render of this page opens on the greeting.
  return (
    <Suspense
      fallback={
        <Frame step="hello">
          <HelloBeat />
        </Frame>
      }
    >
      <FirstRun />
    </Suspense>
  );
}

function FirstRun() {
  const router = useRouter();
  const urlStep = toStep(useSearchParams().get("step"));
  const { status, account, createAccount } = useWallet();

  /** A step chosen this instant, shown before the router reports the new URL a frame later. */
  const [pending, setPending] = useState<Step | null>(null);
  /** The beat kept on screen while the flow rewinds its history on the way to /home. */
  const [leaving, setLeaving] = useState<Step | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [faceFound, setFaceFound] = useState(false);
  const [restored, setRestored] = useState(false);
  const [faceCapable, setFaceCapable] = useState(false);
  /** An account was already here when ?step=restore opened: this is the add flow, not a restore. */
  const [adding, setAdding] = useState(false);

  const step: Step = leaving ?? pending ?? urlStep;
  const beat = step === "restore" && restored ? "restored" : step;

  // Whatever the URL says now is the truth again, including after the browser's own back button.
  useEffect(() => setPending(null), [urlStep]);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const go = useCallback((next: Step) => {
    setPending(next);
    window.history.pushState({ [DEPTH]: depthHere() + 1 }, "", urlFor(next));
  }, []);

  const replaceWith = useCallback((next: Step) => {
    setPending(next);
    window.history.replaceState({ [DEPTH]: depthHere() }, "", urlFor(next));
  }, []);

  const back = useCallback(() => {
    const parent = PARENT[step];
    if (!parent) return;
    if (depthHere() > 0) window.history.back();
    else replaceWith(parent);
  }, [step, replaceWith]);

  /**
   * Out of the flow, to the money. With history behind us, rewind to the entry the visitor arrived
   * on first and replace THAT with /home, so the steps are gone from Back rather than waiting there
   * to bounce. The current beat stays on screen meanwhile instead of flashing the greeting.
   */
  const leaveForHome = useCallback(() => {
    setLeaving(step);
    const d = depthHere();
    if (d === 0) {
      router.replace("/home");
      return;
    }
    const onPop = () => {
      window.removeEventListener("popstate", onPop);
      // A tick later, so Next has applied its own restore of this entry before we replace it.
      window.setTimeout(() => router.replace("/home"), 0);
    };
    window.addEventListener("popstate", onPop);
    window.history.go(-d);
  }, [router, step]);

  /** The keystore's first answer decides whether this page is for them at all. */
  const answered = useRef(false);
  useEffect(() => {
    if (status !== "ready") return;
    if (!answered.current) {
      answered.current = true;
      if (account && urlStep === "restore") {
        setAdding(true);
        return;
      }
      if (account) {
        router.replace("/home");
        return;
      }
    }
    if (leaving || creating || adding) return;
    if (account && (step === "hello" || step === "ask")) router.replace("/home");
    else if (!account && step === "new") replaceWith("ask");
  }, [status, account, step, urlStep, leaving, creating, adding, router, replaceWith]);

  // Face ID is offered only where this device has a platform authenticator; the copy follows suit.
  useEffect(() => {
    let live = true;
    void isPlatformAuthenticatorAvailable().then((ok) => {
      if (live) setFaceCapable(ok);
    });
    return () => {
      live = false;
    };
  }, []);

  // The later beats' characters, fetched while the first is being read, so no step draws late.
  useEffect(() => {
    for (const pose of ["wave", "celebrate", "phone", "thumbsup"] as const) {
      const img = new Image();
      img.src = mascotSrc(pose);
    }
  }, []);

  const startNew = useCallback(async () => {
    if (creating) return;
    // Real money is invite-only, and /welcome is the screen that explains it and asks.
    if (activeNetwork().isMainnet) {
      router.push("/welcome?start=1");
      return;
    }
    setCreateError(null);
    setCreating(true);
    try {
      await createAccount();
      if (alive.current) go("new");
    } catch (e) {
      if (alive.current) setCreateError(createErrorMessage(e));
    } finally {
      if (alive.current) setCreating(false);
    }
  }, [creating, createAccount, go, router]);

  /* Back is offered only where there is somewhere sensible to go back to: never while an account is
     being opened, and never once one exists, because the question behind it is answered. */
  const canGoBack = (step === "ask" && !creating) || (step === "restore" && !account);

  useEffect(() => {
    if (!canGoBack) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canGoBack, back]);

  // A new beat moves focus to its heading, so a screen reader announces it and Tab starts there.
  const heading = useRef<HTMLHeadingElement>(null);
  const shownBeat = useRef(beat);
  useEffect(() => {
    if (shownBeat.current === beat) return;
    shownBeat.current = beat;
    heading.current?.focus();
  }, [beat]);

  return (
    <Frame step={step} beat={beat} onBack={canGoBack ? back : undefined}>
      {step === "hello" && (
        <HelloBeat heading={heading} onStart={status === "ready" && !account ? () => go("ask") : undefined} />
      )}
      {(step === "ask" || (step === "new" && !account)) && (
        <AskBeat
          heading={heading}
          ready={status === "ready"}
          busy={creating}
          error={createError}
          onNew={startNew}
          onRestore={() => go("restore")}
        />
      )}
      {step === "new" && account && <InBeat heading={heading} onContinue={leaveForHome} />}
      {step === "restore" && adding && <AddBeat heading={heading} onDone={leaveForHome} />}
      {step === "restore" && !adding && (
        <RestoreBeat
          heading={heading}
          faceCapable={faceCapable}
          found={faceFound}
          restored={restored}
          locked={account?.phase === 2}
          address={account?.address ?? null}
          onFound={() => setFaceFound(true)}
          onDone={() => setRestored(true)}
          onContinue={leaveForHome}
        />
      )}
    </Frame>
  );
}

/** The page around every beat: the wordmark, Back where it applies, the light behind. */
function Frame({
  step,
  beat,
  onBack,
  children,
}: {
  step: Step;
  beat?: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  const shown = beat ?? step;
  // The drifting lights belong to the greeting and to the two arrivals, not to the questions.
  const lights = shown === "hello" || shown === "new" || shown === "restored";
  return (
    <div className="fr" data-step={step}>
      <div className="fr-glow" aria-hidden="true" />
      {lights && <LumenField className="fr-field" />}
      <header className="fr-top">
        {onBack && (
          <button type="button" className="fr-back" onClick={onBack}>
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back
          </button>
        )}
        <Link href="/" className="fr-brand" aria-label="Lumenia home">
          {/* Wordmark swaps per theme (its paper-filled counters only read on light). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand-kit-assets/logo-wordmark-t.svg" alt="" className="site-wordmark-light" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand-kit-assets/logo-wordmark-dark.svg" alt="" className="site-wordmark-dark" />
        </Link>
      </header>
      <main key={shown} className="fr-main">
        {children}
      </main>
    </div>
  );
}

/** a. The greeting from the landing, and one button. */
function HelloBeat({ heading, onStart }: { heading?: HeadingRef; onStart?: () => void }) {
  return (
    <>
      <div className="fr-hello">
        <div className="fr-bubble">
          <div className="fr-bubble-top" aria-hidden="true">
            <span className="fr-bubble-mark">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand-kit-assets/mark-link.webp" alt="" width={18} height={18} />
            </span>
            <span className="fr-bubble-time">now</span>
          </div>
          <h1 ref={heading} tabIndex={-1} className="fr-bubble-text">
            Hey, I&apos;ve got a message for you.
          </h1>
          <span className="fr-bubble-tail" aria-hidden="true" />
        </div>
        <Mascot pose="messenger" size="hero" priority alt="The Lumenia messenger, holding a glowing envelope" />
      </div>
      {/* Held back (space kept) until the keystore has answered: someone who already has an account
          is on their way to /home and should not be offered a start they do not need. */}
      <div className="fr-actions" data-ready={onStart ? "true" : "false"}>
        <PrimaryButton onClick={onStart} disabled={!onStart}>
          Get started
        </PrimaryButton>
      </div>
    </>
  );
}

/** b. The one question. */
function AskBeat({
  heading,
  ready,
  busy,
  error,
  onNew,
  onRestore,
}: {
  heading: HeadingRef;
  ready: boolean;
  busy: boolean;
  error: string | null;
  onNew: () => void;
  onRestore: () => void;
}) {
  return (
    <>
      <Mascot pose="wave" size="lg" />
      <h1 ref={heading} tabIndex={-1} className="fr-title">
        Do you already have a Lumenia account?
      </h1>
      <div className="fr-actions">
        <PrimaryButton loading={busy} loadingLabel="Opening your account..." disabled={!ready} onClick={onNew}>
          No, I&apos;m new here
        </PrimaryButton>
        <button type="button" className="fr-btn-quiet" disabled={busy || !ready} onClick={onRestore}>
          Yes, bring it here
        </button>
        {error && (
          <p className="fr-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </>
  );
}

/** c. The arrival. Reached only once the account exists. */
function InBeat({ heading, onContinue }: { heading: HeadingRef; onContinue: () => void }) {
  return (
    <>
      <Mascot pose="celebrate" size="lg" enter="pop" />
      <h1 ref={heading} tabIndex={-1} className="fr-title">
        You&apos;re in.
      </h1>
      <p className="fr-lead">
        Your account lives on this phone. It starts with practice money, so you can try everything
        for free.
      </p>
      <div className="fr-actions">
        <PrimaryButton onClick={onContinue}>See my money</PrimaryButton>
      </div>
    </>
  );
}

/** d. Bringing an account here: the existing restore components, framed by the phone pose. */
function RestoreBeat({
  heading,
  faceCapable,
  found,
  restored,
  locked,
  address,
  onFound,
  onDone,
  onContinue,
}: {
  heading: HeadingRef;
  faceCapable: boolean;
  /** Face ID found the account; its own card now carries the lock step, so email steps aside. */
  found: boolean;
  restored: boolean;
  /** Read from the account itself, not assumed: the closing line asserts a safety property. */
  locked: boolean;
  /** The account that came back, named the way every surface names it. */
  address: string | null;
  onFound: () => void;
  onDone: () => void;
  onContinue: () => void;
}) {
  if (restored) {
    return (
      <>
        <Mascot pose="thumbsup" size="lg" enter="pop" />
        <h1 ref={heading} tabIndex={-1} className="fr-title">
          Your money is back.
        </h1>
        {/* Which account came back, in the restore's own words (contract 5.5). */}
        {address && (
          <p className="fr-lead">
            {backupRecord(address)?.email
              ? `This is ${shortAddress(address)}, backed up with ${maskEmail(backupRecord(address)!.email!)}.`
              : `This is ${shortAddress(address)}.`}
          </p>
        )}
        <p className="fr-lead">
          {locked
            ? "Only your password can spend it on this phone."
            : "It isn't locked yet, so anyone holding this phone could spend it. You can lock it any time from your Account."}
        </p>
        <div className="fr-actions">
          <PrimaryButton onClick={onContinue}>See my money</PrimaryButton>
        </div>
      </>
    );
  }
  return (
    <>
      <Mascot pose="phone" size="md" />
      <h1 ref={heading} tabIndex={-1} className="fr-title">
        Welcome back.
      </h1>
      <p className="fr-lead">
        {faceCapable
          ? "Bring your account here with Face ID, or with the email you backed it up with."
          : "Bring your account here with the email you backed it up with."}
      </p>
      <div className="fr-restore">
        <FindWithFaceId onFound={onFound} onDone={onDone} />
        {!found && (
          <MoneyCard className="p-5">
            <p className="font-semibold text-ink">With your email</p>
            <p className="mb-3 mt-1 text-sm text-pretty text-ink-soft">
              We&apos;ll send you a code, then your password opens it.
            </p>
            <RecoveryFlow mode="restore" onDone={onDone} />
          </MoneyCard>
        )}
      </div>
    </>
  );
}

/** e. Bringing ANOTHER account here, beside the one in use (W4). Nothing is removed or switched. */
function AddBeat({ heading, onDone }: { heading: HeadingRef; onDone: () => void }) {
  return (
    <>
      <Mascot pose="phone" size="md" />
      <h1 ref={heading} tabIndex={-1} className="fr-title">
        Bring another account here.
      </h1>
      <p className="fr-lead">
        The account on this phone stays. Bring another one in with the email you backed it up with.
      </p>
      <div className="fr-restore">
        <MoneyCard className="p-5">
          <p className="font-semibold text-ink">With its email</p>
          <p className="mb-3 mt-1 text-sm text-pretty text-ink-soft">
            We&apos;ll send you a code, then its password opens it.
          </p>
          <RecoveryFlow mode="add" onDone={onDone} />
        </MoneyCard>
      </div>
    </>
  );
}
