"use client";

/**
 * Which network am I on, and can I switch? The product is testnet (practice money) for EVERYONE;
 * a user the owner has approved for the mainnet pilot may switch to real money here. The switch
 * only flips a per-device flag and reloads — the sponsor's allowlist is the real gate, so a
 * non-approved user who forces the flag still cannot move mainnet money.
 *
 * Three states: on mainnet (offer to switch back), approved-but-on-testnet (offer to switch up),
 * not-approved (point at the pilot waitlist). Honest wording throughout: "practice" vs "real".
 */
import Link from "next/link";
import { useWallet } from "../../lib/wallet";
import { MoneyCard } from "./MoneyCard";

export function NetworkSwitcher() {
  const { network, mainnetApproved, switchNetwork } = useWallet();
  const onMainnet = network === "public";

  return (
    <MoneyCard className="p-5">
      <p className="text-sm font-semibold text-ink">
        You&apos;re using {onMainnet ? "real money" : "practice money"}
      </p>
      <p className="mt-1 text-sm text-ink-soft">
        {onMainnet
          ? "This is mainnet: every amount is real. You can switch back to practice any time."
          : "This is testnet: a safe sandbox with play money, so you can try everything risk-free."}
      </p>
      <div className="mt-4">
        {onMainnet ? (
          <button
            onClick={() => switchNetwork("testnet")}
            className="h-10 rounded-full border border-line px-4 text-sm font-medium text-ink-soft"
          >
            Switch back to practice
          </button>
        ) : mainnetApproved ? (
          <button
            onClick={() => switchNetwork("public")}
            className="h-10 rounded-full border border-money px-4 text-sm font-medium text-money"
          >
            Switch to real money
          </button>
        ) : (
          <Link
            href="/pilot"
            className="inline-flex h-10 items-center rounded-full border border-money px-4 text-sm font-medium text-money"
          >
            Want to use real money? Join the pilot &nearr;
          </Link>
        )}
      </div>
    </MoneyCard>
  );
}
