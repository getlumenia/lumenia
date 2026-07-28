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
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../lib/wallet";
import { loadBalance } from "../../../lib/horizon";
import { payToAddress } from "../../../lib/send";
import { createV2Link } from "../../../lib/lumendrop";
import { claimPasswordProblem } from "../../../lib/claim-password";
import { isValidAddress } from "../../../lib/request";
import { sendEvent } from "../../../lib/events";
import { formatUsd } from "../../../lib/money";
import { copy } from "../../../lib/copy";
import { AmountDisplay } from "../../../components/brand/AmountDisplay";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";
import { LinkReadyCard } from "../../../components/brand/LinkReadyCard";

const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.vercel.app";

interface SentRecord {
  balanceId: string;
  link: string;
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
    const all = JSON.parse(localStorage.getItem("lumenia.sent") ?? "{}") as Record<string, SentRecord>;
    all[id] = rec;
    localStorage.setItem("lumenia.sent", JSON.stringify(all));
  } catch {
    /* localStorage blocked — the link still works, just no local tracking */
  }
}

/** First name, capped — the submit button is nowrap and must survive 40-char names. */
function shortName(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? name).slice(0, 12);
}

export default function SendPage() {
  const { status, account, getSigner } = useWallet();
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
  const [ready, setReady] = useState<Ready | null>(null);

  useEffect(() => {
    if (account) void loadBalance(account.address).then((b) => setBalance(b?.usd ?? "0"));
  }, [account]);

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

  async function getTestMoney() {
    setFaucetBusy(true);
    setError("");
    try {
      const res = await fetch(`${SPONSOR_URL}/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipientPublicKey: account!.address }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "faucet unavailable");
      const b = await loadBalance(account!.address);
      setBalance(b?.usd ?? "0");
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
          sponsorUrl: SPONSOR_URL,
          signer,
          amount: amt.toFixed(2),
          to: directTo,
        });
        saveSent(result.balanceId.slice(-8), {
          balanceId: result.balanceId,
          link: "", // no bearer link exists — the money is already the asker's to collect
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
        sponsorUrl: SPONSOR_URL,
        signer,
        amount: amt.toFixed(2),
        from: from.trim(),
        webOrigin: window.location.origin,
        password: lockWith || undefined,
      });
      saveSent(result.linkHex.slice(-8), {
        balanceId: result.linkHex, // the v2 drop id (the link key); reused by "my links"
        link: result.link,
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
      // Technical reasons (status codes, ledger result codes) must never reach a
      // money surface (vocabulary law); a rejected inner tx means nothing moved.
      console.error("[send]", e);
      setError(copy.errors.moneySafe);
    } finally {
      setBusy(false);
    }
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
        <h1 className="text-xl font-bold text-ink">Done — share the link</h1>
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
        <div className="flex flex-col gap-3">
          <p className="text-ink-soft">You don&apos;t have any money to send yet.</p>
          <PrimaryButton loading={faucetBusy} loadingLabel="Getting test money…" onClick={getTestMoney}>
            Get test money
          </PrimaryButton>
          <p className="text-xs text-ink-soft">Test network — this money isn&apos;t real.</p>
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
          {!request?.to && (
            <label className="text-sm text-ink-soft">
              Your name
              <input
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="e.g. Alex"
                className="mt-1 w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-ink"
              />
            </label>
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
                <span>
                  <span className="font-medium text-ink">Lock it with a password</span>
                  <span className="block text-ink-soft">
                    Only someone who knows it can claim the link.
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
                    Tell them the password some other way — a call, or a different app. Put it in
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
