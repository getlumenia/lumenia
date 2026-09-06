"use client";

/**
 * /send-out/bank — cash out to a bank account in local currency, through an anchor.
 *
 * The other cash-out screen (/send-out) pays an exchange deposit address the person fetched by
 * hand. This one talks to a Stellar anchor over the standard protocols (SEP-1, SEP-10, SEP-12,
 * SEP-38, SEP-6 in lib/anchor.ts) so the person types an IBAN and an amount, sees a firm lira
 * figure, and approves once. The money still leaves on the SAME payout path as /send-out
 * (lib/payout.ts, fee-bumped under the sponsor's PAYOUT policy, signed by the person's own key):
 * the anchor names an account and a memo, and that is all it gets to do.
 *
 * WHAT THIS SCREEN SENDS TO THE ANCHOR, AND WHAT IT NEVER WILL. The bank account number the
 * person typed, for their own withdrawal, plus an optional bank name. That is a destination, the
 * same category as the exchange address on the other screen. No name, no email, no identity
 * number, no document: the anchor's own checks are its business under its own licence, and if
 * a rail demands documents this screen is not the place to give them.
 *
 * The rate is a SEP-38 quote with an expiry. It is shown as what the person will get, and the
 * withdrawal is opened against that quote id, so the anchor is held to it. An expired quote is
 * refused, not silently repriced.
 *
 * One held payment guards both cash-out screens: this page writes the same pending record as
 * /send-out before the payment leaves the device, and defers to /send-out to settle it against
 * the ledger, so a reload mid-flight can never turn into a second payment.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { useWallet } from "../../../../lib/wallet";
import { loadBalance } from "../../../../lib/horizon";
import {
  anchorHomeDomain,
  authenticate,
  readAnchorInfo,
  requestQuote,
  setBankAccount,
  type AnchorInfo,
  type AnchorQuote,
} from "../../../../lib/anchor";
import { createAnchorAdapter, type OffRampStatus } from "../../../../lib/offramp";
import { sendOut, PayoutUncertainError } from "../../../../lib/payout";
import { isNeedsPassword } from "../../../../lib/signer-error";
import { pinnedUsdcIssuer } from "../../../../lib/tx-guard";
import { formatUsd, sanitizeAmountInput } from "../../../../lib/money";
import { formatIban, isValidIban, normalizeIban } from "../../../../lib/iban";
import { sendEvent } from "../../../../lib/events";
import { activeNetwork, explorerTx } from "../../../../lib/network";
import { netKey } from "../../../../lib/scoped-store";
import { copy } from "../../../../lib/copy";
import { MoneyCard } from "../../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../../components/brand/PrimaryButton";
import type { Signer } from "../../../../lib/signer";

/** Draft of the form, this tab only, so the unlock detour does not wipe an IBAN. */
const DRAFT_KEY = () => netKey("lumenia.sendout.bank.draft");
/** THE SAME KEY as /send-out: one held payment, one guard, on both cash-out screens. */
const PENDING_KEY = () => netKey("lumenia.sendout.pending");
/** The last IBAN a payout was opened against. Local only, never sent anywhere but the anchor. */
const IBAN_KEY = () => netKey("lumenia.sendout.iban");

type Step = "form" | "review" | "sending" | "done";

interface Draft {
  amount?: string;
  iban?: string;
  bankName?: string;
  resumeAt?: number;
}

const STATUS_LINE: Record<OffRampStatus, string> = {
  idle: "",
  pending: "Talking to the bank rail…",
  "needs-the-person": "The bank rail needs you on its own screen.",
  sending: "Sending your dollars…",
  attestation: "Waiting for the network…",
  settling: "Paid. Waiting for the bank rail to confirm the payout…",
  done: "Done.",
  failed: "That did not finish.",
};

export default function BankCashOutPage() {
  const { status, account, getSigner, unlocked } = useWallet();
  const router = useRouter();
  const domain = anchorHomeDomain();

  const [balance, setBalance] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [iban, setIban] = useState("");
  const [bankName, setBankName] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [quote, setQuote] = useState<AnchorQuote | null>(null);
  const [rail, setRail] = useState<AnchorInfo | null>(null);
  const [progress, setProgress] = useState<OffRampStatus>("idle");
  const [hash, setHash] = useState("");
  /** Money left but the rail never confirmed inside the wait. Not an error: a receipt with a note. */
  const [lateNote, setLateNote] = useState("");
  /** A payment on either cash-out screen is still waiting for an answer. Nothing sends until it is settled. */
  const [held, setHeld] = useState(false);
  const [savedIban, setSavedIban] = useState("");

  // The SEP-10 session token lives here, in memory, for this mount only. Never persisted.
  const session = useRef<{ info: AnchorInfo; token: string; signer: Signer } | null>(null);
  const paidHash = useRef("");
  const resumed = useRef(false);

  useEffect(() => {
    if (account) void loadBalance(account.address).then((b) => setBalance(b?.usd ?? "0"));
  }, [account]);

  useEffect(() => {
    try {
      if (localStorage.getItem(PENDING_KEY())) setHeld(true);
      const last = localStorage.getItem(IBAN_KEY());
      if (last) setSavedIban(last);
    } catch {
      /* storage blocked */
    }
    try {
      const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY()) ?? "null") as Draft | null;
      if (d?.amount) setAmount(d.amount);
      if (d?.iban) setIban(d.iban);
      if (d?.bankName) setBankName(d.bankName);
    } catch {
      /* the form just starts empty */
    }
  }, []);

  /* After the unlock detour, fetch the rate again on the person's behalf. A quote moves no money,
     so this is safe to resume; the SEND is never resumed, it always waits for a tap. */
  useEffect(() => {
    if (status !== "ready" || !unlocked || busy || resumed.current || held) return;
    let d: Draft | null = null;
    try {
      d = JSON.parse(sessionStorage.getItem(DRAFT_KEY()) ?? "null") as Draft | null;
    } catch {
      return;
    }
    if (!d?.resumeAt || Date.now() - d.resumeAt > 120_000) return;
    if (!amount || !iban) return;
    resumed.current = true;
    try {
      sessionStorage.setItem(DRAFT_KEY(), JSON.stringify({ ...d, resumeAt: undefined }));
    } catch {
      /* the one-shot ref still holds */
    }
    void seeRate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, unlocked, busy, amount, iban, held]);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  if (!account) {
    if (typeof window !== "undefined") router.replace("/home");
    return null;
  }

  const cleanIban = normalizeIban(iban);
  const ibanOk = cleanIban !== "" && isValidIban(cleanIban);
  const amt = Math.round(Number.parseFloat(amount || "0") * 100) / 100;
  const quoteExpired = quote?.expiresAt ? Date.now() >= new Date(quote.expiresAt).getTime() : false;

  const errorBlock = error ? (
    <div className="text-sm text-danger">
      <p>{error}</p>
      {needsPassword && (
        <Link href="/account" className="mt-1 inline-block font-semibold text-money underline-offset-2 hover:underline">
          Set a password
        </Link>
      )}
    </div>
  ) : null;

  /** Sign in to the rail, tell it where the lira should land, and get a firm figure. No money moves. */
  async function seeRate() {
    setError("");
    setNeedsPassword(false);
    if (!domain) return;
    if (!Number.isFinite(amt) || amt < 0.01) return setError("Enter an amount to cash out.");
    if (balance !== null && amt > Number.parseFloat(balance)) return setError("That's more than you have.");
    if (!ibanOk) return setError("That IBAN doesn't check out. Copy it again from your bank app; a single wrong digit is caught here.");

    setBusy(true);
    try {
      let signer: Signer;
      try {
        signer = await getSigner();
      } catch (e) {
        if (isNeedsPassword(e)) {
          setError((e as Error).message || "Set a password first — it's what keeps this money yours if this phone is lost.");
          setNeedsPassword(true);
          return;
        }
        try {
          sessionStorage.setItem(DRAFT_KEY(), JSON.stringify({ amount, iban, bankName, resumeAt: Date.now() } satisfies Draft));
        } catch {
          /* the form is lost, no money moved */
        }
        router.push(`/unlock?next=${encodeURIComponent("/send-out/bank")}`);
        return;
      }

      const info = await readAnchorInfo(domain);
      if (info.door !== "sep6") {
        return setError("This bank rail asks you to finish on its own screen, which this page doesn't do yet.");
      }
      if (!info.kycServer) return setError("This bank rail can't take a bank account number, so it can't pay you out.");
      if (!info.quoteServer) return setError("This bank rail doesn't quote a rate up front, so we can't tell you what you'd get.");

      const token = await authenticate(info, signer);
      await setBankAccount(info, token, {
        account: account!.address,
        bankAccountNumber: cleanIban,
        ...(bankName.trim() ? { bankName: bankName.trim() } : {}),
      });
      const q = await requestQuote(info, token, {
        sellAssetCode: "USDC",
        sellAssetIssuer: pinnedUsdcIssuer(activeNetwork().id),
        buyAsset: "iso4217:TRY",
        sellAmount: amt.toFixed(2),
      });
      session.current = { info, token, signer };
      setRail(info);
      setQuote(q);
      setUnderstood(false);
      setStep("review");
    } catch (e) {
      console.error("[send-out/bank] rate", e);
      // Nothing has moved at this point, so the anchor's own words are safe to show.
      setError(e instanceof Error && e.message ? `Couldn't get a rate: ${e.message}` : "Couldn't reach the bank rail just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  /** Open the withdrawal against the quote and pay the account the rail names, once. */
  async function confirm() {
    if (!session.current || !quote) return;
    setError("");
    if (quoteExpired) {
      setStep("form");
      setQuote(null);
      return setError("That rate expired. Get a fresh one before sending.");
    }
    const { info, signer } = session.current;
    const adapter = createAnchorAdapter(
      {
        signer,
        account: account!.address,
        assetCode: "USDC",
        assetIssuer: pinnedUsdcIssuer(activeNetwork().id),
        fiatAsset: "iso4217:TRY",
        fiatDestination: cleanIban,
        quoteId: quote.id,
        openInteractive: (url) => {
          window.open(url, "_blank", "noopener");
        },
        pay: async (r) => {
          if (r.memoType === "hash") throw new Error("this bank rail asked for a kind of reference we can't attach");
          const res = await sendOut({
            sponsorUrl: activeNetwork().sponsorUrl,
            signer,
            amount: (Math.round(Number.parseFloat(r.amount) * 100) / 100).toFixed(2),
            destination: r.destination,
            memo: r.memo ?? undefined,
            memoKind: r.memoType === "id" ? "id" : r.memoType === "text" ? "text" : "none",
            /* THE LATCH, shared with /send-out: written before the payment leaves this device. */
            onHandedOver: ({ hash: h, retrySafeAfter }) => {
              try {
                localStorage.setItem(
                  PENDING_KEY(),
                  JSON.stringify({ amount: r.amount, at: new Date().toISOString(), hash: h, retrySafeAfter }),
                );
              } catch {
                /* the adapter's own in-memory latch still holds */
              }
            },
          });
          paidHash.current = res.hash;
          setHash(res.hash);
          try {
            localStorage.removeItem(PENDING_KEY());
          } catch {
            /* nothing was written */
          }
        },
      },
      info.homeDomain,
    );
    if (!adapter) return;

    setBusy(true);
    setStep("sending");
    try {
      await adapter.start(amt.toFixed(2), setProgress);
      void sendEvent("cashout_sent", account!.address, account!.address);
      try {
        localStorage.setItem(IBAN_KEY(), cleanIban);
        sessionStorage.removeItem(DRAFT_KEY());
      } catch {
        /* conveniences only */
      }
      setStep("done");
    } catch (e) {
      console.error("[send-out/bank]", e);
      if (e instanceof PayoutUncertainError) {
        // The held record is already on the device; /send-out is the screen that settles it.
        router.push("/send-out");
        return;
      }
      if (paidHash.current) {
        /* The dollars left and are on the record; only the rail's confirmation is missing. That
           is a receipt with a note, never "your money hasn't moved". */
        setLateNote(
          e instanceof Error && e.message
            ? `The bank rail hasn't confirmed the payout yet (${e.message}). Your dollars are on the public record below; the rail's side runs on its clock.`
            : "The bank rail hasn't confirmed the payout yet. Your dollars are on the public record below.",
        );
        setStep("done");
        return;
      }
      setStep("review");
      /* Nothing was paid (the latch above would have set paidHash), so the rail's own words are
         safe and useful: "Minimum off-ramp is 1 USDC" tells the person exactly what to change.
         The sponsor's wire errors are not for people; those get the plain sentence. */
      const msg = e instanceof Error ? e.message : "";
      setError(msg && !msg.startsWith("/payout") ? `${msg}. Your money hasn't moved.` : copy.errors.moneySafe);
    } finally {
      setBusy(false);
    }
  }

  if (!domain) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <h1 className="text-xl font-bold text-ink">Cash out to a bank account</h1>
        <p className="text-sm text-ink-soft">
          No bank rail is connected on this network yet. You can still move your dollars to an
          exchange and withdraw from there.
        </p>
        <Link href="/send-out" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          Send to an exchange instead
        </Link>
      </div>
    );
  }

  if (held) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <h1 className="text-xl font-bold text-ink">One cash-out is still waiting for an answer</h1>
        <p className="text-sm text-ink-soft">
          A payment was handed to the network and not yet confirmed. Settle that one first; sending
          another now could pay twice.
        </p>
        <Link href="/send-out" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          See where it stands
        </Link>
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="flex flex-col gap-4 py-6">
        <h1 className="text-xl font-bold text-ink">{lateNote ? "Sent, awaiting the bank rail" : "On its way to your bank"}</h1>
        <p className="text-ink-soft">
          {formatUsd(amt.toFixed(2))} left your account.
          {quote ? ` The rail quoted ${quote.buyAmount} TRY for it, paid to ${formatIban(cleanIban)}.` : ""}
        </p>
        {lateNote && <p className="text-sm text-ink-soft">{lateNote}</p>}
        <MoneyCard className="p-4">
          <p className="text-sm text-ink">Our part is finished.</p>
          <p className="mt-1 text-sm text-ink-soft">
            The bank transfer itself is made by {rail?.homeDomain ?? "the rail"}, on its own timing
            and under its own rules. Your dollars moved the moment you tapped, and the record below
            proves it.
          </p>
        </MoneyCard>
        {hash && (
          <MoneyCard className="p-4">
            <p className="text-sm text-ink">The public record of this transfer</p>
            <p className="mt-1 break-all font-mono text-xs text-ink-soft">{hash}</p>
            <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm font-medium text-money underline-offset-2 hover:underline">
              Open it ↗
            </a>
          </MoneyCard>
        )}
        <Link href="/account" className="text-sm text-ink-soft underline-offset-2 hover:underline">
          Back to my account
        </Link>
      </div>
    );
  }

  if (step === "sending") {
    return (
      <div className="flex flex-col gap-4 py-6">
        <h1 className="text-xl font-bold text-ink">Sending</h1>
        <p className="text-sm text-ink-soft">{STATUS_LINE[progress] || "Working…"}</p>
        <p className="text-xs text-ink-soft">Keep this screen open. Nothing here sends twice.</p>
      </div>
    );
  }

  if (step === "review" && quote) {
    const expiresAt = quote.expiresAt ? new Date(quote.expiresAt) : null;
    return (
      <div className="flex flex-col gap-5 py-4">
        <button onClick={() => setStep("form")} className="flex items-center gap-1 self-start text-sm text-ink-soft">
          <ArrowLeft className="size-4" /> Change something
        </button>
        <header>
          <h1 className="text-xl font-bold text-ink">Read this before you send</h1>
          <p className="mt-1 text-sm text-ink-soft">This one can&apos;t be undone.</p>
        </header>

        <MoneyCard className="p-5">
          <dl className="flex flex-col divide-y divide-line">
            <div className="flex items-baseline justify-between gap-3 pb-3">
              <dt className="text-sm text-ink-soft">You send</dt>
              <dd className="text-lg font-bold tabular-nums text-ink">{formatUsd(quote.sellAmount)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-3">
              <dt className="text-sm text-ink-soft">You get</dt>
              <dd className="text-lg font-bold tabular-nums text-ink">{quote.buyAmount} TRY</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-3">
              <dt className="text-sm text-ink-soft">To</dt>
              <dd className="text-right font-mono text-xs text-ink">{formatIban(cleanIban)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 pt-3">
              <dt className="text-sm text-ink-soft">Rate held until</dt>
              <dd className={`text-sm ${quoteExpired ? "text-danger" : "text-ink"}`}>
                {expiresAt ? expiresAt.toLocaleTimeString() : "the rail did not say"}
                {quoteExpired ? " (expired)" : ""}
              </dd>
            </div>
          </dl>
        </MoneyCard>

        <MoneyCard className="border-danger/40 p-5">
          <p className="flex items-center gap-2 font-semibold text-ink">
            <AlertTriangle className="size-4 text-danger" />
            What you are agreeing to
          </p>
          <ul className="mt-2 flex list-disc flex-col gap-2 pl-5 text-sm text-ink-soft">
            <li>
              <strong className="text-ink">The lira figure is the rail&apos;s promise, not ours.</strong>{" "}
              {rail?.homeDomain} quoted it and is held to it until the time above. The bank
              transfer is theirs to make, on their timing and under their rules.
            </li>
            <li>
              <strong className="text-ink">The IBAN is yours to check.</strong>{" "}We checked that it is
              a well-formed account number; only you can check that it is your account.
            </li>
            <li>
              <strong className="text-ink">We sent the rail your IBAN and nothing else.</strong>{" "}No
              name, no identity number, no document. If the rail ever asks for those, it asks you
              directly, not through us.
            </li>
          </ul>
        </MoneyCard>

        <label className="flex items-start gap-3 text-sm text-ink">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-1 size-4 accent-[var(--color-money,currentColor)]" />
          <span>That is my IBAN, and I understand the lira arrives on the rail&apos;s timing.</span>
        </label>

        {errorBlock}

        <PrimaryButton loading={busy} loadingLabel="Sending…" disabled={!understood || quoteExpired} onClick={confirm}>
          Send {formatUsd(quote.sellAmount)}
        </PrimaryButton>
        {quoteExpired && (
          <button type="button" onClick={() => void seeRate()} className="self-start text-sm font-semibold text-money underline-offset-2 hover:underline">
            Get a fresh rate
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Cash out to your bank</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Type the IBAN and the amount. You&apos;ll see the lira figure before anything is sent, and
          you approve once. Prefer an exchange?{" "}
          <Link href="/send-out" className="text-money underline-offset-2 hover:underline">
            Send to an exchange instead
          </Link>
          .
        </p>
        {balance !== null && <p className="mt-2 text-sm text-ink-soft">You have {formatUsd(balance)} to cash out.</p>}
      </header>

      {savedIban && iban.trim() === "" && (
        <MoneyCard className="p-4">
          <p className="text-sm font-semibold text-ink">Same account as last time</p>
          <p className="mt-1 font-mono text-xs text-ink-soft">{formatIban(savedIban)}</p>
          <button onClick={() => setIban(savedIban)} className="mt-3 flex h-10 items-center rounded-full border border-money px-4 text-sm font-medium text-money">
            Use this again
          </button>
        </MoneyCard>
      )}

      <label className="text-sm text-ink-soft">
        Your IBAN
        <input
          value={iban}
          onChange={(e) => setIban(e.target.value)}
          spellCheck={false}
          autoCapitalize="characters"
          placeholder="TR00 0000 0000 0000 0000 0000 00"
          className="mt-1 w-full rounded-[14px] border border-line bg-surface px-3 py-3 font-mono text-sm text-ink outline-none"
        />
      </label>
      {iban.trim() !== "" && !ibanOk && (
        <p className="-mt-3 text-sm text-danger">That IBAN doesn&apos;t check out yet. A Turkish IBAN is 26 characters starting with TR.</p>
      )}

      <label className="text-sm text-ink-soft">
        Bank name (optional)
        <input
          value={bankName}
          onChange={(e) => setBankName(e.target.value)}
          placeholder="e.g. Ziraat"
          className="mt-1 w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-sm text-ink outline-none"
        />
      </label>

      <label className="text-sm text-ink-soft">
        Amount
        <div className="mt-1 flex items-center rounded-[14px] border border-line bg-surface px-3">
          <span className="text-lg text-ink-soft">$</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(sanitizeAmountInput(e.target.value))}
            placeholder="0.00"
            className="w-full bg-transparent px-2 py-3 text-lg text-ink outline-none"
          />
          {balance !== null && Number.parseFloat(balance) > 0 && (
            <button
              type="button"
              onClick={() => setAmount((Math.floor(Number.parseFloat(balance) * 100) / 100).toFixed(2))}
              className="shrink-0 rounded-full border border-line px-3 py-1 text-xs font-medium text-money"
            >
              All of it
            </button>
          )}
        </div>
      </label>

      <p className="text-xs text-ink-soft">
        The rail is {domain}. We send it your IBAN and the amount, nothing about who you are.
      </p>

      {errorBlock}

      <PrimaryButton loading={busy} loadingLabel="Getting the rate…" disabled={!ibanOk || !(amt > 0)} onClick={() => void seeRate()}>
        See what you&apos;d get
      </PrimaryButton>
    </div>
  );
}
