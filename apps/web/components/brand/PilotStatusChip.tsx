"use client";

/**
 * PilotStatusChip — a compact, glanceable chip of THIS account's mainnet-pilot standing, for the
 * account header. The full NetworkSwitcher card (with the switch action + copy) still lives lower
 * on the page; this is just the "am I approved for real money yet?" answer at a glance, before you
 * scroll or try to cash out.
 *
 * Same honest framing as NetworkSwitcher + PilotStatusBadge: it never says "rejected" and never
 * uses red — a not-yet is "on the list". Only two states carry the strong money accent: already on
 * real money, and approved to switch up.
 */
import { useWallet } from "../../lib/wallet";

export function PilotStatusChip() {
  const { network, pilotState } = useWallet();
  const onMainnet = network === "public";

  const chip = onMainnet
    ? { label: "Real money", cls: "border-money bg-money text-primary-foreground", dot: true }
    : pilotState === "approved"
      ? { label: "Approved for real money", cls: "border-money bg-secondary text-money", dot: true }
      : pilotState === "pending"
        ? { label: "On the pilot list", cls: "border-transparent bg-secondary text-ink", dot: false }
        : pilotState === "rejected"
          ? { label: "On the pilot list", cls: "border-line text-ink-soft", dot: false }
          : { label: "Practice mode", cls: "border-line text-ink-soft", dot: false };

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${chip.cls}`}
    >
      {chip.dot && <span className="size-1.5 rounded-full bg-current" />}
      {chip.label}
    </span>
  );
}
