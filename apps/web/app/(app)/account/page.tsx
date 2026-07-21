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
import { RecoveryFlow } from "../../../components/brand/RecoveryFlow";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { FeedbackDialog } from "../../../components/FeedbackDialog";
import { sendEvent } from "../../../lib/events";
import { copy } from "../../../lib/copy";

const explorer = (a: string) => `https://stellar.expert/explorer/testnet/account/${a}`;

export default function AccountPage() {
  const { status, account } = useWallet();
  const [copied, setCopied] = useState(false);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;

  if (!account) {
    return (
      <div className="flex flex-col gap-5 py-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-xl font-bold text-ink">No account yet</h1>
          <p className="max-w-xs text-ink-soft">
            When someone sends you money with a link, you claim it and your account is created here.
          </p>
          <Link href="/claimed" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
            What is this?
          </Link>
        </div>
        <MoneyCard className="p-5">
          <p className="font-semibold text-ink">Already have money on another phone?</p>
          <p className="mb-3 mt-1 text-sm text-ink-soft">
            If you backed it up with a password, enter your email and we&apos;ll send a code to bring
            your money back here.
          </p>
          <RecoveryFlow mode="restore" />
        </MoneyCard>
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

      {/* Back up your money — set a password + email so it can be restored on any device
          (RECOVERY_ARCHITECTURE §12). The password locks it locally AND wraps a sealed copy the
          server can hold but never open. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">Back up your money</p>
        <p className="mb-3 mt-1 text-sm text-ink-soft">
          Set a password and your email, and you can bring your money back on a new phone. We keep a
          sealed copy only your password can open — we can never see inside it.
        </p>
        <RecoveryFlow mode="secure" />
      </MoneyCard>

      {/* The honest hard truth — updated for backup, never softened: backup makes it restorable
          across devices, but a forgotten password stays unrecoverable. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">Your password is the key</p>
        <p className="mt-1 text-sm text-ink-soft">
          Your money is never ours — it waits on the public record, not in a Lumenia account, so we
          can&apos;t lend it, freeze it, or lose it. Back it up above and your email plus your password
          bring it back on any phone. But the password can&apos;t be reset: if you forget it, nobody —
          including us — can open your money. That&apos;s what keeps it yours.
        </p>
      </MoneyCard>

      {/* Turning dollars into local cash — a plain-worded entry to the honest guide (never the
          hero, never the claim flow; the recipient taps it deliberately). Firing the intent event
          on tap measures off-ramp demand vs. hold-dollars behavior (analyst rec), hashed account. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">Turning dollars into cash</p>
        <p className="mt-1 text-sm text-ink-soft">
          You can hold your dollars as long as you like. When you want local money in your bank,
          here&apos;s the honest path — and the one mistake to avoid.
        </p>
        <div className="mt-3">
          <Link
            href="/cash-out"
            onClick={() => account && void sendEvent("cashout_guide_opened", account.address)}
            className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-medium text-money"
          >
            How to turn dollars into lira →
          </Link>
        </div>
      </MoneyCard>

      {/* The human channel — a real inbox (sponsor /feedback, isolated store), not a dead link. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">Need a hand?</p>
        <p className="mt-1 text-sm text-ink-soft">
          If something looks wrong or you&apos;re stuck, tell us what happened.
        </p>
        <div className="mt-3">
          <FeedbackDialog trigger={copy.feedback.linkLabel} triggerClassName="fb-trigger-pill" defaultCategory="money" />
        </div>
      </MoneyCard>
    </div>
  );
}
