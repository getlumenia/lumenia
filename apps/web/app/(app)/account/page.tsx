"use client";

/**
 * /account — everything about your money in one place: your balance, how to receive, what's moved
 * in and out, how it's secured, how to back it up, how to turn it into local cash, and your
 * settings. Real data only (no-mock): balance + activity are live Horizon reads; the account
 * address + custody phase come from the local keystore via useWallet; the explorer links resolve to
 * the real on-chain account. No invented settings, no toggles that do nothing.
 *
 * Vocabulary-law clean (money + people, "public record"): "your money" / "your account" / "public
 * record", never wallet / crypto / address-as-jargon. The one honest hard truth — there is no
 * password reset — is stated plainly, because softening it would be a lie about what we can do.
 *
 * Built as the account "home" the extension / desktop / mobile shells will reuse: each concern is a
 * self-contained card, data comes from lib/horizon + useWallet, so the same surface ports cleanly.
 */
import { useState, useEffect } from "react";
import Link from "next/link";
import QRCode from "react-qr-code";
import { Copy, Check, Send, HandCoins, ArrowDownLeft, ArrowUpRight, QrCode } from "lucide-react";
import { useWallet } from "../../../lib/wallet";
import { loadTotalUsd, loadActivityForAccounts, type ActivityItem } from "../../../lib/horizon";
import { formatUsd } from "../../../lib/money";
import { LockMoneyCard } from "../../../components/brand/LockMoneyCard";
import { RecoveryFlow } from "../../../components/brand/RecoveryFlow";
import { FindWithFaceId } from "../../../components/brand/FindWithFaceId";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { FeedbackDialog } from "../../../components/FeedbackDialog";
import { ThemeToggle } from "../../../components/site/ThemeToggle";
import { sendEvent } from "../../../lib/events";
import { copy } from "../../../lib/copy";

const explorer = (a: string) => `https://stellar.expert/explorer/testnet/account/${a}`;

function fmtDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export default function AccountPage() {
  const { status, account, accounts } = useWallet();
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  // null = still loading; a value = the real Horizon result (empty is an honest empty).
  const [total, setTotal] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);

  useEffect(() => {
    if (!account) return;
    let alive = true;
    const addrs = accounts.length ? accounts.map((a) => a.address) : [account.address];
    // A brand-new account 404s on Horizon — loadTotalUsd/loadActivity return 0/[] honestly.
    loadTotalUsd(addrs)
      .then(async (r) => {
        if (!alive) return;
        setTotal(r.usd);
        // Same account set as the total, and paged so the account's own creation effects can no
        // longer crowd the one credit that matters out of an 8-row window.
        const acts = await loadActivityForAccounts(
          r.perAccount.map((p) => ({ address: p.address, issuer: p.issuer, isHome: p.address === account!.address })),
          8,
        ).catch(() => [] as ActivityItem[]);
        if (alive) setActivity(acts);
      })
      .catch(() => {
        if (!alive) return;
        setTotal("0");
        setActivity([]);
      });
    return () => {
      alive = false;
    };
  }, [account, accounts]);

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
        {/* The zero-typing path first: if they backed up with Face ID, nothing below is needed. */}
        <FindWithFaceId />
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
        <p className="mt-1 text-sm text-ink-soft">Everything about your money, in one place.</p>
      </header>

      {/* Your money — the real total, live from the public record. One number; the split across
          accounts is plumbing (loadTotalUsd), never shown. Honest $0.00 for a fresh account. */}
      <MoneyCard className="p-5">
        <p className="text-sm font-medium text-ink-soft">Your money</p>
        <p className="mt-1 text-4xl font-bold tabular-nums text-ink">
          {total === null ? "…" : formatUsd(total)}
        </p>
        <p className="mt-1 text-sm text-ink-soft">Held in dollars, yours to send whenever you like.</p>
      </MoneyCard>

      {/* Do something with it — the two things you can do today, one tap each. */}
      <div className="grid grid-cols-2 gap-3">
        <Link
          href="/send"
          className="flex flex-col items-start gap-2 rounded-[16px] border border-line bg-surface p-4 transition-colors hover:border-money"
        >
          <Send className="size-5 text-money" />
          <span className="font-semibold text-ink">Send money</span>
        </Link>
        <Link
          href="/request"
          className="flex flex-col items-start gap-2 rounded-[16px] border border-line bg-surface p-4 transition-colors hover:border-money"
        >
          <HandCoins className="size-5 text-money" />
          <span className="font-semibold text-ink">Ask to be paid</span>
        </Link>
      </div>

      {/* Receive — your account on the public record, copyable + verifiable. Someone can send
          straight to this, or you just receive a link like everyone else. */}
      <MoneyCard className="p-5">
        <div className="app-krow" style={{ borderBottom: 0, paddingTop: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="app-kicon" src="/brand-kit-assets/icon-key.webp" alt="" />
          <div className="app-krow-body">
            <p className="app-krow-t">Your account</p>
            <p className="app-krow-s">Where your money lives on the public record.</p>
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
          <button
            onClick={() => setShowQr((v) => !v)}
            aria-expanded={showQr}
            className="flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm font-medium text-ink"
          >
            <QrCode className="size-4" />
            {showQr ? "Hide code" : "Show code"}
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
        <p className="mt-3 text-sm text-ink-soft">
          Having money sent here from somewhere else?{" "}
          <Link href="/add-money" className="text-money underline-offset-2 hover:underline">
            What they need to know
          </Link>
          .
        </p>
        {/* The scannable code for handing money over in person. Drawn locally as plain SVG from the
            address already on screen — nothing is uploaded and no image service is called. The white
            plate + black pattern are fixed in both themes: a dark-on-dark code doesn't scan. */}
        {showQr && (
          <div className="mt-4 flex flex-col items-center gap-2">
            <div className="rounded-[16px] bg-white p-4">
              <QRCode value={account.address} size={168} bgColor="#FFFFFF" fgColor="#000000" level="M" />
            </div>
            <p className="text-center text-xs text-ink-soft">
              Let them point their camera at this. It sends money here.
            </p>
          </div>
        )}
      </MoneyCard>

      {/* Recent activity — money in and out, straight from the ledger. Honest empty for a new
          account; no invented rows. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">Recent activity</p>
        {activity === null ? (
          <p className="mt-2 text-sm text-ink-soft">Loading…</p>
        ) : activity.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No money in or out yet. When it moves, you&apos;ll see it here.</p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-line">
            {activity.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2.5">
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
                    a.direction === "in" ? "bg-accent-soft text-money" : "border border-line text-ink-soft"
                  }`}
                >
                  {a.direction === "in" ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
                </span>
                <span className="flex-1 text-sm text-ink">{a.direction === "in" ? "Received" : "Sent"}</span>
                <span className="text-right text-sm text-ink-soft">{fmtDate(a.at)}</span>
                <span className={`w-20 text-right font-semibold tabular-nums ${a.direction === "in" ? "text-money" : "text-ink"}`}>
                  {a.direction === "in" ? "+" : "−"}
                  {formatUsd(a.usd)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <Link href="/activity" className="text-sm font-medium text-money underline-offset-2 hover:underline">
            See all activity →
          </Link>
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
          sealed copy only your password can open, and we can never see inside it.
        </p>
        <RecoveryFlow mode="secure" />
      </MoneyCard>

      {/* The honest hard truth — updated for backup, never softened: backup makes it restorable
          across devices, but a forgotten password stays unrecoverable. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">Your password is the key</p>
        <p className="mt-1 text-sm text-ink-soft">
          Your money is never ours. It waits on the public record, not in a Lumenia account, so we
          can&apos;t lend it, freeze it, or lose it. Back it up above and your email plus your password
          bring it back on any phone. But the password can&apos;t be reset: if you forget it, nobody can
          open your money, us included. That&apos;s what keeps it yours.
        </p>
      </MoneyCard>

      {/* Turning dollars into local cash — a plain-worded entry to the honest guide (never the
          hero, never the claim flow; the recipient taps it deliberately). Firing the intent event
          on tap measures off-ramp demand vs. hold-dollars behavior (analyst rec), hashed account. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">Turning dollars into cash</p>
        <p className="mt-1 text-sm text-ink-soft">
          Hold your dollars as long as you like. When you want local money in your bank, here&apos;s
          the honest path, and the one mistake to avoid.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href="/cash-out"
            onClick={() => account && void sendEvent("cashout_guide_opened", account.address)}
            className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-medium text-money"
          >
            How to turn dollars into lira →
          </Link>
          {/* The step itself. Kept separate from /send (a person gets a link; an exchange gets a
              payment with a reference tag, and a wrong tag is how people lose money). */}
          <Link
            href="/send-out"
            className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-medium text-ink"
          >
            Send to an exchange
          </Link>
        </div>
      </MoneyCard>

      {/* Settings — real, honest controls only. Appearance is a live theme toggle; the device note
          points to backup rather than pretending an account lives in the cloud; language states the
          truth (English today, more later). No dead switches. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">Settings</p>
        <div className="mt-3 flex items-center justify-between border-b border-line pb-3">
          <div>
            <p className="text-sm font-medium text-ink">Appearance</p>
            <p className="text-xs text-ink-soft">Light or dark. Follows your phone by default.</p>
          </div>
          <ThemeToggle />
        </div>
        <div className="flex items-center justify-between border-b border-line py-3">
          <div>
            <p className="text-sm font-medium text-ink">This phone</p>
            <p className="text-xs text-ink-soft">Your money lives on this device. Back it up above to use it elsewhere.</p>
          </div>
        </div>
        <div className="flex items-center justify-between pt-3">
          <div>
            <p className="text-sm font-medium text-ink">Language</p>
            <p className="text-xs text-ink-soft">English. More languages are on the way.</p>
          </div>
          <span className="text-sm text-ink-soft">English</span>
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
