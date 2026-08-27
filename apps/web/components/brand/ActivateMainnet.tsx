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
import { useState, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useWallet } from "../../lib/wallet";
import { activeNetwork, USDC_ISSUER } from "../../lib/network";
import { prepareAccount } from "../../lib/sponsor";
import { MoneyCard } from "./MoneyCard";
import { PrimaryButton } from "./PrimaryButton";

type State = "checking" | "ready" | "working" | "locked" | "error";

export function ActivateMainnet() {
  const { network, account, getSigner } = useWallet();
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<State>("checking");
  const [err, setErr] = useState("");
  // Bumped by "Try again" — the effect keys off it, since network/account have not changed.
  const [attempt, setAttempt] = useState(0);
  // At most one attempt per mount: the thing it does costs the sponsor a reserve.
  const attempted = useRef(false);

  useEffect(() => {
    if (network !== "public" || !account) return;
    let alive = true;
    const net = activeNetwork();
    const issuer = USDC_ISSUER[net.id];

    async function open() {
      if (attempted.current) return;
      attempted.current = true;
      const signer = await getSigner().catch(() => null);
      if (!alive) return;
      if (!signer) return setState("locked");
      setState("working");
      try {
        await prepareAccount({ sponsorUrl: net.sponsorUrl, signer });
        if (alive) setState("ready");
      } catch (e) {
        if (alive) {
          setErr((e as Error).message);
          setState("error");
        }
      }
    }

    fetch(`${net.horizonUrl}/accounts/${account.address}`)
      .then(async (res) => {
        if (!alive) return;
        if (res.status === 404) return open(); // no account on this chain yet
        if (!res.ok) return setState("error");
        const acc = (await res.json()) as { balances?: { asset_code?: string; asset_issuer?: string }[] };
        const hasUsdc = (acc.balances ?? []).some(
          (b) => b.asset_code === "USDC" && b.asset_issuer === issuer,
        );
        // Already able to hold dollars — there was never anything to do here.
        return hasUsdc ? setState("ready") : open();
      })
      .catch(() => alive && setState("error"));

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network, account, attempt]);

  if (network !== "public") return null;
  // "working" renders nothing on purpose: a spinner here would be the machinery announcing itself,
  // and nothing on this screen is waiting on it.
  if (state === "checking" || state === "ready" || state === "working") return null;

  if (state === "locked") {
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
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      <div className="mt-4">
        <PrimaryButton
          onClick={() => {
            attempted.current = false;
            setErr("");
            setState("checking");
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </PrimaryButton>
      </div>
    </MoneyCard>
  );
}
