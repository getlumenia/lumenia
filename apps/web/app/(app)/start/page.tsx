"use client";

/**
 * /start — the guided path to becoming a SENDER.
 *
 * Lumenia's whole promise is that a RECIPIENT does nothing: tap a link, confirm with your face,
 * the money is yours. That stays. But a sender is a different person with genuinely different
 * needs — an account, a password, pilot approval, dollars, and only then a link to send — and the
 * product had every one of those pieces built while telling nobody what order they go in. Someone
 * who wanted to actually USE Lumenia landed on /account and read "when someone sends you money
 * with a link, your account is created here", which is a dead end if nobody has sent you anything.
 *
 * So this page invents no new machinery. It reads the real state of the five things that already
 * exist and shows which one is next. One step is live at a time; finished steps collapse to a
 * line; later steps stay visible but quiet, so the whole path is legible from the first screen
 * rather than revealed one surprise at a time.
 *
 * Every status here is READ, never assumed: the account comes from the keystore, the lock from its
 * phase, approval from the sponsor's allowlist, and the balance from the ledger. A checklist that
 * lies about where you are is worse than no checklist.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "../../../lib/wallet";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";
import { loadBalance } from "../../../lib/horizon";
import { MAINNET_CONFIGURED } from "../../../lib/network";

type StepState = "done" | "current" | "later";

interface Step {
  id: string;
  title: string;
  /** Shown while this step is the current one — what to do and why it matters. */
  body: string;
  /** Shown once finished, in place of the body. */
  doneNote: string;
  href: string;
  cta: string;
  state: StepState;
}

export default function StartPage() {
  const { status, account, network, pilotState, switchNetwork } = useWallet();
  const [usdc, setUsdc] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // The dollar balance is the only step we cannot answer from local state, so it is the only one
  // that touches the network. Re-read whenever the account or network changes; a stale balance
  // would park someone on "add money" after they already had.
  useEffect(() => {
    let alive = true;
    if (!account) {
      setUsdc(null);
      return;
    }
    setChecking(true);
    loadBalance(account.address)
      .then((b) => {
        if (alive) setUsdc(b?.usd ?? "0");
      })
      .catch(() => {
        if (alive) setUsdc(null);
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [account, network]);

  if (status === "loading") {
    return <p className="py-8 text-ink-soft">One moment…</p>;
  }

  const hasAccount = Boolean(account);
  const isLocked = account?.phase === 2;
  const onMainnet = network === "public";
  const isApproved = pilotState === "approved";
  const hasMoney = usdc !== null && parseFloat(usdc) > 0;

  /* The order is not cosmetic — each step is genuinely blocked by the one above it. You cannot
     lock an account you do not have; mainnet refuses to sign without the password; the sponsor
     will not let an unapproved wallet deposit; and a link cannot carry dollars you do not hold. */
  const done = [hasAccount, isLocked, onMainnet, isApproved, hasMoney];
  const firstUnfinished = done.findIndex((d) => !d);
  const stateFor = (i: number): StepState =>
    done[i] ? "done" : i === firstUnfinished ? "current" : "later";

  const steps: Step[] = [
    {
      id: "account",
      title: "Get an account",
      body:
        "Try it the way your friends will: send yourself a demo link and claim it. That claim creates your account — there is no signup form anywhere, and there never will be.",
      doneNote: "You have an account.",
      href: "/try",
      cta: "Send myself a demo link",
      state: stateFor(0),
    },
    {
      id: "lock",
      title: "Lock it with a password",
      body:
        "Real money never sits on an unlocked phone here. Your password also becomes your backup, so a new phone can bring your money back with your email.",
      doneNote: "Locked, and backed up.",
      href: "/home",
      cta: "Lock my money",
      state: stateFor(1),
    },
    {
      id: "mainnet",
      title: "Switch to real money",
      body:
        "Everything so far was practice money. Switching opens your account on the real network with a dollar trustline, so real dollars can reach you.",
      doneNote: "You are on real money.",
      href: "/account",
      cta: "Switch to real money",
      state: stateFor(2),
    },
    {
      id: "pilot",
      title: "Ask to join the pilot",
      body:
        "Real sending is invite-only for now, so we can help every early user personally. Ask here and we approve by hand, usually quickly.",
      doneNote: "You are in the pilot.",
      href: "/pilot",
      cta: "Ask to join",
      state: stateFor(3),
    },
    {
      id: "money",
      title: "Add dollars",
      body:
        "Send USDC from an exchange or another wallet to your address, on the Stellar network. No memo needed — this account is yours alone.",
      doneNote: usdc ? `You hold $${usdc}.` : "You have dollars.",
      href: "/add-money",
      cta: "Show me my address",
      state: stateFor(4),
    },
  ];

  const allDone = done.every(Boolean);

  return (
    <div className="flex flex-col gap-5 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">
          {allDone ? "You're ready to send" : "Get set up to send"}
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          {allDone
            ? "Everything is in place. Send someone a link and they'll have the money in about thirty seconds, with nothing to install."
            : "Receiving money here takes no setup at all. Sending it takes five short steps, and this page keeps your place in them."}
        </p>
      </header>

      {allDone ? (
        <MoneyCard className="p-5">
          <p className="font-semibold text-ink">Send your first one</p>
          <p className="mb-4 mt-1 text-sm text-ink-soft">
            Pick an amount, get a link, send it however you already talk to them.
          </p>
          <Link href="/send" className="block">
            <PrimaryButton>Send money</PrimaryButton>
          </Link>
        </MoneyCard>
      ) : null}

      <ol className="flex list-none flex-col gap-3 p-0">
        {steps.map((s, i) => (
          <li key={s.id}>
            <MoneyCard
              className={`p-4 ${s.state === "later" ? "opacity-55" : ""}`}
              aria-current={s.state === "current" ? "step" : undefined}
            >
              <div className="flex items-start gap-3">
                {/* A number until it is done, a tick after — the cheapest possible "where am I". */}
                <span
                  aria-hidden
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    s.state === "done"
                      ? "bg-money text-surface"
                      : s.state === "current"
                        ? "bg-ink text-surface"
                        : "border border-line text-ink-soft"
                  }`}
                >
                  {s.state === "done" ? "✓" : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink">{s.title}</p>
                  <p className="mt-1 text-sm text-ink-soft">
                    {s.state === "done" ? s.doneNote : s.body}
                  </p>

                  {/* Only the current step gets a button. Two live buttons would ask the reader to
                      decide what to do next, which is the one thing this page exists to answer. */}
                  {s.state === "current" ? (
                    <div className="mt-3">
                      {s.id === "mainnet" && MAINNET_CONFIGURED ? (
                        <PrimaryButton onClick={() => switchNetwork("public")}>
                          {s.cta}
                        </PrimaryButton>
                      ) : (
                        <Link href={s.href} className="block">
                          <PrimaryButton>{s.cta}</PrimaryButton>
                        </Link>
                      )}
                      {s.id === "pilot" && pilotState === "pending" ? (
                        <p className="mt-2 text-sm text-ink-soft">
                          Your request is in. We&apos;ll email you the moment it&apos;s approved.
                        </p>
                      ) : null}
                      {s.id === "money" && checking ? (
                        <p className="mt-2 text-sm text-ink-soft">Checking your balance…</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </MoneyCard>
          </li>
        ))}
      </ol>

      {/* Someone who already has money on another phone does not belong in this list at all, and
          sending them through five setup steps to reach a restore button would be absurd. */}
      <MoneyCard className="p-4">
        <p className="font-semibold text-ink">Already used Lumenia on another phone?</p>
        <p className="mt-1 text-sm text-ink-soft">
          Don&apos;t start over — bring your money here with Face ID, or your email and password.
        </p>
        <Link
          href="/account"
          className="mt-2 inline-block text-sm font-medium text-money underline-offset-2 hover:underline"
        >
          Bring my money back
        </Link>
      </MoneyCard>
    </div>
  );
}
