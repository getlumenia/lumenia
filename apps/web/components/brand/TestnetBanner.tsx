"use client";

/**
 * TestnetBanner: retired as a permanent status bar (a finished product carries none), and brought
 * back for EVENT MODE only as a small network badge (hackathon build, 2026-09-19): on a stage where
 * the mainnet claim and the testnet lira rail are shown minutes apart, real and practice money must
 * never look alike. Outside event mode it renders nothing, exactly as before.
 *
 * The network is read after mount: it lives in this device's storage (lib/network activeNetwork),
 * so reading it during render would differ between the server and the phone.
 */
import { useEffect, useState } from "react";
import { activeNetwork } from "../../lib/network";
import { eventMode } from "../../lib/event-mode";

export function TestnetBanner(_props: { className?: string }) {
  const [real, setReal] = useState<boolean | null>(null);
  useEffect(() => {
    if (eventMode()) setReal(activeNetwork().isMainnet);
  }, []);
  if (!eventMode() || real === null) return null;
  return (
    <div
      className={`w-full py-1 text-center text-xs font-semibold ${real ? "bg-money text-primary-foreground" : "bg-secondary text-ink-soft"}`}
      role="status"
    >
      {real ? "Real money: Stellar mainnet, capped pilot" : "Practice money: Stellar test network"}
    </div>
  );
}
