"use client";

/**
 * /account — who you are on the public record, in plain terms. Real data only (no-mock): the account
 * address comes from the local keystore via useWallet; the custody phase is the real Phase-1/Phase-2
 * state; the explorer link resolves to the real on-chain account. No invented settings, no toggles
 * that do nothing.
 *
 * Vocabulary-law clean (money + people, "public record"): we say "your account" and "public record",
 * never wallet / crypto / address-as-jargon. The one honest hard truth — there is no password reset —
 * is stated plainly, because softening it would be a lie about what we can do.
 */
import { useState } from "react";
import Link from "next/link";
import { Copy, Check } from "lucide-react";
import { useWallet } from "../../../lib/wallet";
import { LockMoneyCard } from "../../../components/brand/LockMoneyCard";
import { MoneyCard } from "../../../components/brand/MoneyCard";

const explorer = (a: string) => `https://stellar.expert/explorer/testnet/account/${a}`;

export default function AccountPage() {
  const { status, account } = useWallet();
  const [copied, setCopied] = useState(false);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;

  if (!account) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-xl font-bold text-ink">No account yet</h1>
        <p className="max-w-xs text-ink-soft">
          When someone sends you money with a link, you claim it and your account is created here.
        </p>
        <Link href="/claimed" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          What is this?
        </Link>
      </div>
    );
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(account!.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  const short = `${account.address.slice(0, 6)}…${account.address.slice(-6)}`;

  return (
    <div className="flex flex-col gap-5 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Account</h1>
        <p className="mt-1 text-sm text-ink-soft">Who you are on the public record.</p>
      </header>

      {/* Your account — the real address, copyable + verifiable on the explorer. */}
      <MoneyCard className="p-5">
        <div className="app-krow" style={{ borderBottom: 0, paddingTop: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="app-kicon" src="/brand-kit-assets/icon-key.webp" alt="" />
          <div className="app-krow-body">
            <p className="app-krow-t">Your account</p>
            <p className="app-krow-s">This is where your money lives on the public record.</p>
          </div>
        </div>
        <p className="mt-3 break-all rounded-[12px] border border-line bg-paper px-3 py-2 font-mono text-xs text-ink-soft">
          {short}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={copyAddress}
            className="flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm font-medium text-ink"
          >
            {copied ? <Check className="size-4 text-money" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <a
            href={explorer(account.address)}
            target="_blank"
            rel="noreferrer"
            className="flex h-10 items-center rounded-full border border-line px-4 text-sm font-medium text-money"
          >
            See it on the public record ↗
          </a>
        </div>
      </MoneyCard>

      {/* Custody status — the real Phase-1/Phase-2 state, stated honestly. */}
      <MoneyCard className="p-5">
        <div className="app-krow" style={{ borderBottom: 0, paddingTop: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="app-kicon" src="/brand-kit-assets/icon-shield.webp" alt="" />
          <div className="app-krow-body">
            <p className="app-krow-t">
              {account.phase === 1 ? "Not locked yet" : "Locked with your password"}
            </p>
            <p className="app-krow-s">
              {account.phase === 1
                ? "Anyone with this phone can spend this money. Add a password to lock it to you."
                : "Only your password, on this phone, can spend this money."}
            </p>
          </div>
        </div>
      </MoneyCard>

      {account.phase === 1 && <LockMoneyCard />}

      {/* The honest hard truth about recovery — never softened. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">Only this phone</p>
        <p className="mt-1 text-sm text-ink-soft">
          Your money is never ours — it waits on the public record, not in a Lumenia account, so we
          can&apos;t lend it, freeze it, or lose it. That also means there is no password reset: if you
          lock your money and forget the password, nobody — including us — can recover it. That&apos;s
          what keeps it yours.
        </p>
      </MoneyCard>
    </div>
  );
}
