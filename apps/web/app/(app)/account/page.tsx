"use client";

/**
 * /account — everything about your money in one place, in fewer, calmer regions (UX pass):
 *   1. Your money — the big balance.
 *   2. Actions — Send · Ask to be paid.
 *   3. Network state — practice vs. real money, near the top (no longer buried mid-page).
 *   ── below, the less-frequent stuff ──
 *   4. Receive — your account address + Copy + QR (collapsed) + explorer link.
 *   5. Security & backup — ONE card: a state-driven lock header, one primary action (back up your
 *      money, which also locks it), and the no-password-reset truth tucked into a single
 *      <details>. This replaces the four consecutive security/backup cards that read as "fragile".
 *   6. More — recent activity as a compact preview + cash-out, appearance and help as compact rows.
 *
 * Real data only (no-mock): balance + activity are live Horizon reads; the account address +
 * custody phase come from the local keystore via useWallet; the explorer links resolve to the real
 * on-chain account. A brand-new account 404s on Horizon → honest $0.00 / empty, never invented rows.
 *
 * Vocabulary-law clean (money + people, "public record"): "your money" / "your account" / "public
 * record", never wallet / crypto / address-as-jargon. The one honest hard truth — there is no
 * password reset — is stated plainly, because softening it would be a lie about what we can do.
 *
 * Deep link: the mainnet-approval email's button lands on /account?switch=mainnet. When THIS
 * account is on the pilot allowlist we flip the device to real money and strip the param, guarded by
 * a one-shot flag so it can never loop. That lives in <MainnetSwitchOnApproval>, isolated under its
 * own Suspense boundary so useSearchParams never bails the whole page out of prerender.
 */
import { Suspense, useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import QRCode from "react-qr-code";
import { Copy, Check, Send, HandCoins, ArrowDownLeft, ArrowUpRight, QrCode, ChevronDown } from "lucide-react";
import { useWallet } from "../../../lib/wallet";
import { loadTotalUsd, loadActivityForAccounts, type ActivityItem } from "../../../lib/horizon";
import { formatUsd } from "../../../lib/money";
import { RecoveryFlow } from "../../../components/brand/RecoveryFlow";
import { NetworkSwitcher } from "../../../components/brand/NetworkSwitcher";
import { FindWithFaceId } from "../../../components/brand/FindWithFaceId";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { FeedbackDialog } from "../../../components/FeedbackDialog";
import { ThemeToggle } from "../../../components/site/ThemeToggle";
import { sendEvent } from "../../../lib/events";
import { copy } from "../../../lib/copy";
import { explorerAccount, setActiveNetwork } from "../../../lib/network";

const explorer = explorerAccount;

function fmtDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

/**
 * Deep-link handler for the approval email's "Switch to real money" button (→ /account?switch=
 * mainnet). If this account is approved for the pilot, flip the device to real money and drop the
 * param. A one-shot sessionStorage flag (lumenia.switch.done), set BEFORE the switch, means the
 * network change — and any reload it may trigger — can never re-enter this into an infinite loop.
 * If the param is present but the account is NOT approved yet, it does nothing: just renders, no
 * loop (mainnetApproved resolves async, so the effect re-runs and fires once approval lands).
 * Renders nothing; isolated so its useSearchParams call is the only thing under the Suspense line.
 */
function MainnetSwitchOnApproval({ approved }: { approved: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get("switch") !== "mainnet") return; // not the deep link → nothing to do
    if (!approved) return; // present but not approved (yet) → render, never switch, never loop
    try {
      if (sessionStorage.getItem("lumenia.switch.done") === "1") return; // already switched this session
      sessionStorage.setItem("lumenia.switch.done", "1"); // set the one-shot BEFORE the switch, so a reload can't re-enter
    } catch {
      /* storage blocked — proceed once; the router.replace below still strips the param */
    }
    setActiveNetwork("public"); // flip this device to real money (the sponsor allowlist is the real gate)
    router.replace("/account"); // strip ?switch=mainnet so a refresh can't retrigger it
  }, [approved, searchParams, router]);

  return null;
}

export default function AccountPage() {
  const { status, account, accounts, mainnetApproved } = useWallet();
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
      {/* Deep link: switch to real money when the approval email sends them here (renders nothing).
          useSearchParams is the only bailout hook, so it sits alone under this Suspense line. */}
      <Suspense fallback={null}>
        <MainnetSwitchOnApproval approved={mainnetApproved} />
      </Suspense>

      <header>
        <h1 className="text-xl font-bold text-ink">Account</h1>
        <p className="mt-1 text-sm text-ink-soft">Everything about your money, in one place.</p>
      </header>

      {/* 1. Your money — the real total, live from the public record. One number; the split across
          accounts is plumbing (loadTotalUsd), never shown. Honest $0.00 for a fresh account. */}
      <MoneyCard className="p-5">
        <p className="text-sm font-medium text-ink-soft">Your money</p>
        <p className="mt-1 text-4xl font-bold tabular-nums text-ink">
          {total === null ? "…" : formatUsd(total)}
        </p>
        <p className="mt-1 text-sm text-ink-soft">Held in dollars, yours to send whenever you like.</p>
      </MoneyCard>

      {/* 2. Actions — the two things you can do today, one tap each. */}
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

      {/* 3. Network state — practice vs. real money, up near the top so it's never buried. The
          component already handles every pilot state (none / pending / approved / rejected / on-mainnet). */}
      <NetworkSwitcher />

      {/* ── below this line: the less-frequent stuff ── */}

      {/* 4. Receive — your account on the public record, copyable + verifiable. Someone can send
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

      {/* 5. Security & backup — the four old cards (custody status + lock + back up + the hard
          truth) merged into ONE calm card, so it never reads as "this product is fragile":
            • a state-driven header (the real Phase-1/Phase-2 custody state, honest wording),
            • ONE primary action — back up your money, which ALSO locks it (secureRecovery locks
              Phase 1→2 and wraps a sealed, server-storable copy); RecoveryFlow shows its own
              "backed up ✓" state on success,
            • the no-password-reset truth as a single <details>, verbatim, not a scary standing card. */}
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

        {/* The one primary action: set a password + email once. It locks this money to you AND keeps
            a sealed copy only your password can open, so it restores on any device
            (RECOVERY_ARCHITECTURE §12). RecoveryFlow flips to its own "backed up" confirmation. */}
        <div className="mt-4 border-t border-line pt-4">
          <p className="font-semibold text-ink">Back up your money</p>
          <p className="mb-3 mt-1 text-sm text-ink-soft">
            Set a password and your email, and you can bring your money back on a new phone. We keep a
            sealed copy only your password can open, and we can never see inside it.
          </p>
          <RecoveryFlow mode="secure" />
        </div>

        {/* The honest hard truth — one expandable line, not a standing scare card. The copy is kept
            verbatim (backup makes it restorable across devices; a forgotten password stays
            unrecoverable — never softened). */}
        <details className="group mt-4 border-t border-line pt-4">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
            What if I forget my password?
            <ChevronDown className="size-4 text-ink-soft transition-transform group-open:rotate-180" />
          </summary>
          <p className="mt-2 text-sm text-ink-soft">
            Your money is never ours. It waits on the public record, not in a Lumenia account, so we
            can&apos;t lend it, freeze it, or lose it. Back it up above and your email plus your password
            bring it back on any phone. But the password can&apos;t be reset: if you forget it, nobody can
            open your money, us included. That&apos;s what keeps it yours.
          </p>
        </details>
      </MoneyCard>

      {/* 6a. Recent activity — a compact preview (top 3), straight from the ledger. Honest empty for a
          new account; no invented rows. The full history lives on /activity. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">Recent activity</p>
        {activity === null ? (
          <p className="mt-2 text-sm text-ink-soft">Loading…</p>
        ) : activity.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No money in or out yet. When it moves, you&apos;ll see it here.</p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-line">
            {activity.slice(0, 3).map((a) => (
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
        {activity !== null && activity.length > 0 && (
          <div className="mt-3">
            <Link href="/activity" className="text-sm font-medium text-money underline-offset-2 hover:underline">
              See all activity →
            </Link>
          </div>
        )}
      </MoneyCard>

      {/* 6b. More — the less-frequent controls as compact rows, not a stack of full-height cards:
          the cash-out entry, appearance (a real live theme toggle), language (the honest truth), and
          the human support channel (a real inbox — sponsor /feedback, isolated store). No dead switches. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">More</p>

        {/* Turning dollars into local cash — the honest guide + the real first step. Firing the intent
            event on tap measures off-ramp demand vs. hold-dollars behavior (analyst rec), hashed account.
            /send-out is kept separate from /send: an exchange gets a payment with a reference tag, and a
            wrong tag is how people lose money. */}
        <div className="mt-3 flex items-center justify-between gap-3 border-b border-line pb-3">
          <div>
            <p className="text-sm font-medium text-ink">Turn dollars into cash</p>
            <p className="text-xs text-ink-soft">The honest path to local money, and the one mistake to avoid.</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Link
              href="/cash-out"
              onClick={() => account && void sendEvent("cashout_guide_opened", account.address)}
              className="text-sm font-medium text-money underline-offset-2 hover:underline"
            >
              Guide →
            </Link>
            <Link href="/send-out" className="text-xs text-ink-soft underline-offset-2 hover:underline">
              Send to an exchange
            </Link>
          </div>
        </div>

        {/* Appearance — a live theme toggle (light or dark, follows the phone by default). */}
        <div className="flex items-center justify-between gap-3 border-b border-line py-3">
          <div>
            <p className="text-sm font-medium text-ink">Appearance</p>
            <p className="text-xs text-ink-soft">Light or dark. Follows your phone by default.</p>
          </div>
          <ThemeToggle />
        </div>

        {/* Language — states the truth (English today, more later). No dead switch. */}
        <div className="flex items-center justify-between gap-3 border-b border-line py-3">
          <div>
            <p className="text-sm font-medium text-ink">Language</p>
            <p className="text-xs text-ink-soft">English. More languages are on the way.</p>
          </div>
          <span className="text-sm text-ink-soft">English</span>
        </div>

        {/* The human channel — if something looks wrong or you're stuck, tell us. */}
        <div className="flex items-center justify-between gap-3 pt-3">
          <div>
            <p className="text-sm font-medium text-ink">Need a hand?</p>
            <p className="text-xs text-ink-soft">Something looks wrong, or you&apos;re stuck? Tell us what happened.</p>
          </div>
          <FeedbackDialog trigger={copy.feedback.linkLabel} triggerClassName="fb-trigger-pill" defaultCategory="money" />
        </div>
      </MoneyCard>
    </div>
  );
}
