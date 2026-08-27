"use client";

/**
 * /send — the loop's engine (FRONTEND_PLAN §1/§3). A recipient who claimed sends
 * money onward: amount → your name → a link to share. Value-first for senders too
 * (no credential until needed). The sender holds 0 XLM, so the sponsor sponsors the
 * new Claimable Balance's reserve + fee-bumps (Spike #5).
 *
 * Owner caveat C4 — the first-sender onboarding chain (key → create-account →
 * faucet → CB) is honoured: a just-claimed account already has an account +
 * trustline + USDC, so it sends straight away; a zero-balance account sees
 * "Get test money" (the faucet) first.
 *
 * Request money (REQUEST_MONEY.md §10): /r hands off here with ?a=<amount>&req=
 * <nonce>&reqName=<asker>[&to=<address>]. With `to` (a returning asker) the money
 * goes straight to her address via payToAddress — no bearer link at all; without
 * it the normal bearer link is created and the payer sends it back in the same
 * chat. Both fire request_paid with the nonce (the funnel's join key). The query
 * is read once from window.location on mount — the /unlock idiom — so the page
 * stays out of the useSearchParams/Suspense machinery.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../lib/wallet";
import { loadTotalUsd } from "../../../lib/horizon";
import { payToAddress } from "../../../lib/send";
import { createV2Link, DepositUncertainError, v2DepositLanded } from "../../../lib/lumendrop";
import { claimPasswordProblem } from "../../../lib/claim-password";
import { isValidAddress } from "../../../lib/request";
import { sendEvent } from "../../../lib/events";
import { formatUsd } from "../../../lib/money";
import { netKey } from "../../../lib/scoped-store";
import { activeNetwork } from "../../../lib/network";
import { copy } from "../../../lib/copy";
import { handleOf } from "../../../lib/handles";
import { rememberLink } from "../../../lib/sent-links";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { AmountDisplay } from "../../../components/brand/AmountDisplay";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";
import { LinkReadyCard } from "../../../components/brand/LinkReadyCard";

/**
 * The sponsor for the network this device is ACTUALLY on.
 *
 * This page used to hold a single module-level SPONSOR_URL pointing at the testnet Worker, no
 * matter which network the user had switched to. On real money that meant every send was signed
 * for mainnet and then posted to the testnet sponsor, which cannot serve it — sending was broken
 * on mainnet outright, and the failure surfaced as an unexplained error at the last step, after
 * the person had already chosen an amount. /send-out already resolved this per call; /send did not.
 *
 * Read at call time, never at module scope: switching networks reloads, but a module constant
 * captured at import is exactly how this drifted in the first place.
 */
/** Must match MAX_DROP_USDC on the mainnet Worker; same env var the /pilot page promises. */
const PILOT_TX_CAP_USD = process.env.NEXT_PUBLIC_PILOT_TX_CAP_USD ?? "5";

function sponsorUrl(): string {
  return activeNetwork().sponsorUrl;
}

/**
 * The metadata half of a sent link. The LINK ITSELF is deliberately absent: its #fragment is a
 * bearer key, and this record lives in plain localStorage. The link goes to `sent-links.ts`,
 * encrypted under a non-extractable device key, and `hasLink` is the flag this record keeps so
 * the UI knows a re-copy is possible without holding the secret to prove it.
 */
interface SentRecord {
  balanceId: string;
  /** true when a bearer link was stored (encrypted); false for a pay-to-address send. */
  hasLink: boolean;
  amount: string;
  from: string;
  at: string;
  /** who was paid, when this send answered a request straight to their account. */
  toName?: string;
  /** their account address (direct pays only) — lets /contacts offer "pay again". */
  toAddress?: string;
}

interface RequestCtx {
  nonce: string;
  name: string;
  to?: string;
  /** the amount the asker named, for the header ("<name> asked for $X"). */
  amount?: string;
}

type Ready =
  | { kind: "link"; link: string; balanceId: string; locked: boolean }
  | { kind: "direct"; balanceId: string; toName: string };

function saveSent(id: string, rec: SentRecord) {
  try {
    const all = JSON.parse(localStorage.getItem(netKey("lumenia.sent")) ?? "{}") as Record<string, SentRecord>;
    all[id] = rec;
    localStorage.setItem(netKey("lumenia.sent"), JSON.stringify(all));
  } catch {
    /* localStorage blocked — the link still works, just no local tracking */
  }
}

/** First name, capped — the submit button is nowrap and must survive 40-char names. */
function shortName(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? name).slice(0, 12);
}

export default function SendPage() {
  const { status, account, accounts, getSigner } = useWallet();
  const router = useRouter();
  const [balance, setBalance] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState("");
  const [request, setRequest] = useState<RequestCtx | null>(null);
  // Optional claim password (lib/claim-password.ts). Off by default: the hero flow is a
  // link you tap, and adding a step to every send would cost more than it buys.
  const [wantPassword, setWantPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [error, setError] = useState("");
  /* A deposit we submitted but could not confirm. Distinct from `error` on purpose: an error screen
     invites a retry, and retrying this is the failure mode. */
  const [uncertain, setUncertain] = useState<{ linkHex: string; link: string; amount: string } | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [ready, setReady] = useState<Ready | null>(null);

  /* Sum EVERY stored account, the way /home and /account do. Reading only the home account meant a
     claim that had just landed in a fresh sponsored account — which is how every v2 claim arrives —
     was invisible here: /home said "$20.00" and this screen said "You don't have any money to send
     yet" and offered practice money. Also survives a failed read instead of reporting zero. */
  useEffect(() => {
    if (!accounts.length) return;
    let alive = true;
    void loadTotalUsd(accounts.map((a) => a.address))
      .then((t) => alive && setBalance(t.usd))
      .catch(() => {
        /* leave it null: unknown is not zero, and the guards below already no-op on null */
      });
    return () => {
      alive = false;
    };
  }, [accounts]);

  // Prefill from a request hand-off (/r → /send). Read once on mount.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const a = q.get("a");
    const askedAmount = a && /^\d+(\.\d{1,2})?$/.test(a) ? Number.parseFloat(a).toFixed(2) : undefined;
    if (askedAmount) setAmount(askedAmount);
    const nonce = q.get("req");
    const name = q.get("reqName")?.trim().slice(0, 40);
    const rawTo = q.get("to");
    const to = rawTo && isValidAddress(rawTo) ? rawTo : undefined;
    if (nonce && name) {
      // A request hand-off (/r → /send). A bad `to` must not silently downgrade to a bearer link
      // the asker never gets — fall back to the plain ask instead (the payer still shares back).
      setRequest({ nonce, name, to, amount: askedAmount });
    } else if (to && name) {
      // Paying a contact directly (/contacts "pay again" → /send?to=…&reqName=…). No request nonce,
      // so no request_paid event fires — it's just a direct pay to a known account.
      setRequest({ nonce: "", name, to, amount: askedAmount });
    }
  }, []);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  if (!account) {
    if (typeof window !== "undefined") router.replace("/home");
    return null;
  }

  /**
   * Two things this screen used to ASK for, which it can simply know.
   *
   * PRACTICE MONEY: a sender with $0 on the test network cannot send, so the screen offered a
   * button to go and get some. That is a step, a decision and an explanation in front of money
   * that is not real. It now tops itself up on arrival — once, guarded by a ref, and only on
   * practice money with a zero balance. Real money is untouched: nothing can conjure that.
   *
   * WHO IT IS FROM: if the account has a name, that is the answer. Asking again is asking somebody
   * to type something we already have.
   */
  const toppedUp = useRef(false);
  useEffect(() => {
    if (!account || balance === null || faucetBusy || toppedUp.current) return;
    if (activeNetwork().isMainnet) return;
    if (Number.parseFloat(balance) > 0) return;
    toppedUp.current = true;
    void getTestMoney();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, balance, faucetBusy]);

  const namedFrom = useRef(false);
  useEffect(() => {
    if (!account || namedFrom.current) return;
    namedFrom.current = true;
    void handleOf(account.address)
      .then((name) => name && setFrom((current) => current || name))
      .catch(() => {
        /* no registry, no name — the claim page says "Someone", which is true */
      });
  }, [account]);

  async function getTestMoney() {
    setFaucetBusy(true);
    setError("");
    try {
      const res = await fetch(`${sponsorUrl()}/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipientPublicKey: account!.address }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "faucet unavailable");
      const t = await loadTotalUsd(accounts.map((a) => a.address));
      setBalance(t.usd);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFaucetBusy(false);
    }
  }

  async function send() {
    setError("");
    // Validate the ROUNDED amount — "0.001" parses > 0 but formats to "0.00",
    // which the ledger (and /r's parser) rejects. The guard must see what ships.
    const amt = Math.round(Number.parseFloat(amount) * 100) / 100;
    if (!Number.isFinite(amt) || amt < 0.01 || amt >= 1_000_000_000) {
      return setError("Enter an amount to send.");
    }
    if (balance !== null && amt > Number.parseFloat(balance)) return setError("That's more than you have.");
    // The pilot cap is enforced by the sponsor, but only AFTER the transaction is signed — and on
    // mainnet the reason is masked, so an over-cap send asked for the password, then failed with a
    // generic "try again" that no amount of retrying could fix. Check it here, before we ask the
    // user for anything, and say the number out loud.
    if (activeNetwork().isMainnet && amt > Number.parseFloat(PILOT_TX_CAP_USD)) {
      return setError(`During the pilot you can send up to $${PILOT_TX_CAP_USD} at a time.`);
    }
    const directTo = request?.to; // paying a returning asker straight to her account
    if (!directTo && !from.trim()) return setError("Add your name so they know who it's from.");
    const lockWith = !directTo && wantPassword ? password : "";
    if (!directTo && wantPassword) {
      const problem = claimPasswordProblem(password);
      if (problem) return setError(problem);
    }

    setBusy(true);
    try {
      let signer;
      try {
        signer = await getSigner();
      } catch {
        // Phase-2 account is locked → unlock, then come back and finish. Carry
        // the CURRENT amount in the return URL — the mount effect re-prefills
        // from the query, and reverting a payer's edited amount to the full
        // asked amount would make them send more than they chose.
        const q = new URLSearchParams(window.location.search);
        q.set("a", amt.toFixed(2));
        const back = `${window.location.pathname}?${q.toString()}`;
        router.push(`/unlock?next=${encodeURIComponent(back)}`);
        return;
      }
      void sendEvent("send_started", account!.address);

      if (directTo) {
        const result = await payToAddress({
          sponsorUrl: sponsorUrl(),
          signer,
          amount: amt.toFixed(2),
          to: directTo,
        });
        saveSent(result.balanceId.slice(-8), {
          balanceId: result.balanceId,
          hasLink: false, // no bearer link exists — the money is already the asker's to collect
          amount: amt.toFixed(2),
          from: "",
          toName: request!.name,
          toAddress: directTo,
          at: new Date().toISOString(),
        });
        if (request!.nonce) void sendEvent("request_paid", request!.nonce); // no nonce = paying a contact, not a request
        setReady({ kind: "direct", balanceId: result.balanceId, toName: request!.name });
        return;
      }

      // v2: the money is locked in the Soroban escrow behind a fresh link key; the payout is
      // chosen at claim time (no reserve, no fragmentation, no sweep). The sender pays no gas —
      // the sponsor fee-bumps the deposit (/v2-deposit). The claim opens at /v2/c/<linkHex>.
      const result = await createV2Link({
        sponsorUrl: sponsorUrl(),
        signer,
        amount: amt.toFixed(2),
        from: from.trim(),
        webOrigin: window.location.origin,
        password: lockWith || undefined,
      });
      const sentId = result.linkHex.slice(-8);
      // The link is kept encrypted, separately from this record — see lib/sent-links.ts.
      await rememberLink(sentId, result.link);
      saveSent(sentId, {
        balanceId: result.linkHex, // the v2 drop id (the link key); reused by "my links"
        hasLink: true,
        amount: amt.toFixed(2),
        from: from.trim(),
        at: new Date().toISOString(),
      });
      // The sponsor has always allowed this one; nothing ever fired it. Paired with send_started it
      // is the only way to see the send flow's own drop-off — how many people who begin a send end
      // up with a link they can share.
      void sendEvent("send_link_created", account!.address);
      if (request?.nonce) void sendEvent("request_paid", request.nonce);
      setPassword(""); // it lives in the link's derivation now; keep it out of memory
      setReady({ kind: "link", link: result.link, balanceId: result.linkHex, locked: Boolean(lockWith) });
    } catch (e) {
      // Technical reasons (status codes, ledger result codes) must never reach a money surface
      // (vocabulary law); a rejected inner tx means nothing moved.
      //
      // The 403s are the exception, and refusing them cost people real time. The sponsor's pilot
      // gate answers in plain, already-human sentences — "pilot limit reached: 5 transactions
      // used", "this wallet is not on the pilot allowlist yet" — and burying those under "try
      // again" invited exactly the retry that can never work. A wall the user could act on read
      // as a glitch.
      console.error("[send]", e);

      /* The one error we must never guess at. Everywhere else "your money hasn't moved, try again"
       * is true and kind; here it can be a lie that costs real money, because the deposit may be
       * sitting in the ledger's queue and a retry mints a SECOND drop under a fresh link key.
       *
       * So an unresolved deposit gets its own state: the truth, the link id to check with, and NO
       * retry button. The user can re-check, and the money surfaces on its own once the ledger
       * catches up. */
      if (e instanceof DepositUncertainError) {
        // Persist the link now, not on success: if this deposit lands later, the only copy of the
        // claim URL is the one we are holding here, and a reload would otherwise lose it.
        void rememberLink(e.linkHex.slice(-8), e.link);
        setUncertain({ linkHex: e.linkHex, link: e.link, amount: amt.toFixed(2) });
        return; // deliberately skips setError — this is not an error screen
      }

      const msg = (e as Error).message ?? "";
      const pilotReason = /403/.test(msg) ? msg.slice(msg.indexOf("{")) : "";
      const reason = pilotReason.match(/"error"\s*:\s*"([^"]+)"/)?.[1];
      setError(reason ? `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.` : copy.errors.moneySafe);
    } finally {
      setBusy(false);
    }
  }

  /* Submitted, unconfirmed. The screen's whole job is to stop a second send: it states what is
     actually known, offers a re-check against the escrow, and gives no path that spends money
     again. If the drop turns up, this becomes the ordinary link screen. */
  if (uncertain) {
    async function recheck() {
      setRechecking(true);
      try {
        const landed = await v2DepositLanded(uncertain!.linkHex, account!.address);
        if (landed === true) {
          setReady({ kind: "link", link: uncertain!.link, balanceId: uncertain!.linkHex, locked: false });
          setUncertain(null);
        } else if (landed === false) {
          // Definitively nothing there — sending again is safe, so let them.
          setUncertain(null);
          setError("That one didn't go through. Nothing left your account — you can try again.");
        }
        // "unknown" ⇒ stay exactly here. Saying anything else would be inventing an answer.
      } finally {
        setRechecking(false);
      }
    }

    return (
      <div className="flex flex-col gap-4 py-4">
        <h1 className="text-xl font-bold text-ink">We couldn&apos;t confirm this one</h1>
        <MoneyCard className="p-5">
          <p className="text-sm text-ink">
            Your {formatUsd(uncertain.amount)} was handed to the network, but we didn&apos;t get
            confirmation back in time. It may well have gone through.
          </p>
          <p className="mt-2 text-sm font-semibold text-ink">
            Don&apos;t send it again yet — you could send twice.
          </p>
          <p className="mt-2 text-sm text-ink-soft">
            Check again in a moment. If it went through, your link appears here. If it didn&apos;t,
            we&apos;ll say so and nothing will have left your account.
          </p>
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

  if (ready?.kind === "direct") {
    return (
      <div className="flex flex-col gap-4 py-4">
        <h1 className="text-xl font-bold text-ink">{copy.pay.paidDirectTitle}</h1>
        <p className="text-ink-soft">{copy.pay.paidDirectBody(ready.toName)}</p>
        <Link
          href={`/sent/${ready.balanceId.slice(-8)}`}
          className="text-sm font-semibold text-money underline-offset-2 hover:underline"
        >
          Track it →
        </Link>
      </div>
    );
  }

  if (ready?.kind === "link") {
    return (
      <div className="flex flex-col gap-4 py-4">
        <h1 className="text-xl font-bold text-ink">Done. Share the link</h1>
        <LinkReadyCard
          link={ready.link}
          balanceId={ready.balanceId}
          from={from.trim()}
          requestName={request?.name}
          locked={ready.locked}
        />
      </div>
    );
  }

  const zeroBalance = balance !== null && Number.parseFloat(balance) <= 0;
  const paying = request !== null;

  // Paying your own request is a guaranteed on-chain rejection (a Claimable
  // Balance may not name the same destination twice) — show the truth instead.
  if (request?.to && request.to === account.address) {
    return (
      <div className="flex flex-col gap-3 py-8 text-center">
        <h1 className="text-xl font-bold text-ink">{copy.pay.ownRequestTitle}</h1>
        <p className="text-ink-soft">{copy.pay.ownRequestBody}</p>
        <Link href="/home" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          Back to my money →
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">
          {paying ? `Pay ${request.name}` : "Send money"}
        </h1>
        {paying && request.amount && (
          <p className="mt-1 text-sm text-ink-soft">
            {request.name} asked for {formatUsd(request.amount)}.
          </p>
        )}
        {/* The one attacker-independent signal on a direct pay: where it goes. */}
        {request?.to && (
          <p className="mt-1 text-sm text-ink-soft">
            {copy.pay.directNote(shortName(request.name), request.to.slice(-4))}
          </p>
        )}
        {balance !== null && (
          <p className="mt-1 text-sm text-ink-soft">
            You have <AmountDisplay value={balance} size="md" tone="ink" className="!text-base" /> to send.
          </p>
        )}
      </header>

      {zeroBalance ? (
        /* The faucet is a TESTNET thing. On real money it 503s ("faucet not configured"), and the
           raw error landed on a money screen — under a button offering free money and a line saying
           the money isn't real, to someone who had just been approved to move real dollars. */
        <div className="flex flex-col gap-3">
          {activeNetwork().isMainnet && (
            <p className="text-ink-soft">You don&apos;t have any money to send yet.</p>
          )}
          {activeNetwork().isMainnet ? (
            <>
              <Link href="/add-money" className="block">
                <PrimaryButton>Add dollars</PrimaryButton>
              </Link>
              <p className="text-xs text-ink-soft">
                Send USDC to your address from an exchange or another wallet.
              </p>
            </>
          ) : (
            /* PRACTICE MONEY TOPS ITSELF UP. This used to be a button and a sentence explaining
               the test network — a whole step, and a decision, in front of money that is not real
               and costs nobody anything. Asking permission to hand somebody play money is pure
               ceremony, so it just happens; all that is left is a line saying it is happening.
               (Real money keeps its step: nothing can conjure that, and the person has to go and
               get it.) */
            <p className="text-ink-soft">Getting you some practice money…</p>
          )}
        </div>
      ) : (
        <>
          <label className="text-sm text-ink-soft">
            Amount
            <div className="mt-1 flex items-center rounded-[14px] border border-line bg-surface px-3">
              <span className="text-lg text-ink-soft">$</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="0.00"
                className="w-full bg-transparent px-2 py-3 text-lg text-ink outline-none"
              />
            </div>
          </label>
          {/* Paying straight to a returning asker's account needs no sender name —
              nothing ever displays it. The bearer-link path still does (the claim
              page says "<from> sent you money"). */}
          {/* WHO IT IS FROM is not a question this screen needs to ask. If the account has a
              name it is already the answer; if it does not, the claim page says "Someone sent you
              money", which is true and costs nobody a keystroke. It stays editable — one tap, out
              of the main line of the form — because a person sending to their mother may well want
              to be "Mum's daughter" rather than @simon. */}
          {!request?.to && (
            <details className="text-sm text-ink-soft">
              <summary className="cursor-pointer list-none underline-offset-2 hover:underline [&::-webkit-details-marker]:hidden">
                Sent as {from.trim() || "Someone"} — change
              </summary>
              <input
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="e.g. Alex"
                aria-label="Your name"
                className="mt-2 w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-ink"
              />
            </details>
          )}
          {/* Optional lock. Only for a bearer LINK — a direct pay already lands in one
              named account, so a password there would protect nothing. Off by default;
              the copy names the failure mode (same chat = no protection) rather than
              implying the password is strong on its own. */}
          {!request?.to && (
            <div className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-4">
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={wantPassword}
                  onChange={(e) => setWantPassword(e.target.checked)}
                  className="mt-1 size-4"
                />
                {/* Named for WHOSE password it is. "Lock it with a password" is the same phrase the
                    app uses for locking your own account (/home, /pilot), and a user who had just
                    wrestled with that one read this as "my account is already protected, why is it
                    asking again". Two unrelated secrets, one word, one screen apart. */}
                <span>
                  <span className="font-medium text-ink">Make them enter a password</span>
                  <span className="block text-ink-soft">
                    You pick it and tell them yourself. Without it, the link won&apos;t open —
                    even for you.
                  </span>
                </span>
              </label>
              {wantPassword && (
                <>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    placeholder="Something they'll know"
                    aria-label="Claim password"
                    className="w-full rounded-[14px] border border-line bg-paper px-3 py-3 text-ink"
                  />
                  <p className="text-xs text-ink-soft">
                    Tell them the password some other way: a call, or a different app. Put it in
                    the same chat as the link and it protects nothing. Pick something a stranger
                    wouldn&apos;t guess: whoever gets hold of the link can keep trying.
                  </p>
                  <p className="text-xs text-ink-soft">
                    Forget it and the money isn&apos;t stuck. It comes back to you after 7 days.
                  </p>
                </>
              )}
            </div>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          {/* Held until the balance is known when paying an ask: the amount
              arrives prefilled, so an instant tap could otherwise submit a
              guaranteed-underfunded pay before the "more than you have" guard
              has anything to compare against. */}
          <PrimaryButton
            loading={busy || (paying && balance === null)}
            loadingLabel={paying ? (busy ? "Paying…" : "One moment…") : "Making your link…"}
            onClick={send}
          >
            {paying
              ? `${copy.pay.payCta(shortName(request.name))}${amount ? ` ${formatUsd(amount)}` : ""}`
              : "Create a money link"}
          </PrimaryButton>
        </>
      )}
      {error && zeroBalance && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
