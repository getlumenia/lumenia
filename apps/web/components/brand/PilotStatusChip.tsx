"use client";

/**
 * PilotStatusChip: a compact, glanceable chip of THIS account's real-money standing, for the account
 * header. The full NetworkSwitcher card (with the switch action and the account's own line) still
 * lives lower on the page; this is the "am I approved for real money yet?" answer at a glance.
 *
 * The same standing and the same words as every other surface (lib/pilot-access.ts pilotStanding
 * and standingCopy, contract 5.1): the chip shows the title, and its tooltip the line, which names
 * the account by its short address. A declined account is never "on the list". Only two states
 * carry the strong money accent: already on real money, and approved to switch up.
 */
import { useWallet } from "../../lib/wallet";
import { shortAddress } from "../../lib/account-label";
import { standingCopy } from "../../lib/pilot-access";

export function PilotStatusChip() {
  const { account, network, pilotStanding, pilotUsed, pilotLimit } = useWallet();
  const onMainnet = network === "public";
  const short = account ? shortAddress(account.address) : "";
  const left = pilotLimit !== null && pilotUsed !== null ? Math.max(0, pilotLimit - pilotUsed) : null;
  const words = standingCopy(pilotStanding, { short, left, limit: pilotLimit });

  const strong = onMainnet;
  const accent = !onMainnet && (pilotStanding === "approved" || pilotStanding === "open");
  const cls = strong
    ? "border-money bg-money text-primary-foreground"
    : accent
      ? "border-money bg-secondary text-money"
      : pilotStanding === "pending"
        ? "border-transparent bg-secondary text-ink"
        : "border-line text-ink-soft";

  return (
    <span
      title={words.line || undefined}
      className={`inline-flex max-w-[60%] items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${cls}`}
    >
      {(strong || accent) && <span className="size-1.5 shrink-0 rounded-full bg-current" />}
      <span className="truncate">{onMainnet ? "Real money" : words.title.replace(/\.$/, "")}</span>
    </span>
  );
}
