"use client";

/**
 * Everything personal on the v1 claim screen: who sent it and how much. Rendered in the browser
 * only, on purpose (D2 private links).
 *
 * Every chat app fetches a pasted link to draw its preview, and so does every bot that follows
 * one. Whatever the server renders for this route lands in all of them, so the server renders a
 * shell (the badge, the layout, a skeleton) and this component fills it in after it mounts:
 *
 *   - the NAME from the link's #fragment (`&s=` behind the key), which no request ever carries;
 *     on a pre-D2 link, from the query `s`, which readClaimQuery believes only on that shape;
 *     otherwise "Someone".
 *   - the AMOUNT from the ledger, by the claimable balance id `b`, never from the URL. A pre-D2
 *     link still carries `?a=`, and anyone forwarding a link can edit it, so it is not read at all.
 *     The read is three-valued (lib/horizon.ts loadClaimableAmount) and pinned to the dollar the
 *     claim itself accepts, and while this link still holds its key, to a balance that key can
 *     actually claim, which is what "Verified on the ledger" is allowed to mean.
 *
 * Nothing here takes a name or an amount as a prop: props of a client component are serialised
 * into the server's HTML payload, which is exactly where neither may be.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Keypair } from "@stellar/stellar-sdk";
import { copy } from "../../../lib/copy";
import { loadClaimableAmount, type ClaimableAmount } from "../../../lib/horizon";
import { parseClaimFragment, readClaimQuery } from "../../../lib/link-fragment";
import { formatUsd, usdToTryIndicative } from "../../../lib/money";
import { resolveNetwork } from "../../../lib/network";
import { PersonChip } from "../../../components/brand/PersonChip";
import ClaimButton from "./ClaimButton";

/* Pinned to the test network for the same reason ClaimButton pins it: a v1 link was minted there
 * and its money is there, whatever this device is switched to. */
const CLAIM_NETWORK = resolveNetwork(null);
/* About half a minute of looks, 3 s apart; the honest line after the third. */
const AMOUNT_ATTEMPTS = 10;
const AMOUNT_RETRY_MS = 3_000;
const AMOUNT_SETTLE_AFTER = 3;

interface LinkParts {
  name: string;
  /** The public key of the link's bearer secret, when the fragment still holds a valid one. */
  claimant?: string;
}

function readLinkParts(): LinkParts {
  const fragment = parseClaimFragment(window.location.hash);
  const name = fragment.from ?? readClaimQuery(window.location.search).queryName ?? "Someone";
  let claimant: string | undefined;
  try {
    claimant = fragment.key ? Keypair.fromSecret(fragment.key).publicKey() : undefined;
  } catch {
    claimant = undefined; // not a secret key: the claim will say so; the amount is read unbound
  }
  return { name, claimant };
}

export default function ClaimView({
  claimId,
  balanceId,
  rate,
}: {
  claimId: string;
  balanceId: string;
  /** USD to TRY reference rate, read on the server. A number about the market, not the link. */
  rate: number;
}) {
  const parts = useRef<LinkParts | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [amount, setAmount] = useState<ClaimableAmount | null>(null);

  /* A LAYOUT effect, because ClaimButton strips the #fragment in its passive effect, and React runs
   * every layout effect of a commit before any passive one: the name and the key are read here
   * before the strip, whatever order the two components sit in. Read once into a ref, so a remount
   * (React's development double run, after the strip) keeps what the first run saw instead of
   * falling back to "Someone". */
  useLayoutEffect(() => {
    if (!parts.current) parts.current = readLinkParts();
    setName(parts.current.name);
  }, []);

  /* Asked again while there is no figure: /try, /event and the nightly regression open a link seconds
     after the balance was created, and a Horizon node that has not ingested it yet answers 404. The
     honest line shows only after AMOUNT_SETTLE_AFTER looks, and a later figure still replaces it. */
  useEffect(() => {
    let live = true;
    void (async () => {
      for (let attempt = 0; attempt < AMOUNT_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, AMOUNT_RETRY_MS));
        if (!live) return;
        const read = await loadClaimableAmount(balanceId, CLAIM_NETWORK, { claimant: parts.current?.claimant });
        if (!live) return;
        if (read.state === "amount") {
          setAmount(read);
          return;
        }
        if (attempt + 1 >= AMOUNT_SETTLE_AFTER) setAmount(read);
      }
    })();
    return () => {
      live = false;
    };
  }, [balanceId]);

  return (
    <>
      {name === null ? (
        // Same footprint as the chip and the line below, so nothing jumps when they fill in.
        <>
          <span aria-hidden className="block size-14 rounded-full bg-secondary" />
          <p aria-hidden className="text-xl text-ink-soft">
            <span className="inline-block h-[1em] w-48 rounded-full bg-secondary align-middle motion-safe:animate-pulse" />
          </p>
        </>
      ) : (
        <>
          <PersonChip name={name} size="lg" nameless joyRing />
          <p className="text-xl text-ink-soft">{copy.claim.youReceived(name)}</p>
        </>
      )}

      {/* value-first: the money, huge, tabular, as soon as the ledger says what it is */}
      <div aria-live="polite" aria-busy={amount === null} className="flex flex-col items-center gap-2">
        {amount === null ? (
          <div className="flex h-14 items-center">
            <p className="text-sm text-ink-soft motion-safe:animate-pulse">Reading the amount from the ledger</p>
          </div>
        ) : amount.state === "amount" ? (
          <>
            <div className="text-[3.5rem] font-bold leading-none tracking-tight tabular-nums text-money">
              {formatUsd(amount.usd)}
            </div>
            <p className="text-sm font-medium text-ink-soft">Verified on the ledger</p>
            <p className="text-sm text-ink-soft">
              {"\u2248"} {usdToTryIndicative(amount.usd, rate)} <span className="opacity-70">indicative</span>
            </p>
          </>
        ) : amount.state === "gone" ? (
          /* No amount, and no verdict either: whether THIS person already has it is the claim's to
             say (the tap answers "You already have this money" when they do). */
          <p className="text-base text-ink-soft">
            This money isn&apos;t showing on the ledger right now. It may have been claimed already, or gone back to the sender.
          </p>
        ) : (
          <p className="text-base text-ink-soft">We couldn&apos;t verify the amount on the ledger.</p>
        )}
      </div>

      {/* The v2 claim page's line, word for word. It replaces "No app, no sign-up - just tap.",
          which said the same thing minus the part that matters most to the person reading it:
          the network cost is the sponsor's, not theirs. */}
      <p className="mt-1 text-sm font-medium text-ink">No app. No wallet. You pay nothing.</p>

      <div className="mt-4 w-full">
        <ClaimButton claimId={claimId} balanceId={balanceId} sender={name ?? "Someone"} />
      </div>
    </>
  );
}
