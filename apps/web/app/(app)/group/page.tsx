"use client";

/**
 * /group - one link that holds a POT of equal shares, instead of one payment to one person.
 *
 * Same escrow, same relayer, same fee-bump as an ordinary money link: the sender signs one
 * `create_drop` invoke and the sponsor pays for it, so the sender needs no XLM and neither does
 * anybody who takes a share. What changes is the shape of the record - a Pool of N equal shares
 * instead of a single Drop - and therefore what this screen has to be careful about.
 *
 * THE FORM ENFORCES WHAT THE SPONSOR ENFORCES, on purpose. Both bounds below (the share count and
 * the size of the pot) are refused again by the relay after the sender has already signed. A
 * refusal at that point is a person watching a wallet prompt succeed and the product fail, with
 * their money untouched but no way to tell from the screen - so the same limits are checked here,
 * before anything is asked of them, and named in the sentence.
 *
 * WHAT THIS SCREEN MAY NOT SAY. The contract keys a share to the PAYOUT ADDRESS, and Lumenia mints
 * a fresh address for every walletless claim, so no ledger rule anywhere makes this one share per
 * person. What the ledger does guarantee is worth saying plainly, and is: at most N shares, exactly
 * the same amount each, only to an address the link signed for, and nothing after the deadline.
 * The shared word keeps the link inside the group; it is not a headcount either.
 *
 * PRACTICE NETWORK ONLY, and the route still renders on real money rather than 404ing, with the
 * button off and the reason stated. Each share claimed opens a fresh sponsored account (about 1.5
 * XLM of reserve that nothing returns), so a full pot is a large bite out of a float measured in
 * tens of onboardings - and the per-transfer cap binds the POT, not the share, so a small pool
 * passes it cleanly. `createV2GroupLink` refuses mainnet itself and so does the sponsor relay; this
 * is the half a person sees.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../lib/wallet";
import { isNeedsPassword } from "../../../lib/signer-error";
import { loadTotalUsd } from "../../../lib/horizon";
import { getTestMoney } from "../../../lib/receive";
import {
  createV2GroupLink,
  groupTotal,
  v2DepositLanded,
  DepositUncertainError,
  MAX_POOL_SLOTS,
  maxPoolSlots,
  MAINNET_MAX_POOL_SLOTS,
  MIN_POOL_SLOTS,
} from "../../../lib/lumendrop";
import { claimPasswordProblem } from "../../../lib/claim-password";
import { sendEvent } from "../../../lib/events";
import { formatUsd, sanitizeAmountInput } from "../../../lib/money";
import { netKey } from "../../../lib/scoped-store";
import { activeNetwork } from "../../../lib/network";
import { handleOf } from "../../../lib/handles";
import { rememberLink } from "../../../lib/sent-links";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";
import { LinkReadyCard } from "../../../components/brand/LinkReadyCard";

/** The sponsor for the network this device is ACTUALLY on, read at call time, never at import. */
function sponsorUrl(): string {
  return activeNetwork().sponsorUrl;
}

/**
 * The whole pot's ceiling, mirroring MAX_DROP_USDC on the Worker this device talks to (default
 * [vars] in apps/sponsor/wrangler.toml). The cap binds the POT rather than the share, which is the
 * right thing to bind, and the relay applies it whatever this form says, so the number lives in
 * one env var and the form only stops a person reaching a refusal the hard way.
 */
const POT_CAP_TESTNET_USD = process.env.NEXT_PUBLIC_MAX_DROP_USDC ?? "100";
/* REAL MONEY: the mainnet Worker runs the pilot's per-transfer cap, and it binds the POT, so a
   pool is capped at the same figure a single send is. Same env var the /pilot screen shows. */
const POT_CAP_MAINNET_USD = process.env.NEXT_PUBLIC_PILOT_TX_CAP_USD ?? "5";

/** The relay refuses a pot whose SHARE falls below this, and it is applied per share, not per pot. */
const MIN_SHARE_USD = 0.01;

/** How long a signed deposit stays includable, when the failure did not name its own bound. */
const RETRY_SAFE_AFTER_MS = 150_000;

type Closing = "practice" | "tonight" | "day" | "week";

/**
 * When the link closes, as a unix second.
 *
 * "Tonight" is 23:00 on this phone's own clock, and never less than an hour away: a link made at
 * 23:30 with a deadline of 23:00 would be closed before anybody could open it, and a deadline in
 * the past is the one thing a claimant cannot work around. Nothing above a week is offered even
 * though the contract allows thirty days.
 */
function closingAt(choice: Closing, nowMs: number): number {
  const sec = Math.floor(nowMs / 1000);
  if (choice === "practice") return sec + 20 * 60;
  if (choice === "week") return sec + 7 * 24 * 3600;
  if (choice === "tonight") {
    const at = new Date(nowMs);
    at.setHours(23, 0, 0, 0);
    return Math.floor(Math.max(at.getTime(), nowMs + 3600_000) / 1000);
  }
  return sec + 24 * 3600;
}

/**
 * The deadline in this phone's own words. Rendered ONLY after mount (see `now` below): a
 * locale- and timezone-dependent string built during the server render is a different string on
 * the phone, which is a hydration mismatch on the screen that is about to move money.
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

/**
 * The metadata half of a sent link, exactly as /send stores it, plus `slots`.
 *
 * `slots` is what makes this record a POOL to everything that reads it later: `loadReclaimableV2`
 * and `/sent/[id]` probe `get_pool` on the strength of it, and without it a pool is asked about
 * with `get_drop`, answers "nothing here", and reads as settled while the money is still on the
 * link. The link itself is NOT in this record, its #fragment is a bearer key, and this lives in
 * plain localStorage (see lib/sent-links.ts).
 */
interface SentRecord {
  balanceId: string;
  hasLink: boolean;
  amount: string;
  from: string;
  at: string;
  /** how many equal shares the pot holds; present only on a group link */
  slots?: number;
}

function saveSent(id: string, rec: SentRecord) {
  try {
    const all = JSON.parse(localStorage.getItem(netKey("lumenia.sent")) ?? "{}") as Record<string, SentRecord>;
    all[id] = rec;
    localStorage.setItem(netKey("lumenia.sent"), JSON.stringify(all));
  } catch {
    /* localStorage blocked, the link still works, just no local tracking */
  }
}

export default function GroupPage() {
  const { status, account, accounts, getSigner } = useWallet();
  const router = useRouter();
  const [perShare, setPerShare] = useState("");
  const [slots, setSlots] = useState(6);
  const [closing, setClosing] = useState<Closing>("day");
  const [from, setFrom] = useState("");
  const [wantWord, setWantWord] = useState(false);
  const [word, setWord] = useState("");
  const [balance, setBalance] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** The account has no password yet, a different errand from a locked one, and /unlock can't do it. */
  const [needsPassword, setNeedsPassword] = useState(false);
  const [ready, setReady] = useState<{
    link: string;
    linkHex: string;
    perShare: string;
    slots: number;
    total: string;
    expiry: number;
    locked: boolean;
  } | null>(null);
  /* A deposit that was submitted and could not be confirmed. Its own state, never `error`: an error
     screen invites the retry, and on a pot the retry escrows the WHOLE amount a second time. It
     carries everything the ready card needs, because the pot may yet land and the claim URL we are
     holding is the only copy of it. */
  const [uncertain, setUncertain] = useState<{
    linkHex: string;
    link: string;
    perShare: string;
    slots: number;
    total: string;
    expiry: number;
    locked: boolean;
    /** before this, an empty escrow is not evidence: the signed deposit is still includable */
    safeAt: number;
  } | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [notYet, setNotYet] = useState("");
  /* Whether a create is already running, readable the instant a second tap arrives. `busy` applies
     on the next render, and everything this screen does first is awaited. */
  const making = useRef(false);
  const toppedUp = useRef(false);
  /** Set after mount, so no deadline is ever computed or formatted during the server render. */
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    // "Tonight" moves as the evening does, and a deadline printed an hour ago is not the one that
    // would be signed now.
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!accounts.length) return;
    let alive = true;
    void loadTotalUsd(accounts.map((a) => a.address))
      .then((t) => alive && setBalance(t.usd))
      .catch(() => {
        /* leave it null: unknown is not zero, and the guard below no-ops on null */
      });
    return () => {
      alive = false;
    };
  }, [accounts]);

  const namedFrom = useRef(false);
  useEffect(() => {
    if (!account || namedFrom.current) return;
    namedFrom.current = true;
    void handleOf(account.address)
      .then((name) => name && setFrom((current) => current || name))
      .catch(() => {
        /* no registry, no name, the claim page says "Someone", which is true */
      });
  }, [account]);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;

  if (!account) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-xl font-bold text-ink">One link, many people</h1>
        <p className="max-w-xs text-ink-soft">
          The money for a group link comes out of your own account, so you need one open before you
          can make one.
        </p>
        <Link href="/send?start=1" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          Open my account →
        </Link>
      </div>
    );
  }

  const mainnet = activeNetwork().isMainnet;
  /* Both ceilings are the network's, not the form's: the relay applies them again whatever this
     screen says, so the only job here is to stop a sender meeting a refusal after they have
     already signed. */
  const POT_CAP_USD = mainnet ? POT_CAP_MAINNET_USD : POT_CAP_TESTNET_USD;
  const seatCeiling = maxPoolSlots(mainnet);
  const share = Math.round(Number.parseFloat(perShare) * 100) / 100;
  const shareOk = Number.isFinite(share) && share >= MIN_SHARE_USD;
  // Multiplied where the contract multiplies it, in stroops, so the pot is an exact multiple of
  // the share and the floor division inside `create_drop` strands nothing.
  const total = shareOk ? groupTotal(share.toFixed(2), slots) : "";
  const overCap = total !== "" && Number.parseFloat(total) > Number.parseFloat(POT_CAP_USD);
  const expiry = now ? closingAt(closing, now) : 0;

  async function make() {
    if (making.current) return;
    making.current = true;
    try {
      await makeOnce();
    } finally {
      making.current = false;
    }
  }

  async function makeOnce() {
    setError("");
    setNeedsPassword(false);
    if (!shareOk) return setError("Enter what each person gets.");
    if (overCap) return setError(`A group link holds up to ${formatUsd(POT_CAP_USD)} in total.`);
    if (wantWord) {
      const problem = claimPasswordProblem(word);
      if (problem) return setError(problem);
    }

    /* MAKE SURE THERE IS MONEY TO PUT IN, the way /send does it: a balance that has not arrived is
       not a balance of zero, and practice money tops itself up once rather than sending somebody
       off to another screen. Real money is untouched, nothing can conjure that. */
    let known = balance;
    if (known === null) {
      known = await loadTotalUsd(accounts.map((a) => a.address))
        .then((t) => t.usd)
        .catch(() => null);
      setBalance(known);
    }
    if (!mainnet && !toppedUp.current && known !== null && Number.parseFloat(total) > Number.parseFloat(known)) {
      toppedUp.current = true;
      try {
        await getTestMoney(sponsorUrl(), account!.address);
        const t = await loadTotalUsd(accounts.map((a) => a.address));
        known = t.usd;
        setBalance(known);
      } catch {
        /* the faucet said no; the balance check below still has the last word */
      }
    }
    if (known !== null && Number.parseFloat(total) > Number.parseFloat(known)) {
      return setError("That's more than you have.");
    }

    /* Resolved ONCE, before anything is signed, and reused for the transaction, the ready screen
       and the uncertain screen. Read twice, the deadline the sender was shown and the deadline the
       escrow holds would be minutes apart. */
    const at = closingAt(closing, Date.now());

    setBusy(true);
    try {
      let signer;
      try {
        signer = await getSigner();
      } catch (e) {
        /* An account with no password has nothing to unlock, and /unlock turns straight back here.
           Offered rather than jumped to, the same way /send and /notifications offer it. */
        if (isNeedsPassword(e) || account!.phase === 1) {
          setError("Set a password to finish, until then, this money can't be sent.");
          setNeedsPassword(true);
          return;
        }
        router.push("/unlock?next=/group");
        return;
      }
      const senderName = from.trim() || "Someone";
      void sendEvent("send_started", account!.address, account!.address);

      const result = await createV2GroupLink({
        sponsorUrl: sponsorUrl(),
        signer,
        perShare: share.toFixed(2),
        slots,
        from: senderName,
        webOrigin: window.location.origin,
        expiry: at,
        password: wantWord ? word : undefined,
        /* EVERY link this screen makes carries the public `seeded=1` marker. It is the team's event
           tool, and a pot the team funded must never be read as somebody adopting the product. The
           marker is in the query where anyone can see it, and the sponsor counts that cohort apart. */
        seeded: true,
      });

      const sentId = result.linkHex.slice(-8);
      await rememberLink(sentId, result.link);
      saveSent(sentId, {
        balanceId: result.linkHex,
        hasLink: true,
        amount: result.total,
        from: senderName,
        at: new Date().toISOString(),
        slots: result.slots,
      });
      void sendEvent("send_link_created", account!.address, account!.address);
      setWord(""); // it lives in the link's derivation now; keep it out of memory
      setReady({
        link: result.link,
        linkHex: result.linkHex,
        perShare: result.perShare,
        slots: result.slots,
        total: result.total,
        expiry: at,
        locked: wantWord,
      });
    } catch (e) {
      console.error("[group]", e);
      /* The one failure this screen must not guess at. A pot that is sitting in the ledger's queue
         and a pot that never left look identical from here, and a retry escrows the WHOLE amount a
         second time under a fresh link key. So it gets its own screen, with no button that spends. */
      if (e instanceof DepositUncertainError) {
        void rememberLink(e.linkHex.slice(-8), e.link);
        setNotYet("");
        setUncertain({
          linkHex: e.linkHex,
          link: e.link,
          perShare: share.toFixed(2),
          slots,
          total,
          expiry: at,
          locked: wantWord,
          safeAt: Number.isFinite(e.retrySafeAfter) ? e.retrySafeAfter : Date.now() + RETRY_SAFE_AFTER_MS,
        });
        return;
      }
      const msg = (e as Error).message ?? "";
      /* The refusals worth repeating verbatim are the ones written for the person who hit them -
         the network scope, the share count, the per-share floor. Anything with a status code or an
         XDR blob in it is machinery, and machinery never reaches a money screen. */
      setError(
        msg && !/^\/|xdr|\d{3}:/i.test(msg) ? msg : "We couldn't make that link. Your money hasn't moved.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* Submitted, unconfirmed. This screen's whole job is to stop a second pot being escrowed: it says
     what is actually known, offers a read of the escrow, and offers no path that spends again. */
  if (uncertain) {
    async function recheck() {
      setRechecking(true);
      setNotYet("");
      try {
        const landed = await v2DepositLanded(uncertain!.linkHex, account!.address, { group: true });
        if (landed === true) {
          /* The escrow holds the pot: the link is real, and only NOW is the local record written -
             a record for a pot that never landed would read as a settled link on /sent forever. */
          const u = uncertain!;
          saveSent(u.linkHex.slice(-8), {
            balanceId: u.linkHex,
            hasLink: true,
            amount: u.total,
            from: from.trim() || "Someone",
            at: new Date().toISOString(),
            slots: u.slots,
          });
          setReady({
            link: u.link,
            linkHex: u.linkHex,
            perShare: u.perShare,
            slots: u.slots,
            total: u.total,
            expiry: u.expiry,
            locked: u.locked,
          });
          setUncertain(null);
        } else if (landed === false && Date.now() >= uncertain!.safeAt) {
          setUncertain(null);
          setError("That one didn't go through. Nothing left your account, you can try again.");
        } else {
          setNotYet(
            landed === "unknown"
              ? "We couldn't check just now. Nothing has changed, try again in a moment."
              : "It hasn't arrived yet, and it can still get there. Check again in a few minutes.",
          );
        }
      } finally {
        setRechecking(false);
      }
    }

    return (
      <div className="flex flex-col gap-4 py-4">
        <h1 className="text-xl font-bold text-ink">We couldn&apos;t confirm this one</h1>
        <MoneyCard className="p-5">
          <p className="text-sm text-ink">
            Your {formatUsd(uncertain.total)} was handed to the network, but we didn&apos;t get
            confirmation back in time. It may well have gone through.
          </p>
          <p className="mt-2 text-sm font-semibold text-ink">
            Don&apos;t make it again yet, you could put the money in twice.
          </p>
          {notYet && <p className="mt-3 text-sm font-medium text-ink">{notYet}</p>}
          <div className="mt-4">
            <PrimaryButton loading={rechecking} loadingLabel="Checking…" onClick={recheck}>
              Check again
            </PrimaryButton>
          </div>
        </MoneyCard>
        <Link href="/activity" className="text-sm text-ink-soft underline-offset-2 hover:underline">
          See my activity
        </Link>
      </div>
    );
  }

  if (ready) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <header>
          <h1 className="text-xl font-bold text-ink">
            Done. One link, {ready.slots} shares of {formatUsd(ready.perShare)}
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            The link closes at {closingLabel(ready.expiry)}. Anything nobody takes comes back to you
            then, and not before.
          </p>
        </header>
        <LinkReadyCard
          link={ready.link}
          balanceId={ready.linkHex}
          from={from.trim()}
          locked={ready.locked}
          account={account.address}
          seeded
        />
        <p className="text-xs text-ink-soft">
          What the ledger holds you to: at most {ready.slots} shares, exactly {formatUsd(ready.perShare)}{" "}
          each, only to an address this link signs for, and nothing after it closes. It counts
          addresses, not people.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">One link, many people</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Put the money in once. Everyone who opens the link takes the same share, until it runs out.
        </p>
        {mainnet && (
          <p className="mt-2 text-sm text-ink-soft">
            This is real money, on the open network. A real-money pot holds up to{" "}
            {formatUsd(POT_CAP_MAINNET_USD)} across at most {MAINNET_MAX_POOL_SLOTS} shares while we
            are still running the pilot.
          </p>
        )}
      </header>

      <label className="text-sm text-ink-soft">
        Each person gets
        <div className="mt-1 flex items-center rounded-[14px] border border-line bg-surface px-3">
          <span className="text-lg text-ink-soft">$</span>
          <input
            inputMode="decimal"
            value={perShare}
            onChange={(e) => setPerShare(sanitizeAmountInput(e.target.value))}
            placeholder="0.00"
            className="w-full bg-transparent px-2 py-3 text-lg text-ink outline-none"
          />
        </div>
      </label>

      <div className="text-sm text-ink-soft">
        Number of people
        <div className="mt-1 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSlots((n) => Math.max(MIN_POOL_SLOTS, n - 1))}
            className="grid size-10 place-items-center rounded-full border border-line text-lg text-ink"
            aria-label="fewer people"
          >
            −
          </button>
          <span className="min-w-[3ch] text-center text-lg font-semibold tabular-nums text-ink">{slots}</span>
          <button
            type="button"
            onClick={() => setSlots((n) => Math.min(seatCeiling, n + 1))}
            className="grid size-10 place-items-center rounded-full border border-line text-lg text-ink"
            aria-label="more people"
          >
            +
          </button>
        </div>
      </div>

      {/* The pot, and who gets what, in one line, computed in stroops so it is the figure the
          contract will hold, not a figure a float arrived at. */}
      {total !== "" && (
        <p className="text-sm text-ink">
          You put in <span className="font-semibold tabular-nums">{formatUsd(total)}</span>. Each of
          the first {slots} people to open the link takes {formatUsd(share.toFixed(2))}.
        </p>
      )}

      {/* WHO IT IS FROM is not a question this screen needs to ask: the account's own name is
          already the answer, and the claim page says "Someone" when there isn't one, which is true.
          Editable one tap away, out of the main line of the form, the same way /send offers it. */}
      <details className="text-sm text-ink-soft">
        <summary className="cursor-pointer list-none underline-offset-2 hover:underline [&::-webkit-details-marker]:hidden">
          Sent as {from.trim() || "Someone"}, change
        </summary>
        <input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="e.g. Alex"
          aria-label="Your name"
          className="mt-2 w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-ink"
        />
      </details>

      <fieldset className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-4">
        <legend className="px-1 text-sm text-ink-soft">When it closes</legend>
        {(
          [
            ...(mainnet ? [] : ([["practice", "In 20 minutes (practice)"]] as [Closing, string][])),
            ["tonight", "Tonight"],
            ["day", "In 24 hours"],
            ["week", "In 7 days"],
          ] as [Closing, string][]
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-3 text-sm text-ink">
            <input
              type="radio"
              name="closing"
              value={value}
              checked={closing === value}
              onChange={() => setClosing(value)}
              className="size-4"
            />
            {label}
          </label>
        ))}
        {/* The resolved time, not the label: "tonight" on a phone at 23:30 is tomorrow morning, and
            the person deciding is the one who needs to see which. */}
        {expiry > 0 && (
          <p className="mt-1 text-xs text-ink-soft">
            The link closes at {closingLabel(expiry)}. Anything nobody takes comes back to you then,
            and not before.
          </p>
        )}
      </fieldset>

      {/* The shared word is OPT-IN. It keeps the link inside the group; it is not a headcount, and
          the label must never suggest it is. Off by default because the hero flow is a link you
          tap, and the word is a second thing to say out loud to everyone. */}
      <div className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-4">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={wantWord}
            onChange={(e) => setWantWord(e.target.checked)}
            className="mt-1 size-4"
          />
          <span>
            <span className="font-medium text-ink">Ask for a word before anyone can take a share</span>
            <span className="block text-ink-soft">
              So only people on the trip can open it. Say it out loud once, without it, anyone the
              link is forwarded to can take a share.
            </span>
          </span>
        </label>
        {wantWord && (
          <>
            <input
              type="password"
              value={word}
              onChange={(e) => setWord(e.target.value)}
              autoComplete="new-password"
              placeholder="One word everyone knows"
              aria-label="Shared word"
              className="w-full rounded-[14px] border border-line bg-paper px-3 py-3 text-ink"
            />
            <p className="text-xs text-ink-soft">
              Tell them the word some other way: out loud, or a call. In the same chat as the link it
              protects nothing. Forget it and the money isn&apos;t stuck, it comes back to you when
              the link closes.
            </p>
          </>
        )}
      </div>

      {overCap && (
        <p className="text-sm text-ink-soft">
          A group link holds up to {formatUsd(POT_CAP_USD)} in total. That&apos;s our limit, not the
          contract&apos;s.
        </p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      {needsPassword && (
        <Link href="/account" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          Set a password
        </Link>
      )}

      <PrimaryButton
        loading={busy}
        /* Naming the slow step rather than hiding it: the word is turned into the link key by 48
           MiB of Argon2id on THIS phone before anything is sent, and it takes a couple of seconds. */
        loadingLabel={wantWord ? "Checking the word on this phone…" : "Making your link…"}
        disabled={!shareOk || overCap || slots > seatCeiling}
        onClick={make}
      >
        Make the link
      </PrimaryButton>

      <p className="text-xs text-ink-soft">
        What the ledger holds you to: at most {slots} shares, exactly the same amount each, only to
        an address the link signs for, and nothing after it closes. It counts addresses, not people -
        so the word is what keeps a link inside your group, and we say which is which.
      </p>
    </div>
  );
}
