"use client";

/**
 * Which network am I on, and can I switch? The product is testnet (practice money) for EVERYONE;
 * a user the owner has approved for the mainnet pilot may switch to real money here. The switch
 * only flips a per-device flag and reloads — the sponsor's allowlist is the real gate, so a
 * non-approved user who forces the flag still cannot move mainnet money.
 *
 * Driven off this account's STANDING (lib/pilot-access.ts pilotStanding, the same table and the
 * same words as the extension, contract 4 and 5.1), and every line names the account it is about
 * by its short address: a person may hold more than one account, and the website and the extension
 * may be holding different ones, so "You're on the list" alone could be about either. A declined
 * account is told so plainly and is never "still on the list"; a check that failed is "we couldn't
 * check", never "not approved", and an earlier answer stays on screen with its age.
 */
import Link from "next/link";
import { useWallet } from "../../lib/wallet";
import { shortAddress } from "../../lib/account-label";
import { checkedAgo, standingCopy } from "../../lib/pilot-access";
import { MoneyCard } from "./MoneyCard";

const primary = "h-10 rounded-full border border-money bg-money px-4 text-sm font-medium text-primary-foreground";
const secondary = "inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-medium text-ink-soft";
const accent = "inline-flex h-10 items-center rounded-full border border-money px-4 text-sm font-medium text-money";

export function NetworkSwitcher() {
  const { account, network, pilotStanding, pilotUsed, pilotLimit, pilotStale, pilotCheckedAt, recheckPilot, switchNetwork } = useWallet();
  const onMainnet = network === "public";
  const short = account ? shortAddress(account.address) : "";
  const left = pilotLimit !== null && pilotUsed !== null ? Math.max(0, pilotLimit - pilotUsed) : null;
  const words = standingCopy(pilotStanding, { short, left, limit: pilotLimit });

  return (
    <MoneyCard className="p-5">
      <p className="text-sm font-semibold text-ink">
        You&apos;re using {onMainnet ? "real money" : "practice money"}
      </p>
      {onMainnet && <p className="mt-1 text-sm text-ink-soft">Every amount is real.</p>}
      {(!onMainnet || pilotStanding === "no-sends" || pilotStanding === "revoked" || pilotStanding === "approved") && (
        <>
          <p className="mt-2 text-sm font-medium text-ink">{words.title}</p>
          {words.line && <p className="mt-1 text-sm text-ink-soft">{words.line}</p>}
        </>
      )}
      {pilotStale && pilotCheckedAt !== null && <p className="mt-1 text-xs text-ink-soft">{checkedAgo(pilotCheckedAt)}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {onMainnet ? (
          <>
            <button onClick={() => switchNetwork("testnet")} className="h-10 rounded-full border border-line px-4 text-sm font-medium text-ink-soft">
              Switch back to practice
            </button>
            {pilotStanding === "no-sends" && (
              <Link href="/pilot" className={accent}>
                Ask for more sends
              </Link>
            )}
          </>
        ) : pilotStanding === "approved" || pilotStanding === "open" ? (
          <button onClick={() => switchNetwork("public")} className={primary}>
            Switch to real money
          </button>
        ) : pilotStanding === "no-sends" ? (
          <>
            <Link href="/pilot" className={accent}>
              Ask for more sends
            </Link>
            {/* No sends left still leaves receiving, cashing out and taking links back. */}
            <button onClick={() => switchNetwork("public")} className={secondary}>
              Switch to real money
            </button>
          </>
        ) : pilotStanding === "pending" || pilotStanding === "unknown" ? (
          <button onClick={recheckPilot} className={secondary}>
            {words.action}
          </button>
        ) : pilotStanding === "none" ? (
          <Link href="/pilot" className={accent}>
            Ask to join
          </Link>
        ) : null}
      </div>
    </MoneyCard>
  );
}
