"use client";

/**
 * ActivateMainnet — opens the account's dollar line on real money. Silently.
 *
 * WHAT IT IS FOR. A wallet that only ever practiced has no account on mainnet: switching to real
 * money flips a device flag, it does not create the on-chain account or its USDC trustline. Until
 * that account exists WITH a USDC trustline, dollars sent from an outside wallet or an exchange
 * bounce (op_no_destination / op_no_trust). The sponsor opens a 0-XLM account with a USDC
 * trustline against its own reserve, this device's key co-signs, and it submits.
 *
 * WHY IT NO LONGER ASKS. It used to be a card: a heading about activating your account, a
 * paragraph about the real network, a disclosure explaining Stellar's 1.5 XLM reserve, and a
 * button. All of it true, and none of it the user's problem — a trustline is a fact about how
 * Stellar stores balances, not a decision anybody is being invited to make. There is exactly one
 * right answer, the product knows it, and the cost falls on the sponsor either way. So it happens.
 *
 * WHAT STILL SURFACES, and only this:
 *   - a LOCKED account, because a trustline is sourced by the account itself and cannot be opened
 *     without its key. That is a password prompt, not an explanation of ledger reserves.
 *   - a FAILURE, because silence about money that cannot arrive would be the worse dishonesty.
 *
 * It renders nothing at all in every other state, including while it is working.
 */
import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useWallet } from "../../lib/wallet";
import { ensureCanReceive, type Receivable } from "../../lib/receivable";
import { MoneyCard } from "./MoneyCard";
import { PrimaryButton } from "./PrimaryButton";

export function ActivateMainnet() {
  const { network, account, getSigner } = useWallet();
  const router = useRouter();
  const pathname = usePathname();
  const [result, setResult] = useState<Receivable | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (network !== "public" || !account) return;
    let alive = true;
    void ensureCanReceive(account.address, getSigner).then((r) => alive && setResult(r));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, account, attempt]);

  if (network !== "public") return null;
  // "working" renders nothing on purpose: a spinner here would be the machinery announcing itself,
  // and nothing on this screen is waiting on it.
  if (!result || result.state === "ready") return null;

  if (result.state === "locked") {
    return (
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">Unlock to finish setting up</p>
        <p className="mt-1 text-sm text-ink-soft">
          Your password is needed once, so dollars sent from another wallet can reach you.
        </p>
        <div className="mt-4">
          <PrimaryButton onClick={() => router.push(`/unlock?next=${encodeURIComponent(pathname)}`)}>
            Unlock
          </PrimaryButton>
        </div>
      </MoneyCard>
    );
  }

  return (
    <MoneyCard className="p-5">
      <p className="font-semibold text-ink">We couldn&apos;t finish setting up your account</p>
      <p className="mt-1 text-sm text-ink-soft">
        Money sent here from another wallet won&apos;t arrive until this works. Your own money is
        safe.
      </p>
      <p className="mt-2 text-sm text-danger">{result.error}</p>
      <div className="mt-4">
        <PrimaryButton
          onClick={() => {
            setResult(null);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </PrimaryButton>
      </div>
    </MoneyCard>
  );
}
