"use client";

/**
 * The v2 claim action. Reads the bearer link secret (a Stellar S… key) from the #fragment, strips
 * it from the URL immediately, and on tap runs the walletless/gasless v2 claim: a fresh sponsored
 * account is created for the recipient and the drop is paid straight into it via the /v2-claim
 * relayer. The claimed account is persisted locally (Phase 1) so /home shows it. No wallet, no gas.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { claimV2ToSponsoredAccount } from "../../../../lib/lumendrop";
import { savePhase1 } from "../../../../lib/keystore";
import { resolveNetwork, type NetworkConfig } from "../../../../lib/network";

const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.vercel.app";
const explorer = (hash: string, net: NetworkConfig) =>
  `https://stellar.expert/explorer/${net.isMainnet ? "public" : "testnet"}/tx/${hash}`;

type State = "idle" | "claiming" | "done" | "error";

export default function V2ClaimButton({
  linkHex,
  sender,
}: {
  linkHex: string;
  amount: string;
  sender: string;
}) {
  const [state, setState] = useState<State>("idle");
  const [hash, setHash] = useState("");
  const [noKey, setNoKey] = useState(false);
  const [error, setError] = useState("");
  // The link carries its own network (`?n=public`). The product is testnet; a handful of mainnet
  // links exist as real-money evidence, and this is what keeps one deployment able to serve both.
  const [net, setNet] = useState<NetworkConfig | null>(null);
  const secretRef = useRef("");

  useEffect(() => {
    try {
      setNet(resolveNetwork(new URLSearchParams(window.location.search).get("n")));
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
    const frag = window.location.hash.slice(1);
    if (frag) {
      secretRef.current = frag;
      history.replaceState(null, "", window.location.pathname + window.location.search);
    } else if (!secretRef.current) {
      setNoKey(true);
    }
  }, []);

  async function onClaim() {
    setState("claiming");
    try {
      const secret = secretRef.current;
      if (!secret) throw new Error("This link is invalid (missing key).");
      if (!net) throw new Error("Still loading — please tap again.");
      const r = await claimV2ToSponsoredAccount({
        linkSecret: secret,
        sponsorUrl: net.isMainnet ? net.sponsorUrl : SPONSOR_URL,
        net,
      });
      // Persist the claimed account locally so /home shows it. Best-effort.
      try {
        await savePhase1(r.publicKey, r.seed);
      } finally {
        r.seed.fill(0);
      }
      setHash(r.hash);
      setState("done");
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(30);
    } catch (e) {
      console.error("[v2-claim]", e);
      setError((e as Error).message);
      setState("error");
    }
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

  return (
    <div className="flex w-full flex-col items-center gap-3">
      {noKey ? (
        <p className="text-sm text-ink-soft">Open your original link to claim this money.</p>
      ) : (
        <button
          onClick={onClaim}
          data-link={linkHex}
          className="h-14 w-full rounded-full bg-money px-8 text-base font-semibold text-primary-foreground transition-colors hover:bg-money/90 active:bg-money-pressed"
        >
          Claim my money
        </button>
      )}
      {state === "error" && (
        <p className="text-sm text-danger">
          {error.includes("mainnet is not configured")
            ? "This link is for a network this site cannot reach right now."
            : `${sender}'s money is still safe — please try again.`}
        </p>
      )}
    </div>
  );
}
