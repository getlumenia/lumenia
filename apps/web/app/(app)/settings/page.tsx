"use client";

/**
 * /settings — who you are, what you hold, and how you get back in
 * (docs/IDENTITY_AND_ACCOUNTS.md §6).
 *
 * WHY THIS IS NOT /account. /account answers "where is my money and is it safe" — the balance
 * orientation, the network, the backup, the address people pay. This page answers the questions
 * that are about the PERSON rather than the money: what am I called, which accounts do I keep on
 * this phone, how would I find them again, and how do I leave this device. Splitting them keeps
 * both readable; merging them is how /account got long enough to need this rescue in the first
 * place.
 *
 * Four regions, one question each:
 *   1. Your name        — the `@handle` people can pay, and the federation address it resolves as.
 *   2. Your accounts    — every deliberate account here, which is active, add one, remove one.
 *   3. Ways back in     — passkey / email / Google / GitHub / X, framed as finding, never signing in.
 *   4. This device      — appearance, language, and removing your keys from this phone.
 *
 * Real data only: the name comes from the registry, the accounts from the local keystore, the
 * connections from a signed read. Nothing here is mocked, and an unanswerable question renders as
 * "we don't know" rather than as a confident empty.
 */
import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { useWallet } from "../../../lib/wallet";
import { hasBackup } from "../../../lib/recovery-api";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { HandleCard } from "../../../components/brand/HandleCard";
import { AccountsCard } from "../../../components/brand/AccountsCard";
import { WaysBackIn } from "../../../components/brand/WaysBackIn";
import { DisconnectButton } from "../../../components/brand/DisconnectButton";
import { ThemeToggle } from "../../../components/site/ThemeToggle";

/**
 * The OAuth round trip lands back here as `?connected=<ticket>&provider=<p>`. useSearchParams is a
 * prerender bailout, so it is isolated behind its own Suspense boundary and nothing else on the
 * page pays for it.
 */
function ConnectionsRegion() {
  const params = useSearchParams();
  return (
    <WaysBackIn
      connectedTicket={params.get("connected") ?? undefined}
      ticketProvider={params.get("provider") ?? undefined}
    />
  );
}

export default function SettingsPage() {
  const { status, account } = useWallet();

  if (status === "loading") {
    return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  }

  if (!account) {
    return (
      <div className="flex flex-col gap-5 py-4">
        <header>
          <h1 className="text-xl font-bold text-ink">Settings</h1>
        </header>
        <MoneyCard className="p-5">
          <p className="font-semibold text-ink">There is no account on this phone yet.</p>
          <p className="mt-1 text-sm text-ink-soft">
            An account appears here the moment someone sends you money with a link — or you can open
            one yourself, on practice money, in a few seconds.
          </p>
          <Link
            href="/welcome?start=1"
            className="mt-4 inline-flex rounded-full border border-line px-4 py-2.5 text-sm font-medium text-ink"
          >
            Get started
          </Link>
        </MoneyCard>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Settings</h1>
        <p className="mt-1 text-sm text-ink-soft">Who you are, what you hold, and how you get back in.</p>
      </header>

      <HandleCard />
      <AccountsCard />

      <Suspense fallback={null}>
        <ConnectionsRegion />
      </Suspense>

      {/* 4. This device. Appearance and language are here because they are device settings, not
          money settings — and because leaving the device needs a home that is not three disclosures
          deep on a page about balances. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">This device</p>

        <div className="mt-3 flex items-center justify-between gap-3 border-b border-line pb-3">
          <div>
            <p className="text-sm font-medium text-ink">Appearance</p>
            <p className="text-xs text-ink-soft">Light or dark. Follows your phone by default.</p>
          </div>
          <ThemeToggle />
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-line py-3">
          <div>
            <p className="text-sm font-medium text-ink">Language</p>
            <p className="text-xs text-ink-soft">English. More languages are on the way.</p>
          </div>
          <span className="text-sm text-ink-soft">English</span>
        </div>

        {/* Leaving is behind a disclosure because the consequence is asymmetric: with a backup it is
            reversible, without one it ends access to that money for good. The button says which of
            those two it is, rather than "sign out", which would be a promise we cannot keep. */}
        <details className="group pt-3">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
            Leave this device
            <ChevronDown className="size-4 text-ink-soft transition-transform group-open:rotate-180" />
          </summary>
          <p className="mt-2 text-sm text-ink-soft">
            This removes your keys from this phone. It does not touch your money, which lives on the
            public record and comes back with your email and password, or with Face ID.
          </p>
          <p className="mt-2 text-sm text-ink-soft">
            <strong className="text-ink">Only do this if you have backed it up.</strong> Without a
            backup, the keys here are the only way in, and removing them ends your access for good.
          </p>
          <DisconnectButton backedUp={hasBackup(account.address)} />
        </details>
      </MoneyCard>

      <p className="pb-2 text-center text-sm text-ink-soft">
        Looking for your balance or your backup?{" "}
        <Link href="/account" className="text-money underline-offset-2 hover:underline">
          That is on Account
        </Link>
        .
      </p>
    </div>
  );
}
