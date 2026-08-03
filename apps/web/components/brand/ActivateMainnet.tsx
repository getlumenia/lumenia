"use client";

/**
 * ActivateMainnet — the one-time "open my account on the real network" step.
 *
 * A wallet that only ever practiced has no account on mainnet: switching to real money just flips a
 * device flag, it does not create the on-chain account or its USDC trustline. Until that account
 * exists WITH a USDC trustline, dollars sent from an outside wallet (Freighter, an exchange) bounce
 * (op_no_destination / op_no_trust). This card closes that gap: the sponsor opens a 0-XLM account
 * with a USDC trustline (its own reserve), this device's key co-signs, and it submits. The user
 * holds 0 XLM; the sponsor covers reserve + fee. It only ever shows on real money, and only until
 * the trustline exists — the moment the account can hold dollars, it disappears.
 */
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "../../lib/wallet";
import { activeNetwork, USDC_ISSUER } from "../../lib/network";
import { prepareAccount } from "../../lib/sponsor";
import { MoneyCard } from "./MoneyCard";
import { PrimaryButton } from "./PrimaryButton";

type State = "checking" | "ready" | "needed" | "error";

export function ActivateMainnet() {
  const { network, account, getSigner } = useWallet();
  const router = useRouter();
  const [state, setState] = useState<State>("checking");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Does this account already exist on mainnet WITH a USDC trustline? If so there is nothing to do.
  useEffect(() => {
    if (network !== "public" || !account) return;
    let alive = true;
    const net = activeNetwork();
    const issuer = USDC_ISSUER[net.id];
    fetch(`${net.horizonUrl}/accounts/${account.address}`)
      .then(async (res) => {
        if (!alive) return;
        if (res.status === 404) return setState("needed"); // account not created yet
        if (!res.ok) return setState("error");
        const acc = (await res.json()) as { balances?: { asset_code?: string; asset_issuer?: string }[] };
        const hasUsdc = (acc.balances ?? []).some(
          (b) => b.asset_code === "USDC" && b.asset_issuer === issuer,
        );
        setState(hasUsdc ? "ready" : "needed");
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
    };
  }, [network, account]);

  // Only ever on real money, and only while the account still can't hold dollars.
  if (network !== "public" || state === "checking" || state === "ready") return null;

  async function activate() {
    setBusy(true);
    setErr("");
    try {
      const signer = await getSigner().catch(() => null);
      if (!signer) {
        // Locked account — go unlock, then come back here.
        router.push(`/unlock?next=${encodeURIComponent("/account")}`);
        return;
      }
      await prepareAccount({ sponsorUrl: activeNetwork().sponsorUrl, signer });
      setState("ready");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <MoneyCard className="p-5">
      <p className="font-semibold text-ink">Activate your account for real money</p>
      <p className="mt-1 text-sm text-ink-soft">
        Your account isn&apos;t open on the real network yet. This one-time step opens it so it can
        hold dollars — we cover the cost, and it stays yours. You&apos;ll need it before money can be
        sent here from another wallet or an exchange.
      </p>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      <div className="mt-4">
        <PrimaryButton loading={busy} loadingLabel="Activating…" onClick={activate}>
          Activate
        </PrimaryButton>
      </div>
    </MoneyCard>
  );
}
