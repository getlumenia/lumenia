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
  const { status, account } = useWallet();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [rec, setRec] = useState<SentRecord | null | undefined>(undefined);
  // "unknown" is a read that FAILED; "no-account" is a read that was never possible on this
  // device. Same non-claim about the money, different truth to tell — and neither may ever fall
  // through to the settled branch below.
  const [linkStatus, setLinkStatus] = useState<"pending" | "settled" | "loading" | "unknown" | "no-account">("loading");
  const [copied, setCopied] = useState(false);
  // The link is decrypted on demand from the device-key store, not read out of localStorage.
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    const r = loadSent(id);
    setRec(r);
    if (!r) return;
    if (status !== "ready") return; // the wallet is still resolving; nothing is settled yet
    // The stored link is device-local — recallable whether or not this device still carries an
    // account, which is why it no longer sits behind one.
    if (r.hasLink) void recallLink(id).then(setLink);
    // Which reader depends on which KIND of link this is, and the id shape is the tell: a classic
    // Claimable Balance id is 72 hex and lives on Horizon; a v2 escrow drop id is the 64-hex link
    // pubkey and lives in the Soroban contract. Asking Horizon about a 64-hex id 400s rather than
    // 404s, so this used to throw on EVERY v2 send and the catch below reported "pending" — every
    // link a sender made read "Still waiting to be claimed" forever, including after it was paid.
    const isV2 = /^[0-9a-f]{64}$/i.test(r.balanceId);
    // Only the contract read needs an account to simulate from; Horizon answers on its own. The
    // whole read used to sit behind `account`, so a device carrying none sat on "Checking…" with
    // nothing on the way that could ever finish it.
    if (isV2 && !account) {
      setLinkStatus("no-account");
      return;
    }
    const read = isV2 && account
      ? loadV2DropStatus(r.balanceId, account.address)
      : loadLinkStatus(r.balanceId);
    void read.then(setLinkStatus).catch(() => setLinkStatus("unknown"));
  }, [id, account, status]);

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
        ) : linkStatus === "unknown" || linkStatus === "no-account" ? (
          // A read that did not complete is not evidence of anything. Both readers return
          // "unknown" so an outage can never be mistaken for settlement; this branch is what
          // keeps that promise, and its absence told senders their unclaimed link was paid.
          <StatusPill
            status="waiting"
            label={linkStatus === "no-account" ? "Can't check on this device" : "Couldn't check just now"}
          />
        ) : (
          // The ledger read only says the held money is GONE — for a direct pay
          // that is "collected by them" OR "came back to you after 7 days", and
          // we cannot tell which, so the pill must not claim "Received".
          <StatusPill status="received" label={rec.toName ? "Settled" : "Received"} />
        )}
      </div>

      {/* Neither unreadable state loses the copy button: a link we could not read may well still be
          live, and the sender is the only person who can share it again. */}
      {(linkStatus === "pending" || linkStatus === "unknown" || linkStatus === "no-account") && (
        <MoneyCard className="p-5">
          <p className="text-sm text-ink-soft">
            {linkStatus === "no-account"
              ? "We can't check this one on this device — that check runs from your account, and there isn't one on this phone right now. It doesn't change the money: if it isn't collected, it comes back to you 7 days after you sent it. Bring your account back onto this phone and this page can tell you where it stands."
              : linkStatus === "unknown"
                ? "We couldn't check on this one just now — that's about the connection, not your money. Nothing about it has changed: if it isn't collected, it comes back to you 7 days after you sent it. Open this again in a moment."
                : rec.toName
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
