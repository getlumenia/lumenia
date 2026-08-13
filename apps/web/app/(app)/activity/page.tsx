"use client";

/**
 * /activity — your full money in/out, straight from the ledger (no DB, no-mock). /home shows the
 * most recent few; this is the whole history, derived from Horizon account effects (lib/horizon
 * ::loadActivity). Honest empty state when there's nothing yet.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "../../../lib/wallet";
import { loadActivityForAccounts, loadTotalUsd, type ActivityItem } from "../../../lib/horizon";
import { ActivityRow } from "../../../components/brand/ActivityRow";

export default function ActivityPage() {
  const { status, account, accounts } = useWallet();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!account) return;
    setLoading(true);
    let live = true;
    /* Read every stored account, not just home. A v2 claim lands in a fresh sponsored account, so
       the page billed as the full history was the only one that couldn't see it — /home and
       /account both sum across accounts. */
    void loadTotalUsd(accounts.map((a) => a.address))
      .then((total) =>
        loadActivityForAccounts(
          total.perAccount.map((p) => ({
            address: p.address,
            issuer: p.issuer,
            isHome: p.address === account.address,
          })),
          100,
        ),
      )
      .then((a) => {
        if (live) setItems(a);
      })
      .catch(() => {
        /* A failed read is not an empty history. Rendering "Nothing yet" here tells someone their
           money never moved, which is the one thing this page must never get wrong. */
        if (live) setFailed(true);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [account, accounts]);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;

  if (!account) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-xl font-bold text-ink">No activity yet</h1>
        <p className="max-w-xs text-ink-soft">
          When money comes in or goes out, every movement shows up here, straight from the public
          record.
        </p>
        <Link href="/home" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          Back home
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Activity</h1>
        <p className="mt-1 text-sm text-ink-soft">Every movement, straight from the public record.</p>
      </header>

      {loading && items.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-soft">Loading…</p>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-soft">
          {failed
            ? "We couldn't reach the public record just now. Your money is safe there. Try again in a moment."
            : "Nothing yet. When money comes in or goes out, you'll see it here."}
        </p>
      ) : (
        <div className="rounded-[20px] border border-line bg-surface px-4">
          {items.map((a) => (
            <ActivityRow key={a.id} direction={a.direction} usd={a.usd} at={a.at} />
          ))}
        </div>
      )}
    </div>
  );
}
