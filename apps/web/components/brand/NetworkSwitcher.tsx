"use client";

/**
 * Which network am I on, and can I switch? The product is testnet (practice money) for EVERYONE;
 * a user the owner has approved for the mainnet pilot may switch to real money here. The switch
 * only flips a per-device flag and reloads — the sponsor's allowlist is the real gate, so a
 * non-approved user who forces the flag still cannot move mainnet money.
 *
 * Driven off the pilot standing (pilotState) so all four testnet cases read honestly, plus the
 * on-mainnet case: on mainnet (offer to switch back), approved (offer to switch up), pending (on
 * the list, nothing to do), rejected (not this round — never said in those words, never red), and
 * none (point at the pilot waitlist). Honest wording throughout: "practice" vs "real".
 */
import Link from "next/link";
import { useWallet } from "../../lib/wallet";
import { MoneyCard } from "./MoneyCard";

export function NetworkSwitcher() {
  const { network, pilotState, switchNetwork } = useWallet();
  const onMainnet = network === "public";

  // One honest sub-line + action per state (the header keeps the existing "practice vs real" framing).
  const sub = onMainnet
    ? "Every amount is real."
    : pilotState === "approved"
      ? "You're approved for real money."
      : pilotState === "pending"
        ? "You're on the list — we'll email you when your spot opens."
        : pilotState === "rejected"
          ? "Not yet — you're still on the list."
          : "A safe sandbox with play money.";

  return (
    <MoneyCard className="p-5">
      <p className="text-sm font-semibold text-ink">
        You&apos;re using {onMainnet ? "real money" : "practice money"}
      </p>
      <p className="mt-1 text-sm text-ink-soft">{sub}</p>
      <div className="mt-4">
        {onMainnet ? (
          <button
            onClick={() => switchNetwork("testnet")}
            className="h-10 rounded-full border border-line px-4 text-sm font-medium text-ink-soft"
          >
            Switch back to practice
          </button>
        ) : pilotState === "approved" ? (
          <button
            onClick={() => switchNetwork("public")}
            className="h-10 rounded-full border border-money bg-money px-4 text-sm font-medium text-primary-foreground"
          >
            Switch to real money
          </button>
        ) : pilotState === "pending" ? null : pilotState === "rejected" ? (
          <Link
            href="/home"
            className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-medium text-ink-soft"
          >
            Keep practicing
          </Link>
        ) : (
          <Link
            href="/pilot"
            className="inline-flex h-10 items-center rounded-full border border-money px-4 text-sm font-medium text-money"
          >
            Want to use real money? &rarr;
          </Link>
        )}
      </div>
    </MoneyCard>
  );
}
