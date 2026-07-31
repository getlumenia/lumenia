"use client";

/**
 * PilotStatusBadge — this account's mainnet-pilot standing, in one honest chip.
 *
 * Reads pilotState from the wallet (the sponsor's /pilot-status `state`): 'none' (never asked),
 * 'pending' (asked, waiting), 'approved' (may switch to real money), 'rejected' (not this round).
 * The UI never says the word "rejected" and never uses red — a "not yet" is framed as "still on
 * the list", because a waitlist is not a failure. Only the approved state carries an action (switch
 * up); pending/rejected are calm, no-op reassurance so there is nothing to anxiously retry.
 *
 * Tokens match the app brand set (see NetworkSwitcher + MoneyCard): text-ink / text-ink-soft copy,
 * money for the accent, line for neutral borders, secondary (= accent-soft #E8E3F7 in .app-pw) for
 * the calm pending tint — all theme-aware, so light and dark both stay readable.
 */
import Link from "next/link";
import { useWallet } from "../../lib/wallet";

export function PilotStatusBadge() {
  const { pilotState, switchNetwork } = useWallet();

  if (pilotState === "approved") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm font-semibold text-ink">You&apos;re approved for real money</p>
        <button
          onClick={() => switchNetwork("public")}
          className="inline-flex h-10 items-center justify-center rounded-full border border-money bg-money px-4 text-sm font-medium text-primary-foreground"
        >
          Switch to real money
        </button>
      </div>
    );
  }

  if (pilotState === "pending") {
    // Calm accent-soft (#E8E3F7 in the app scope) chip — no spinner, no action.
    return (
      <div className="rounded-[14px] bg-secondary px-4 py-3">
        <p className="text-sm font-semibold text-ink">You&apos;re on the list</p>
        <p className="mt-1 text-sm text-ink-soft">
          Nothing to do right now — we&apos;ll email you the moment your spot opens.
        </p>
      </div>
    );
  }

  if (pilotState === "rejected") {
    // Neutral, line-bordered chip — never red, never the word "rejected".
    return (
      <div className="rounded-[14px] border border-line px-4 py-3">
        <p className="text-sm font-semibold text-ink">Not yet — you&apos;re still on the list</p>
        <p className="mt-1 text-sm text-ink-soft">
          Keep using practice mode. Reply to our email if you&apos;re stuck.
        </p>
      </div>
    );
  }

  // 'none' — never asked.
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm font-semibold text-ink">Want to use real money?</p>
      <Link
        href="/pilot"
        className="inline-flex h-10 items-center justify-center rounded-full border border-money bg-secondary px-4 text-sm font-medium text-money"
      >
        Join the pilot →
      </Link>
    </div>
  );
}
