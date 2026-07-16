"use client";

/**
 * /activity — your full money in/out, straight from the ledger (no DB, no-mock). /home shows the
 * most recent few; this is the whole history, derived from Horizon account effects (lib/horizon
 * ::loadActivity). Honest empty state when there's nothing yet.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "../../../lib/wallet";
import { loadActivity, type ActivityItem } from "../../../lib/horizon";
import { ActivityRow } from "../../../components/brand/ActivityRow";

export default function ActivityPage() {
  const { status, account } = useWallet();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!account) return;
    setLoading(true);
    let live = true;
    void loadActivity(account.address, 100)
      .then((a) => {
        if (live) setItems(a);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [account]);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;

  if (!account) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-xl font-bold text-ink">No activity yet</h1>
        <p className="max-w-xs text-ink-soft">
          When money comes in or goes out, every movement shows up here — straight from the public
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
          Nothing yet — when money comes in or goes out, you&apos;ll see it here.
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
