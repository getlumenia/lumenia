"use client";

/**
 * /sent/[id] — the sender's confirmation + link status (FRONTEND_PLAN §1). Status
 * comes straight from the ledger (Horizon read on the claimable-balance id) — there
 * is no DB. "Copy link again" is served ONLY from the sender's own localStorage: the
 * server never saw the #fragment and must not pretend it can resend the link.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { loadLinkStatus } from "../../../../lib/horizon";
import { recallLink } from "../../../../lib/sent-links";
import { formatUsd } from "../../../../lib/money";
import { netKey } from "../../../../lib/scoped-store";
import { loadV2DropStatus } from "../../../../lib/lumendrop";
import { useWallet } from "../../../../lib/wallet";
import { StatusPill } from "../../../../components/brand/StatusPill";
import { MoneyCard } from "../../../../components/brand/MoneyCard";

interface SentRecord {
  balanceId: string;
  /** false for a pay-to-address send — there is no bearer link to re-copy. */
  hasLink?: boolean;
  amount: string;
  from: string;
  at: string;
  /** who was paid, when this send answered a request straight to their account. */
  toName?: string;
}

function loadSent(id: string): SentRecord | null {
  try {
    const all = JSON.parse(localStorage.getItem(netKey("lumenia.sent")) ?? "{}") as Record<string, SentRecord>;
    return all[id] ?? null;
  } catch {
    return null;
  }
}

export default function SentPage() {
  const { account } = useWallet();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [rec, setRec] = useState<SentRecord | null | undefined>(undefined);
  const [linkStatus, setLinkStatus] = useState<"pending" | "settled" | "loading" | "unknown">("loading");
  const [copied, setCopied] = useState(false);
  // The link is decrypted on demand from the device-key store, not read out of localStorage.
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    const r = loadSent(id);
    setRec(r);
    if (r && account) {
      // Which reader depends on which KIND of link this is, and the id shape is the tell: a classic
      // Claimable Balance id is 72 hex and lives on Horizon; a v2 escrow drop id is the 64-hex link
      // pubkey and lives in the Soroban contract. Asking Horizon about a 64-hex id 400s rather than
      // 404s, so this used to throw on EVERY v2 send and the catch below reported "pending" — every
      // link a sender made read "Still waiting to be claimed" forever, including after it was paid.
      const isV2 = /^[0-9a-f]{64}$/i.test(r.balanceId);
      const read = isV2
        ? loadV2DropStatus(r.balanceId, account.address)
        : loadLinkStatus(r.balanceId);
      void read.then(setLinkStatus).catch(() => setLinkStatus("unknown"));
      if (r.hasLink) void recallLink(id).then(setLink);
    }
  }, [id, account]);

  if (rec === undefined) return <p className="py-10 text-center text-ink-soft">Loading…</p>;

  if (!rec) {
    return (
      <div className="py-16 text-center">
        <h1 className="text-xl font-bold text-ink">Link not found on this device</h1>
        <p className="mt-2 text-ink-soft">
          We only keep your links on the phone you sent them from. They are never stored on a server.
        </p>
        <div className="mt-4 flex flex-col items-center gap-2">
          <Link href="/home" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
            Back to my money
          </Link>
          <Link href="/send" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
            Send a new link
          </Link>
        </div>
      </div>
    );
  }

  async function copyAgain() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <header className="text-center">
        <p className="text-sm text-ink-soft">{rec.toName ? `You paid ${rec.toName}` : "You sent"}</p>
        <p className="text-4xl font-bold tabular-nums text-ink">{formatUsd(rec.amount)}</p>
      </header>

      <div className="flex justify-center">
        {linkStatus === "loading" ? (
          <StatusPill status="waiting" label="Checking…" />
        ) : linkStatus === "pending" ? (
          <StatusPill status="waiting" />
        ) : (
          // The ledger read only says the held money is GONE — for a direct pay
          // that is "collected by them" OR "came back to you after 7 days", and
          // we cannot tell which, so the pill must not claim "Received".
          <StatusPill status="received" label={rec.toName ? "Settled" : "Received"} />
        )}
      </div>

      {linkStatus === "pending" && (
        <MoneyCard className="p-5">
          <p className="text-sm text-ink-soft">
            {rec.toName
              ? `Waiting for ${rec.toName} to add it to their money. If it isn't collected, it comes back to you 7 days after you sent it.`
              : "Still waiting to be claimed. If nobody claims it, the money comes back to you 7 days after you sent it."}
          </p>
          {/* a pay-to-address send has no bearer link — nothing to re-copy */}
          {link && (
            <button
              onClick={copyAgain}
              className="mt-3 h-11 w-full rounded-full border border-line text-sm font-medium text-ink"
            >
              {copied ? "Copied" : "Copy the link again"}
            </button>
          )}
        </MoneyCard>
      )}

      {linkStatus === "settled" && (
        <p className="text-center text-ink-soft">
          {rec.toName
            ? `This is settled. ${rec.toName} collected it, or it came back to you after 7 days. Nothing more to do.`
            : "This money has been received. Nothing more to do."}
        </p>
      )}
    </div>
  );
}
