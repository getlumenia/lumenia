"use client";

/**
 * /home — the logged-in root + north-star surface (FRONTEND_PLAN §1). Real Horizon
 * reads only (no-mock-data): the balance you hold + your money in/out, in human
 * tense. Honest empty states. No seed ever touches this page — it reads only the
 * public address from the WalletProvider (signing for "collect" goes through
 * getSigner, the same seam /send uses).
 *
 * "Money waiting for you" is the returning asker's half of request money
 * (REQUEST_MONEY.md §10): a paid request arrives as a Claimable Balance whose
 * unconditional claimant is THIS address; collecting it is a bare claim through
 * the unchanged /feebump policy (Spike #6). It also catches any future transfer
 * sent straight to the address — the section is about the money, not the feature.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Split } from "lucide-react";
import { useWallet } from "../../../lib/wallet";
import { loadBalance, loadActivityForAccounts, loadIncomingClaims, loadLinkStatus, loadTotalUsd, type ActivityItem, type IncomingClaim } from "../../../lib/horizon";
import { collectIncoming } from "../../../lib/claim";
import { sweepIntoHome } from "../../../lib/sweep";
import { unlockPhase1, removeAccount, isPublished } from "../../../lib/keystore";
import { indicativeRate, getLiveRate } from "../../../lib/rate";
import { formatUsd } from "../../../lib/money";
import { BalanceHeader } from "../../../components/brand/BalanceHeader";
import { ActivityRow } from "../../../components/brand/ActivityRow";
import { LockMoneyCard } from "../../../components/brand/LockMoneyCard";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";
import { FeedbackDialog } from "../../../components/FeedbackDialog";
import { copy } from "../../../lib/copy";
import { sendEvent } from "../../../lib/events";

const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";

/** The home dashboard's primary actions — each a soft-3D brand icon, each a real destination.
 *  (Activity + Account live in the top nav; these are the money verbs.) */
const ACTIONS: Array<{ href: string; label: string; icon: string }> = [
  { href: "/send", label: "Send", icon: "/brand-kit-assets/icon-send.webp" },
  { href: "/request", label: "Ask", icon: "/brand-kit-assets/icon-hand.webp" },
  { href: "/contacts", label: "People", icon: "/brand-kit-assets/icon-contacts.webp" },
];

export default function HomePage() {
  const { status, account, accounts, getSigner, refresh: refreshWallet } = useWallet();
  const router = useRouter();
  const [usd, setUsd] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [waiting, setWaiting] = useState<IncomingClaim[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [collectError, setCollectError] = useState("");
  // The ₺ line upgrades from the labeled fallback constant to the real ECB
  // reference rate when the fetch lands (lib/rate.ts). Still shown "indicative".
  const [rate, setRate] = useState(indicativeRate());

  useEffect(() => {
    let alive = true;
    void getLiveRate().then((r) => {
      if (alive && r.live) setRate(r.rate);
    });
    return () => {
      alive = false;
    };
  }, []);

  const reload = useCallback(async () => {
    if (!account) return;
    // ONE total = the SUM across EVERY stored account (home + any not-yet-swept
    // throwaway), read from Horizon. The user never sees "account 1 / account 2" —
    // even money stuck in a throwaway a sweep couldn't move still shows in the total,
    // so nothing is ever hidden or lost (RECOVERY_ARCHITECTURE §3.1).
    const addresses = accounts.length > 0 ? accounts.map((a) => a.address) : [account.address];
    const total = await loadTotalUsd(addresses);
    setUsd(total.usd);
    // Activity follows the SAME account set as the total. Reading only home meant money paid
    // straight to a not-yet-swept per-link account raised the balance and showed no movement at
    // all — the balance said $20 and the list said nothing had happened. Each account's issuer
    // comes from its own trustline, so a look-alike token can never pose as money.
    setActivity(
      await loadActivityForAccounts(
        total.perAccount.map((p) => ({ address: p.address, issuer: p.issuer, isHome: p.address === account.address })),
      ),
    );
    // The home trustline's own issuer pins the exact asset — a look-alike token can't
    // pose as money waiting. No trustline yet → nothing to collect into.
    const home = total.perAccount.find((p) => p.address === account.address);
    setWaiting(home?.issuer ? await loadIncomingClaims(account.address, home.issuer) : []);
  }, [account, accounts]);

  useEffect(() => {
    if (!account) return;
    setLoadingData(true);
    let live = true;
    void reload().finally(() => {
      if (live) setLoadingData(false);
    });
    return () => {
      live = false;
    };
  }, [account, reload]);

  // Silent auto-consolidation (RECOVERY_ARCHITECTURE §3.2 / §6.2, proven by Spike #7).
  // Each incoming link claims into its OWN throwaway account; here we sweep every
  // non-home account that has money waiting into the ONE home account and close it.
  // Best-effort: never blocks render, and if a sweep fails the money is STILL safe in
  // the throwaway (it keeps counting in the total above) — we just leave it and retry
  // next load. No seed touches React state: unlock → sweep → wipe, all local.
  useEffect(() => {
    if (!account || accounts.length <= 1) return;
    const home = account.address;
    const others = accounts.filter((a) => a.address !== home);
    if (others.length === 0) return;

    let cancelled = false;
    void (async () => {
      setConsolidating(true);
      let sweptAny = false;
      for (const other of others) {
        if (cancelled) break;
        try {
          // NEVER sweep an address the user has handed to somebody else. The sweep ends in
          // accountMerge, which CLOSES the account on-chain; an exchange withdrawal already on
          // its way to it would bounce off an account that no longer exists. Publishing is
          // recorded locally by /add-money (keystore.markPublished).
          if (await isPublished(other.address)) continue;
          // Drive off the USDC BALANCE: the frozen /c/[id] route already claimed the
          // incoming CB into the throwaway, so the money sits as plain USDC (no open
          // CB) — the production bug case. Sweep that balance home with the claim-less
          // 3-op path.
          const bal = await loadBalance(other.address);
          const issuer = bal?.issuer;
          const amount = bal?.usd ?? "0";
          if (!issuer || Number.parseFloat(amount) <= 0) continue; // empty husk → leave it
          // If the throwaway still has an OPEN incoming CB (e.g. a claim that failed
          // after account-creation), claim it first (4-op path). Otherwise omit
          // balanceId for the claim-less sweep.
          const cbs = await loadIncomingClaims(other.address, issuer);
          const balanceId = cbs[0]?.balanceId;
          const seed = await unlockPhase1(other.address);
          try {
            // The sweep wipes its own COPY of the seed on success; ours stays intact
            // and is wiped below.
            await sweepIntoHome({
              sponsorUrl: SPONSOR_URL,
              throwawaySeed: seed.slice(),
              homePublicKey: home,
              amount,
              ...(balanceId ? { balanceId } : {}),
            });
            sweptAny = true;
          } finally {
            seed.fill(0);
          }
          // The accountMerge in the sweep closed the throwaway on-chain → drop its
          // record too. removeAccount refuses to touch home, so this is safe.
          await removeAccount(other.address);
        } catch (e) {
          if (process.env.NODE_ENV !== "production") {
            // eslint-disable-next-line no-console
            console.warn("[home] consolidation skipped an account (money is still safe):", (e as Error).message);
          }
        }
      }
      if (!cancelled) {
        if (sweptAny) {
          await refreshWallet(); // drop the removed accounts from the wallet's list
          await reload(); // re-sum the total now that everything is in home
        }
        setConsolidating(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // reload/refreshWallet are stable-enough deps; keyed on the account set so it
    // re-runs after a sweep removes an account (and settles when none remain).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, accounts]);

  if (status === "loading") {
    return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  }

  // No local account yet — honest empty (someone must send you a link first),
  // plus the one thing a person with no money CAN do here: ask for some.
  if (!account) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-xl font-bold text-ink">No money here yet</h1>
        <p className="max-w-xs text-ink-soft">
          When someone sends you money with a link, you claim it and it shows up here.
        </p>
        <Link
          href="/request"
          className="mt-2 flex h-12 items-center justify-center rounded-full bg-money px-6 text-sm font-semibold text-primary-foreground"
        >
          {copy.claim.ctaRequest}
        </Link>
        {/* A first-timer who deep-linked here needs a path INTO the product, not a wall. */}
        <Link href="/try" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          See how receiving works
        </Link>
        <Link href="/how-it-works" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          See how it works
        </Link>
        <Link href="/claimed" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          What is this?
        </Link>
      </div>
    );
  }

  async function collect(balanceId: string) {
    setCollectError("");
    setCollectingId(balanceId);
    try {
      let signer;
      try {
        signer = await getSigner();
      } catch {
        router.push("/unlock?next=/home");
        return;
      }
      await collectIncoming({ sponsorUrl: SPONSOR_URL, signer, balanceId });
      await reload();
    } catch {
      // Terminal vs. transient, by re-reading whether the balance still exists —
      // never leak a Horizon result code (vocabulary law). Gone = already collected
      // or reclaimed → say so calmly + refresh so the stale item disappears.
      try {
        if ((await loadLinkStatus(balanceId)) === "settled") {
          setCollectError(copy.errors.collectGone);
          await reload();
        } else {
          setCollectError(copy.errors.generic);
        }
      } catch {
        setCollectError(copy.errors.generic);
      }
    } finally {
      setCollectingId(null);
    }
  }

  const tryValue = Number.parseFloat(usd ?? "0") * rate;

  return (
    <div className="flex flex-col gap-5">
      <BalanceHeader usd={usd ?? "0"} tryValue={tryValue} phase={account.phase} />

      {/* Silent consolidation — an honest one-liner while incoming money from other
          links is being merged into this one balance. Never an error surface; if a
          sweep can't complete, the money simply stays counted in the total above. */}
      {consolidating && (
        <p className="text-center text-sm text-ink-soft">Bringing your money together…</p>
      )}

      {/* Money waiting to be collected — a paid request, or any transfer straight
          to this account. Renders only when real money is actually waiting. */}
      {waiting.length > 0 && (
        <MoneyCard className="p-5">
          <p className="font-semibold text-ink">{copy.waiting.title}</p>
          <div className="mt-2 flex flex-col gap-3">
            {waiting.map((w) => (
              <div key={w.balanceId} className="flex items-center justify-between gap-3">
                <p className="text-sm text-ink-soft">{copy.waiting.row(formatUsd(w.usd))}</p>
                <div className="shrink-0">
                  {/* One collect at a time: two in flight would build on the same
                      account sequence number and the second always fails. */}
                  <PrimaryButton
                    loading={collectingId === w.balanceId}
                    disabled={collectingId !== null && collectingId !== w.balanceId}
                    loadingLabel={copy.waiting.collecting}
                    onClick={() => collect(w.balanceId)}
                  >
                    {copy.waiting.collect}
                  </PrimaryButton>
                </div>
              </div>
            ))}
          </div>
          {collectError && (
            <p className="mt-2 text-sm text-danger">
              {collectError}{" "}
              <FeedbackDialog trigger={copy.feedback.somethingWrong} triggerClassName="fb-trigger-inline" defaultCategory="money" />
            </p>
          )}
        </MoneyCard>
      )}

      {/* Primary actions — a soft-3D icon tile each (the brand icon set, in the screens it was drawn
          for). Every tile goes to a surface that exists; no mock actions. */}
      <nav className="app-actions">
        {ACTIONS.map((a) => (
          <Link key={a.href} href={a.href} className="app-action">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.icon} alt="" width={46} height={46} />
            <span>{a.label}</span>
          </Link>
        ))}
      </nav>

      {/* Split — a request-money composition (one link per person). A quiet entry, not a big tile. */}
      <Link
        href="/split"
        className="flex items-center gap-3 rounded-[16px] border border-line bg-surface px-4 py-3 transition-colors hover:border-money/40"
      >
        <span className="grid size-9 place-items-center rounded-full bg-secondary text-money">
          <Split className="size-4" />
        </span>
        <span className="flex-1 text-sm font-semibold text-ink">Split a bill</span>
        <span className="text-ink-soft">→</span>
      </Link>

      {account.phase === 1 && <LockMoneyCard />}

      {/* Activity — the most recent few; the full history lives on /activity. */}
      <section>
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-ink-soft">Activity</h2>
          {activity.length > 0 && (
            <Link href="/activity" className="text-xs font-semibold text-money underline-offset-2 hover:underline">
              See all
            </Link>
          )}
        </div>
        {loadingData && activity.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-soft">Loading…</p>
        ) : activity.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-soft">
            No activity yet. Send your first link.
          </p>
        ) : (
          <div className="rounded-[20px] border border-line bg-surface px-4">
            {activity.slice(0, 5).map((a) => (
              <ActivityRow key={a.id} direction={a.direction} usd={a.usd} at={a.at} />
            ))}
          </div>
        )}
      </section>

      {/* Cash-out — the first leg is now a real step (/send-out), so this card carries
          actions instead of a "coming soon" note. Lumenia still never converts to lira;
          that stays a licensed exchange's job, which the copy keeps saying. Reachable
          from here as well as /account: someone looking at their balance and wanting
          cash shouldn't have to find a settings screen first. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">{copy.cashOut.title}</p>
        <p className="mt-1 text-sm text-ink-soft">{copy.cashOut.liveRow}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {/* Inbound sits beside outbound rather than in the action tiles above: on the test
              network an exchange deposit cannot arrive, and a hero tile would promise more than
              the product can do. It becomes a tile on the mainnet cut. */}
          <Link
            href="/add-money"
            className="inline-flex h-10 items-center rounded-full border border-money px-4 text-sm font-medium text-money"
          >
            {copy.receive.title}
          </Link>
          <Link
            href="/send-out"
            className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-medium text-ink"
          >
            {copy.cashOut.sendOutCta}
          </Link>
          <Link
            href="/cash-out"
            onClick={() => account && void sendEvent("cashout_guide_opened", account.address)}
            className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-medium text-ink"
          >
            {copy.cashOut.guideCta}
          </Link>
        </div>
      </MoneyCard>
    </div>
  );
}
