"use client";

/**
 * PilotStatusBadge: this account's real-money standing, in its own words (contract 5.1).
 *
 * Reads the wallet's pilotStanding (lib/pilot-access.ts, the same table the extension uses) and
 * says it with the account's short address in the line, because a person may hold several accounts
 * and the website and the extension may be holding different ones. Only the standings with
 * something to do carry an action: switch up (approved, open), ask again later (pending, unknown),
 * ask (none), ask for more sends (no-sends). A declined account is told so plainly, never "still on
 * the list"; a taken-off account is told its money stays its own.
 *
 * Tokens match the app brand set (see NetworkSwitcher + MoneyCard): text-ink / text-ink-soft copy,
 * money for the accent, line for neutral borders, secondary (= accent-soft #E8E3F7 in .app-pw) for
 * the calm pending tint — all theme-aware, so light and dark both stay readable.
 */
import Link from "next/link";
import { useWallet } from "../../lib/wallet";
import { shortAddress } from "../../lib/account-label";
import { standingCopy } from "../../lib/pilot-access";

const primary =
  "inline-flex h-10 items-center justify-center rounded-full border border-money bg-money px-4 text-sm font-medium text-primary-foreground";
const quiet = "inline-flex h-10 items-center justify-center rounded-full border border-line px-4 text-sm font-medium text-ink-soft";

export function PilotStatusBadge() {
  const { account, pilotStanding, pilotUsed, pilotLimit, recheckPilot, switchNetwork } = useWallet();
  const short = account ? shortAddress(account.address) : "";
  const left = pilotLimit !== null && pilotUsed !== null ? Math.max(0, pilotLimit - pilotUsed) : null;
  const words = standingCopy(pilotStanding, { short, left, limit: pilotLimit });
  const calm = pilotStanding === "pending" || pilotStanding === "checking";

  return (
    <div className={calm ? "rounded-[14px] bg-secondary px-4 py-3" : "flex flex-col items-start gap-3"}>
      <div>
        <p className="text-sm font-semibold text-ink">{words.title}</p>
        {words.line && <p className="mt-1 text-sm text-ink-soft">{words.line}</p>}
      </div>
      {pilotStanding === "approved" || pilotStanding === "open" ? (
        <button onClick={() => switchNetwork("public")} className={primary}>
          {words.action}
        </button>
      ) : pilotStanding === "pending" || pilotStanding === "unknown" ? (
        <button onClick={recheckPilot} className={`${quiet} mt-2`}>
          {words.action}
        </button>
      ) : pilotStanding === "none" || pilotStanding === "no-sends" ? (
        <Link href="/pilot" className={quiet}>
          {words.action}
        </Link>
      ) : null}
    </div>
  );
}
