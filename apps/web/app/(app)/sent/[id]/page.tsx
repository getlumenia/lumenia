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
import { loadPool, loadV2DropStatus, type PoolState } from "../../../../lib/lumendrop";
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
  /**
   * How many equal shares this link holds, present only on a GROUP link (/group), where `amount`
   * is the whole pot. It is what makes every later read ask `get_pool`: a pool has no `get_drop`
   * record at all, so without it the link reads as settled the instant it is created.
   */
  slots?: number;
  /** Set by /notifications when the sender took the leftover back on THIS device. */
  tookBackUsd?: string;
}

/**
 * A group link's closing time in this phone's own words. Deliberately a local copy of the one on
 * /group rather than a shared export: it only ever runs client-side, after the record has loaded,
 * and the two screens are free to word their deadline differently without dragging a lib file
 * (and its self-test) into a screen change.
 */
function closingLabel(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  /** A group link's pot, as the escrow has it. Null until a read lands, and never guessed at. */
  const [pool, setPool] = useState<PoolState | null>(null);

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
    /* A GROUP link is a Pool, and a Pool has no `get_drop` record at all, so the flag is what
       stops the reader asking the wrong view, finding nothing, and reporting money that is still
       on the link as received. The local record is the only place the share count lives. */
    const group = typeof r.slots === "number";
    const read = isV2 && account
      ? loadV2DropStatus(r.balanceId, account.address, { group })
      : loadLinkStatus(r.balanceId);
    void read.then(setLinkStatus).catch(() => setLinkStatus("unknown"));
    // The counts come from the escrow itself, never from the local record: how many shares went is
    // the one thing this device cannot know on its own.
    if (isV2 && account && group) {
      void loadPool(r.balanceId, { sourceAccount: account.address })
        .then(setPool)
        .catch(() => {
          /* a read we could not finish shows no count at all, rather than a stale one */
        });
    }
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

  /* A GROUP LINK IS ITS OWN SCREEN. The same record means different things: `amount` is the pot
     rather than one payment, "claimed" is a count rather than a flag, and the closing time is the
     only moment the leftover can come back. Every figure below comes from `get_pool`; none of them
     is derived from the pot minus what is left, because the deployed Pool struct carries no pot to
     derive from and `reclaim_pool` marks every slot claimed as it closes. */
  if (typeof rec.slots === "number") {
    const unread = linkStatus === "unknown" || linkStatus === "no-account";
    return (
      <div className="flex flex-col gap-4 py-4">
        <header className="text-center">
          <p className="text-sm text-ink-soft">You put in</p>
          <p className="text-4xl font-bold tabular-nums text-ink">{formatUsd(rec.amount)}</p>
          {pool && (
            <p className="mt-1 text-sm text-ink-soft">
              {pool.slots} shares of {formatUsd(pool.perShare)}
            </p>
          )}
        </header>

        <div className="flex justify-center">
          {pool === null ? (
            <StatusPill
              status="waiting"
              label={
                linkStatus === "loading"
                  ? "Checking…"
                  : linkStatus === "no-account"
                    ? "Can't check on this device"
                    : "Couldn't check just now"
              }
            />
          ) : pool.status === "open" ? (
            <StatusPill status="waiting" label="Open for shares" />
          ) : pool.status === "full" ? (
            <StatusPill status="received" label="Every share taken" />
          ) : pool.status === "expired" ? (
            <StatusPill status="waiting" label="Closed, money to take back" />
          ) : (
            <StatusPill status="returned" label="Closed" />
          )}
        </div>

        <MoneyCard className="p-5">
          {pool === null ? (
            <p className="text-sm text-ink-soft">
              {linkStatus === "no-account"
                ? "We can't check this one on this device: that check runs from your account, and there isn't one on this phone right now. It doesn't change the money. Whatever nobody takes is still yours to take back once the link closes."
                : unread
                  ? "We couldn't read this link just now. That's about the connection, not your money, and nothing about it has changed. Open this again in a moment."
                  : "Checking the link…"}
            </p>
          ) : pool.status === "open" ? (
            <p className="text-sm text-ink">
              {pool.taken} of {pool.slots} taken. {formatUsd(pool.remaining)} still on the link. It
              closes at {closingLabel(pool.expiry)}, and whatever nobody takes comes back to you
              then, and not before.
            </p>
          ) : pool.status === "full" ? (
            <p className="text-sm text-ink">
              All {pool.slots} shares have been taken. Nothing is left on this link.
            </p>
          ) : pool.status === "expired" ? (
            <p className="text-sm text-ink">
              {pool.taken} of {pool.slots} taken. It closed at {closingLabel(pool.expiry)} and{" "}
              {formatUsd(pool.remaining)} is still on it. That part is yours to take back.
            </p>
          ) : rec.tookBackUsd ? (
            /* Said only on the phone that did it. A closed pool reads with every slot claimed
               whether the shares went to people or the leftover went home, so the ledger alone
               cannot tell these apart, this device can, because it made the take-back. */
            <p className="text-sm text-ink">
              You took back {formatUsd(rec.tookBackUsd)}. The link is closed.
            </p>
          ) : (
            <p className="text-sm text-ink">
              This link is closed. Nothing more can be taken from it, and nothing more can come back.
            </p>
          )}

          {/* Sharing again only while there is still a share to take. */}
          {link && pool?.status === "open" && (
            <button
              onClick={copyAgain}
              className="mt-3 h-11 w-full rounded-full border border-line text-sm font-medium text-ink"
            >
              {copied ? "Copied" : "Copy the link again"}
            </button>
          )}
          {pool?.status === "expired" && (
            <Link
              href="/notifications"
              className="mt-3 block text-sm font-semibold text-money underline-offset-2 hover:underline"
            >
              Take back what&apos;s left →
            </Link>
          )}
        </MoneyCard>

        <p className="text-xs text-ink-soft">
          What the ledger holds this link to: at most {rec.slots} shares, exactly the same amount
          each, only to an address the link signs for, and nothing after it closes. It counts
          addresses, not people.
        </p>
      </div>
    );
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
