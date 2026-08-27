"use client";

/**
 * /welcome — the first minute (docs/IDENTITY_AND_ACCOUNTS.md §3, §6).
 *
 * WHAT THIS IS NOT: a gate. Nothing in Lumenia waits behind it. The product's whole promise is that
 * a recipient does nothing — tap a link, the money is theirs — so onboarding may never stand
 * between a person and their money. This screen is only ever reached AFTER an account exists, and
 * every step of it can be skipped in one tap.
 *
 * THREE BEATS, ONE QUESTION. Hello · pick your name · you're set. Only the middle beat asks for
 * anything, and it asks in the cheapest possible form: three names that are already known to be
 * free, tappable. A blank field is the slowest question in any sign-up; a choice takes a second.
 * Typing your own is there for the people who came with a name in mind, not as the default path.
 *
 * The messenger appears at each beat because these are the three emotional moments of the first
 * minute (brand.md §9: use the character AT a beat, never as decoration).
 *
 * HONEST AT THE POINT OF DECISION. The one real cost of a name — it publishes a permanent link
 * between a word and this account's whole record — is stated on the step where the name is chosen,
 * not buried afterwards. Skipping is offered in the same size and weight as continuing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, RefreshCw } from "lucide-react";
import { useWallet } from "../../../lib/wallet";
import { checkHandle, claimHandle, handleOf, federationAddress } from "../../../lib/handles";
import { suggestAvailable } from "../../../lib/handle-suggest";
import { hasBackup } from "../../../lib/recovery-api";
import { markWelcomeSeen } from "../../../lib/welcome";
import { MAINNET_CONFIGURED } from "../../../lib/network";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { JoinPilotDialog } from "../../../components/brand/JoinPilotDialog";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";

type Step = "hello" | "name" | "done";

const MASCOT: Record<Step, { src: string; width: number; height: number }> = {
  hello: { src: "/brand-kit-assets/mascot-wave-cut.webp", width: 184, height: 204 },
  name: { src: "/brand-kit-assets/mascot-messenger-cut.webp", width: 184, height: 204 },
  done: { src: "/brand-kit-assets/mascot-celebrate-cut.webp", width: 184, height: 204 },
};

function Mascot({ step }: { step: Step }) {
  const m = MASCOT[step];
  return (
    <div className="ob-mascot-wrap" aria-hidden="true">
      <span className="ob-mascot-glow" />
      <Image className="ob-mascot" src={m.src} alt="" width={m.width} height={m.height} priority />
    </div>
  );
}

function Dots({ step }: { step: Step }) {
  const order: Step[] = ["hello", "name", "done"];
  return (
    <div className="ob-dots" role="presentation">
      {order.map((s) => (
        <span key={s} className="ob-dot" data-on={s === step} />
      ))}
    </div>
  );
}

export default function WelcomePage() {
  const router = useRouter();
  const { status, account, getSigner, createAccount, network, mainnetApproved, switchNetwork } = useWallet();
  const [step, setStep] = useState<Step>("hello");
  const [name, setName] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [chosen, setChosen] = useState("");
  const [typed, setTyped] = useState("");
  const [typedState, setTypedState] = useState<"idle" | "checking" | "free" | "no">("idle");
  const [typedReason, setTypedReason] = useState<string | null>(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [askPilot, setAskPilot] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Somebody who already has a name should never be asked to pick one. Read it once, and if there
   * is one, this becomes a two-beat screen that ends on their name.
   */
  useEffect(() => {
    if (!account) return;
    let live = true;
    void handleOf(account.address)
      .then((n) => {
        if (live && n) setName(n);
      })
      .catch(() => {
        /* the registry being unreachable is not a reason to block a welcome screen */
      });
    return () => {
      live = false;
    };
  }, [account]);

  const refreshSuggestions = useCallback(async () => {
    setLoadingSuggestions(true);
    try {
      const { names } = await suggestAvailable(3);
      setSuggestions(names);
      // The first one is pre-selected so the step is genuinely one tap. Nothing is hidden by that:
      // the primary button spells out the exact name it will take, and the other two are one tap
      // away. An unselected list would make the fastest path "read three names, tap one, tap the
      // button" — three decisions for a question most people do not care much about.
      setChosen(names[0] ?? "");
    } finally {
      setLoadingSuggestions(false);
    }
  }, []);

  // Fetched when the name step opens, not on mount: someone who skips at "hello" should never have
  // caused three availability lookups.
  useEffect(() => {
    if (step === "name" && suggestions.length === 0) void refreshSuggestions();
  }, [step, suggestions.length, refreshSuggestions]);

  /** Availability for a typed name, debounced, latest-wins. */
  useEffect(() => {
    const candidate = typed.trim().toLowerCase().replace(/^@+/, "");
    if (candidate.length < 3) {
      setTypedState("idle");
      setTypedReason(null);
      return;
    }
    let live = true;
    setTypedState("checking");
    const t = setTimeout(() => {
      void checkHandle(candidate)
        .then((r) => {
          if (!live) return;
          setTypedState(r.available ? "free" : "no");
          setTypedReason(r.available ? null : (r.reason ?? "Someone already has that."));
        })
        .catch(() => live && setTypedState("idle"));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [typed]);

  const target = typed.trim() ? typed.trim().toLowerCase().replace(/^@+/, "") : chosen;
  const canTake = Boolean(target) && (typed.trim() ? typedState === "free" : true);

  const take = useCallback(async () => {
    if (!account || !target) return;
    setBusy(true);
    setError(null);
    try {
      const signer = await getSigner();
      const claimed = await claimHandle(signer, target);
      setName(claimed.name);
      markWelcomeSeen();
      setStep("done");
    } catch (e) {
      const message = (e as Error).message;
      setError(
        message === "locked"
          ? "Unlock your money first, then pick your name — or skip and do it later."
          : message,
      );
      // A name that was taken in the seconds since we checked should not leave a dead screen.
      if (/taken|close to one/i.test(message)) void refreshSuggestions();
    } finally {
      setBusy(false);
    }
  }, [account, target, getSigner, refreshSuggestions]);

  /**
   * Open a brand-new account from here. It lands at Phase 1 (a device key, no password), which is
   * the same place a Face-ID restore lands, and the "Back up my money" step at the end of this flow
   * is what turns that into something that survives losing the phone.
   */
  const createAccountHere = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await createAccount();
      setStep("name"); // an account with no name is exactly what the next beat is for
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [createAccount]);

  /**
   * "Get started" MEANS "open me an account", so pressing it should not land on a screen that asks
   * the same question again. The intent travels with the navigation (`?start=1`) and is acted on
   * here.
   *
   * WHY AN INTENT PARAM AND NOT SIMPLY "no account → create one". Because this screen is a URL, and
   * a URL is opened by crawlers, link previews, and anybody who bookmarks it. Creating an account
   * on arrival would hand the sponsor a reserve to park for every one of those. The click is the
   * gesture; carrying it across the navigation is what makes a second confirmation unnecessary.
   *
   * Guarded by a ref rather than by state: this must fire exactly once even if the effect is
   * re-entered, because the thing it does is not free.
   */
  const autoStarted = useRef(false);
  useEffect(() => {
    if (status !== "ready" || account || autoStarted.current) return;
    const wants = new URLSearchParams(window.location.search).get("start") === "1";
    if (!wants) return;
    // Never on real money without an invite — the same gate the button itself carries.
    if (network === "public" && !mainnetApproved) return;
    autoStarted.current = true;
    void createAccountHere();
    // The param has done its job; leaving it would re-arm this on a reload after a failure.
    window.history.replaceState({}, "", "/welcome");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, account, network, mainnetApproved]);

  /**
   * Skipping goes HOME, not to a third screen.
   *
   * "You're all set" is a lovely sentence and it cost a tap: somebody who had just declined to pick
   * a name was shown a page whose only content was congratulating them on declining, with a button
   * to finally reach their money. The confirmation people actually want after skipping is their
   * balance, so that is what they get. Taking a name still ends on the done beat, because there
   * the screen has something to show: the name, and the address it resolves as.
   */
  const skip = useCallback(() => {
    markWelcomeSeen();
    router.push("/home");
  }, [router]);

  const finish = useCallback(() => {
    markWelcomeSeen();
    router.push("/home");
  }, [router]);

  if (status === "loading") {
    return <p className="py-10 text-center text-ink-soft">One moment…</p>;
  }

  /**
   * NO ACCOUNT YET — and this is where one gets made.
   *
   * This screen used to say "there is no account on this phone" and point at a checklist whose own
   * first step said to wait for somebody to send you money. That is a closed loop: the only way in
   * was to be sent a link, so a person who simply wanted to try the product had nowhere to go. An
   * account is a keypair and a sponsored, zero-XLM ledger entry — there is no reason it cannot be
   * made right here, and now that it can be, this is the first beat rather than a dead end.
   *
   * Nobody's real money is involved: a device with no account is on practice money by definition
   * (real money is gated on a pilot approval that is granted to an account, which does not exist
   * yet), and the copy says exactly that rather than implying otherwise.
   */
  if (!account) {
    /**
     * THE MONEY CHOICE IS A CHOICE, and it stays one.
     *
     * This screen first shipped with a single "Switch to practice money" button, which is a
     * one-way door: press it and the option disappears, so the only way to see where you are — or
     * to go back — is to find the switch on another page. Two options, always both on screen, with
     * the current one marked, answers "which money is this account for?" every time the screen is
     * opened rather than only the first time.
     *
     * REAL MONEY IS STILL GATED. /settings gates creating an account on the pilot allowlist,
     * because on mainnet every new account parks a reserve the sponsor never gets back, and this
     * screen went in without that gate. Choosing real money without an invite is allowed to be
     * SAID — the option is visible, and tapping it explains itself in a toast — but it cannot
     * create anything.
     *
     * Where mainnet is not configured at all there is nothing to choose between, and a dead switch
     * is worse than no switch: the choice is simply not drawn.
     */
    const onReal = network === "public";
    const canCreate = !onReal || mainnetApproved;
    return (
      <div className="flex flex-col gap-5 py-6">
        <Mascot step="hello" />
        <header className="text-center">
          <h1 className="text-2xl font-bold text-ink">
            {busy ? "Opening your account…" : "Let’s get you an account."}
          </h1>
          <p className="mx-auto mt-2 max-w-xs text-sm text-ink-soft">
            {busy
              ? "A few seconds. We’re putting it on the public record so money can reach you."
              : "It takes a few seconds and there is nothing to sign up for — no app, no seed phrase."}
          </p>
        </header>

        {MAINNET_CONFIGURED && (
          <MoneyCard className="p-4">
            <p className="mb-2 text-sm font-semibold text-ink">Which money?</p>
            <div className="app-choice">
              <button
                type="button"
                className="app-choice-opt"
                data-on={!onReal}
                aria-pressed={!onReal}
                onClick={() => onReal && switchNetwork("testnet")}
              >
                <span className="app-choice-t">Practice money</span>
                <span className="app-choice-s">Costs nothing. Everything works the same.</span>
              </button>
              <button
                type="button"
                className="app-choice-opt"
                data-on={onReal}
                aria-pressed={onReal}
                onClick={() => (mainnetApproved ? !onReal && switchNetwork("public") : setAskPilot(true))}
              >
                <span className="app-choice-t">Real money</span>
                <span className="app-choice-s">
                  {mainnetApproved ? "You're on the pilot list." : "Invite-only for now."}
                </span>
              </button>
            </div>
          </MoneyCard>
        )}

        <div className="flex flex-col gap-2">
          <PrimaryButton
            loading={busy}
            loadingLabel="Opening your account…"
            disabled={!canCreate}
            onClick={createAccountHere}
          >
            Create my account
          </PrimaryButton>
          {!canCreate && (
            <p className="text-center text-xs text-ink-soft">
              New accounts on real money are opened for people on the pilot list.{" "}
              <button type="button" onClick={() => setAskPilot(true)} className="text-money underline underline-offset-2">
                Ask to join
              </button>
              , or pick practice money above and start right now.
            </p>
          )}
          <Link
            href="/how-it-works"
            className="flex h-12 items-center justify-center rounded-full text-sm font-medium text-ink-soft"
          >
            First, how does this work?
          </Link>
        </div>
        {error && <p className="text-center text-sm text-danger">{error}</p>}
        {/* Tapping "Real money" without an invite used to end in a refusal and nothing else, which
            is a door with no handle. This is the handle — and it does not become a shortcut around
            the pilot's own preconditions (see JoinPilotDialog). */}
        <JoinPilotDialog open={askPilot} onClose={() => setAskPilot(false)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-6">
      <Dots step={step} />
      <Mascot step={step} />

      {step === "hello" && (
        <>
          <header className="text-center">
            <h1 className="text-2xl font-bold text-ink">You&apos;re in.</h1>
            <p className="mx-auto mt-2 max-w-xs text-sm text-ink-soft">
              Your account lives on this phone. No app to install, no seed phrase to keep somewhere
              safe, and nothing to sign up for.
            </p>
          </header>
          <div className="flex flex-col gap-2">
            <PrimaryButton onClick={() => setStep(name ? "done" : "name")}>
              {name ? "See how it looks" : "Pick my name"}
            </PrimaryButton>
            <button
              type="button"
              onClick={finish}
              className="h-12 rounded-full text-sm font-medium text-ink-soft"
            >
              Skip for now
            </button>
          </div>
        </>
      )}

      {step === "name" && (
        <>
          <header className="text-center">
            <h1 className="text-2xl font-bold text-ink">Pick your name</h1>
            <p className="mx-auto mt-2 max-w-xs text-sm text-ink-soft">
              People can pay you at <span className="text-ink">@yourname</span> instead of a long
              address.
            </p>
          </header>

          <MoneyCard className="p-5">
            {/* The fast path: three names already known to be free. Tap one and you are done. */}
            <div className="flex flex-wrap gap-2">
              {loadingSuggestions && suggestions.length === 0 ? (
                <p className="text-sm text-ink-soft">Finding names that are free…</p>
              ) : (
                suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="ob-chip"
                    data-on={chosen === s && !typed.trim()}
                    onClick={() => {
                      setChosen(s);
                      setTyped("");
                      setError(null);
                    }}
                  >
                    @{s}
                  </button>
                ))
              )}
            </div>

            {/* Deliberately a quiet text control, not a fourth chip: as a chip it wrapped onto its
                own line and read as a nameless fourth option. */}
            <button
              type="button"
              onClick={() => void refreshSuggestions()}
              disabled={loadingSuggestions}
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft disabled:opacity-40"
            >
              <RefreshCw className={`size-3.5 ${loadingSuggestions ? "animate-spin" : ""}`} />
              Show me others
            </button>

            {/* The slower path, for someone who arrived with a name in mind. */}
            <details className="group mt-4 border-t border-line pt-4">
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
                Or type your own
                <ChevronDown className="size-4 text-ink-soft transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-2 flex items-center gap-2 rounded-[14px] border border-line bg-surface px-3">
                <span className="text-ink-soft">@</span>
                <input
                  value={typed}
                  onChange={(e) => {
                    setTyped(e.target.value);
                    setError(null);
                  }}
                  placeholder="yourname"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="h-12 flex-1 bg-transparent text-ink outline-none"
                />
              </div>
              <p className="mt-2 min-h-5 text-sm">
                {typedState === "checking" && <span className="text-ink-soft">Checking…</span>}
                {typedState === "free" && <span className="text-money">That one is free.</span>}
                {typedState === "no" && <span className="text-ink-soft">{typedReason}</span>}
              </p>
            </details>

          </MoneyCard>

          {/* The real cost, on the screen where the decision is made — and OUTSIDE the card, so it
              reads as a note about taking a name rather than a note about the text field it would
              otherwise sit under. */}
          <p className="-mt-2 px-1 text-center text-xs text-ink-soft">
            A name is public: it links this account&apos;s record to that word for anyone who looks.
            You can give it up later.
          </p>

          <div className="flex flex-col gap-2">
            <PrimaryButton disabled={!canTake || busy} onClick={take}>
              {busy ? "Taking it…" : target ? `Take @${target}` : "Pick one above"}
            </PrimaryButton>
            <button
              type="button"
              onClick={skip}
              className="h-12 rounded-full text-sm font-medium text-ink-soft"
            >
              Skip for now
            </button>
          </div>

          {error && (
            <p className="text-center text-sm text-danger">
              {error}{" "}
              {error.toLowerCase().includes("unlock") && (
                <Link href="/unlock" className="underline underline-offset-2">
                  Unlock
                </Link>
              )}
            </p>
          )}
        </>
      )}

      {step === "done" && (
        <>
          <header className="text-center">
            <h1 className="text-2xl font-bold text-ink">{name ? `You're @${name}.` : "You're all set."}</h1>
            <p className="mx-auto mt-2 max-w-xs text-sm text-ink-soft">
              {name
                ? "Anyone can pay you at that name — in Lumenia, or from another Stellar wallet."
                : "You can pick a name any time in Settings. Nothing here needs one."}
            </p>
          </header>

          {name && (
            <MoneyCard className="p-4 text-center">
              <p className="break-all font-mono text-xs text-ink-soft">{federationAddress(name)}</p>
              <p className="mt-1 text-xs text-ink-soft">Your name, as other wallets write it.</p>
            </MoneyCard>
          )}

          <div className="flex flex-col gap-2">
            <PrimaryButton onClick={finish}>See my money</PrimaryButton>
            {/* The one thing genuinely worth doing next, offered once, without a scare. */}
            {!hasBackup(account.address) && (
              <Link
                href="/account"
                onClick={markWelcomeSeen}
                className="flex h-12 items-center justify-center rounded-full text-sm font-medium text-ink-soft"
              >
                Back up my money first
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}
