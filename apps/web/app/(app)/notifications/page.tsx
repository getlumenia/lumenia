"use client";

/**
 * /notifications — every item DERIVED from the public ledger (lib/notifications), not a server feed:
 * money waiting to be collected + money that already arrived. Opening the page marks them seen (local
 * only), which clears the nav bell's unread dot. Collecting a waiting item goes through the SAME
 * unchanged /feebump claim policy /home uses.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../lib/wallet";
import { loadNotices, markAllSeen, type Notice } from "../../../lib/notifications";
import { loadLinkStatus } from "../../../lib/horizon";
import { collectIncoming } from "../../../lib/claim";
import { reclaimV2 } from "../../../lib/lumendrop";
import { formatUsd } from "../../../lib/money";
import { copy } from "../../../lib/copy";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";
import { FeedbackDialog } from "../../../components/FeedbackDialog";

const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.vercel.app";

function whenText(iso: string): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function NotificationsPage() {
  const { status, account, getSigner } = useWallet();
  const router = useRouter();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(false);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    if (!account) return;
    const list = await loadNotices(account.address);
    setNotices(list);
    markAllSeen(list.map((n) => n.id)); // opening the page clears the unread dot
  }, [account]);

  useEffect(() => {
    if (!account) return;
    setLoading(true);
    let live = true;
    void reload().finally(() => {
      if (live) setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [account, reload]);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;

  if (!account) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-xl font-bold text-ink">Nothing here yet</h1>
        <p className="max-w-xs text-ink-soft">
          When money arrives or is waiting for you, you&apos;ll see it here — straight from the public
          record.
        </p>
        <Link href="/home" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          Back home
        </Link>
      </div>
    );
  }

  async function recover(n: Notice) {
    if (!n.balanceId) return;
    setError("");
    setCollectingId(n.id);
    try {
      let signer;
      try {
        signer = await getSigner();
      } catch {
        router.push("/unlock?next=/notifications");
        return;
      }
      // A v2 drop comes back via the contract reclaim (/v2-reclaim); a classic CB (waiting or
      // a classic reclaimable send) via the /feebump claim — collectIncoming handles both.
      if (n.kind === "reclaimable" && n.via === "v2") {
        await reclaimV2({ signer, linkHex: n.balanceId, sponsorUrl: SPONSOR_URL });
      } else {
        await collectIncoming({ sponsorUrl: SPONSOR_URL, signer, balanceId: n.balanceId });
      }
      await reload();
    } catch {
      // Terminal (already collected / reclaimed) vs. transient — never leak a result code.
      // For a classic CB, re-read existence for calm "it's gone" copy; a v2 drop just refreshes.
      if (n.via === "v2") {
        setError(copy.errors.generic);
        await reload();
      } else {
        try {
          if ((await loadLinkStatus(n.balanceId)) === "settled") {
            setError(copy.errors.collectGone);
            await reload();
          } else {
            setError(copy.errors.generic);
          }
        } catch {
          setError(copy.errors.generic);
        }
      }
    } finally {
      setCollectingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Notifications</h1>
        <p className="mt-1 text-sm text-ink-soft">Money in, waiting, and coming back to you — from the public record.</p>
      </header>

      {loading && notices.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-soft">Loading…</p>
      ) : notices.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-soft">
          Nothing yet — when money arrives, you&apos;ll see it here.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {notices.map((n) => (
            <MoneyCard key={n.id} className="flex items-center gap-3 p-4">
              <div className="flex-1">
                <p className="font-semibold text-ink">
                  {n.kind === "waiting"
                    ? copy.waiting.row(formatUsd(n.usd))
                    : n.kind === "reclaimable"
                      ? copy.recover.row(formatUsd(n.usd))
                      : `You received ${formatUsd(n.usd)}`}
                </p>
                {n.kind === "reclaimable" ? (
                  <p className="text-xs text-ink-soft">{copy.recover.hint}</p>
                ) : n.at ? (
                  <p className="text-xs text-ink-soft">{whenText(n.at)}</p>
                ) : null}
              </div>
              {(n.kind === "waiting" || n.kind === "reclaimable") && n.balanceId && (
                <div className="shrink-0">
                  <PrimaryButton
                    loading={collectingId === n.id}
                    disabled={collectingId !== null && collectingId !== n.id}
                    loadingLabel={n.kind === "reclaimable" ? copy.recover.taking : copy.waiting.collecting}
                    onClick={() => recover(n)}
                  >
                    {n.kind === "reclaimable" ? copy.recover.take : copy.waiting.collect}
                  </PrimaryButton>
                </div>
              )}
            </MoneyCard>
          ))}
        </div>
      )}
      {error && (
        <p className="text-sm text-danger">
          {error}{" "}
          <FeedbackDialog trigger={copy.feedback.somethingWrong} triggerClassName="fb-trigger-inline" defaultCategory="money" />
        </p>
      )}
    </div>
  );
}
