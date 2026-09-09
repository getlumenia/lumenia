"use client";

/**
 * /send-out/bank — cash out to a bank account in local currency, through an anchor, SEP-6 only.
 *
 * The other cash-out screen (/send-out) pays an exchange deposit address the person fetched by
 * hand. This one talks to a Stellar anchor over the standard door: SEP-1 discovery, SEP-10
 * sign-in, SEP-6 withdrawal (lib/anchor.ts). The money still leaves on the SAME payout path as
 * /send-out (lib/payout.ts, fee-bumped under the sponsor's PAYOUT policy, signed by the person's
 * own key): the anchor names an account and a memo, and that is all it gets to do.
 *
 * SEP-6 ONLY, BY DECISION (owner, 2026-09-09, on the organisers' guidance for the hackathon). No
 * SEP-12 (so this screen sends nothing about the person, not even a bank account number) and no
 * SEP-38 (so it quotes no figure of its own). What it shows before the person approves is the
 * anchor's own sentence about the withdrawal, verbatim: the rate it locked, until when, and the
 * bank account it will pay. That account is whatever the anchor holds for this wallet; on the
 * sandbox anchor it is one the anchor derives itself. The screen says so rather than pretending
 * an IBAN field it cannot honour.
 *
 * What the person is agreeing to is therefore exactly what the anchor said, nothing more. If an
 * anchor says nothing, the screen shows the destination and memo and calls the rest unknown.
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
  readWithdrawal,
  startWithdrawal,
  type AnchorInfo,
  type OpenedWithdrawal,
} from "../../../../lib/anchor";
import { sendOut, PayoutUncertainError } from "../../../../lib/payout";
import { isNeedsPassword } from "../../../../lib/signer-error";
import { formatUsd, sanitizeAmountInput } from "../../../../lib/money";
import { formatIban } from "../../../../lib/iban";
import { sendEvent } from "../../../../lib/events";
import { activeNetwork, explorerTx } from "../../../../lib/network";
import { netKey } from "../../../../lib/scoped-store";
import { copy } from "../../../../lib/copy";
import { MoneyCard } from "../../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../../components/brand/PrimaryButton";
import type { Signer } from "../../../../lib/signer";

/** Draft of the form, this tab only, so the unlock detour does not wipe the amount. */
const DRAFT_KEY = () => netKey("lumenia.sendout.bank.draft");
/** THE SAME KEY as /send-out: one held payment, one guard, on both cash-out screens. */
const PENDING_KEY = () => netKey("lumenia.sendout.pending");

type Step = "form" | "review" | "sending" | "done";
type Ready = Extract<OpenedWithdrawal, { kind: "ready-to-pay" }>;

interface Draft {
  amount?: string;
  resumeAt?: number;
}

/** How long to wait for the anchor to confirm after we have paid, before calling it late. */
const SETTLE_TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 3_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pull the three things a person wants out of the anchor's sentence, when they are there. This
 * is display only: the sentence itself is always shown, and nothing here changes what is sent.
 */
function readNote(note: string | null): { rate: string | null; until: Date | null; iban: string | null } {
  if (!note) return { rate: null, until: null, iban: null };
  const rate = note.match(/Rate\s+([\d.]+)\s*TRY\/USDC/i)?.[1] ?? null;
  const untilRaw = note.match(/until\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i)?.[1];
  const until = untilRaw ? new Date(untilRaw) : null;
  const iban = note.match(/\b([A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/)?.[1] ?? null;
  return { rate, until: until && !Number.isNaN(until.getTime()) ? until : null, iban };
}

export default function BankCashOutPage() {
  const { status, account, getSigner, unlocked } = useWallet();
  const router = useRouter();
  const domain = anchorHomeDomain();

  const [balance, setBalance] = useState<string | null>(null);
  /** Old-issuer practice dollars this account still holds; shown as such, never as spendable. */
  const [legacy, setLegacy] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [opened, setOpened] = useState<Ready | null>(null);
  const [rail, setRail] = useState<AnchorInfo | null>(null);
  const [progress, setProgress] = useState("");
  const [hash, setHash] = useState("");
  /** Money left but the rail never confirmed inside the wait. Not an error: a receipt with a note. */
  const [lateNote, setLateNote] = useState("");
  /** A payment on either cash-out screen is still waiting for an answer. Nothing sends until it is settled. */
  const [held, setHeld] = useState(false);

  // The SEP-10 session token lives here, in memory, for this mount only. Never persisted.
  const session = useRef<{ info: AnchorInfo; token: string; signer: Signer } | null>(null);
  const paidHash = useRef("");
  const resumed = useRef(false);

  useEffect(() => {
    if (account)
      void loadBalance(account.address).then((b) => {
        setBalance(b?.usd ?? "0");
        setLegacy(b?.legacyUsd ?? null);
      });
  }, [account]);

  useEffect(() => {
    try {
      if (localStorage.getItem(PENDING_KEY())) setHeld(true);
    } catch {
      /* storage blocked */
    }
    try {
      const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY()) ?? "null") as Draft | null;
      if (d?.amount) setAmount(d.amount);
    } catch {
      /* the form just starts empty */
    }
  }, []);

  /* After the unlock detour, open the withdrawal again on the person's behalf. Opening moves no
     money, so this is safe to resume; the SEND is never resumed, it always waits for a tap. */
  useEffect(() => {
    if (status !== "ready" || !unlocked || busy || resumed.current || held) return;
    let d: Draft | null = null;
    try {
      d = JSON.parse(sessionStorage.getItem(DRAFT_KEY()) ?? "null") as Draft | null;
    } catch {
      return;
    }
    if (!d?.resumeAt || Date.now() - d.resumeAt > 120_000) return;
    if (!amount) return;
    resumed.current = true;
    try {
      sessionStorage.setItem(DRAFT_KEY(), JSON.stringify({ ...d, resumeAt: undefined }));
    } catch {
      /* the one-shot ref still holds */
    }
    void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, unlocked, busy, amount, held]);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  if (!account) {
    if (typeof window !== "undefined") router.replace("/home");
    return null;
  }

  const amt = Math.round(Number.parseFloat(amount || "0") * 100) / 100;
  const note = readNote(opened?.note ?? null);
  const expired = note.until ? Date.now() >= note.until.getTime() : false;
  const estimate = note.rate ? (amt * Number.parseFloat(note.rate)).toFixed(2) : null;

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

  /** Sign in to the rail and open the withdrawal. No money moves; the rail names where to pay and what it locked. */
  async function open() {
    setError("");
    setNeedsPassword(false);
    if (!domain) return;
    if (!Number.isFinite(amt) || amt < 0.01) return setError("Enter an amount to cash out.");
    if (balance !== null && amt > Number.parseFloat(balance)) return setError("That's more than you have.");

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
          sessionStorage.setItem(DRAFT_KEY(), JSON.stringify({ amount, resumeAt: Date.now() } satisfies Draft));
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
      const token = await authenticate(info, signer);
      // Plain SEP-6 /withdraw: no quote id, no destination asset, no customer fields. The anchor
      // prices it at its own locked rate and pays to whatever account it holds for this wallet.
      const w = await startWithdrawal(info, token, { assetCode: "USDC", account: account!.address, amount: amt.toFixed(2) });
      if (w.kind !== "ready-to-pay") return setError("This bank rail did not name where to pay.");
      session.current = { info, token, signer };
      setRail(info);
      setOpened(w);
      setUnderstood(false);
      setStep("review");
    } catch (e) {
      console.error("[send-out/bank] open", e);
      // Nothing has moved at this point, so the anchor's own words are safe to show.
      setError(e instanceof Error && e.message ? `The bank rail said: ${e.message}` : "Couldn't reach the bank rail just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  /** Pay the account the rail named, once, then wait for the rail to confirm. */
  async function confirm() {
    if (!session.current || !opened) return;
    setError("");
    if (expired) {
      setStep("form");
      setOpened(null);
      return setError("The rail's rate expired. Open it again before sending.");
    }
    if (opened.memoType === "hash") return setError("This bank rail asked for a kind of reference we can't attach. Your money hasn't moved.");
    const { info, token, signer } = session.current;

    setBusy(true);
    setStep("sending");
    setProgress("Sending your dollars…");
    try {
      const res = await sendOut({
        sponsorUrl: activeNetwork().sponsorUrl,
        signer,
        amount: amt.toFixed(2),
        destination: opened.destination,
        memo: opened.memo ?? undefined,
        memoKind: opened.memoType === "id" ? "id" : opened.memoType === "text" ? "text" : "none",
        /* THE LATCH, shared with /send-out: written before the payment leaves this device. */
        onHandedOver: ({ hash: h, retrySafeAfter }) => {
          try {
            localStorage.setItem(PENDING_KEY(), JSON.stringify({ amount: amt.toFixed(2), at: new Date().toISOString(), hash: h, retrySafeAfter }));
          } catch {
            /* the in-memory state below still holds for this mount */
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
      void sendEvent("cashout_sent", account!.address, account!.address);
      try {
        sessionStorage.removeItem(DRAFT_KEY());
      } catch {
        /* convenience only */
      }

      // Paid exactly once, above. From here we only READ the rail; nothing in this loop sends.
      setProgress("Paid. Waiting for the bank rail to confirm the payout…");
      const deadline = Date.now() + SETTLE_TIMEOUT_MS;
      for (;;) {
        if (Date.now() > deadline) {
          setLateNote("The bank rail hasn't confirmed the payout yet. Your dollars are on the public record below; the rail's side runs on its clock.");
          break;
        }
        await sleep(POLL_MS);
        const state = await readWithdrawal(info, token, opened.id);
        if (state.status === "settled") break;
        if (state.status === "refunded") {
          setLateNote("The bank rail says it sent the money back. Check your balance and the record below.");
          break;
        }
        if (state.status === "failed") {
          setLateNote(`The bank rail reported a problem after the payment: ${state.reason}. Your dollars are on the public record below.`);
          break;
        }
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
        setLateNote("The bank rail could not be reached after the payment. Your dollars are on the public record below.");
        setStep("done");
        return;
      }
      setStep("review");
      const msg = e instanceof Error ? e.message : "";
      if (/underfunded/i.test(msg)) {
        setError("This account doesn't hold enough of these dollars, so nothing moved. Old practice dollars from before 6 September don't count; get fresh ones from Add money.");
        return;
      }
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
        <h1 className="text-xl font-bold text-ink">{lateNote ? "Sent, awaiting the bank rail" : "On its way to the bank"}</h1>
        <p className="text-ink-soft">
          {formatUsd(amt.toFixed(2))} left your account.
          {note.iban ? ` The rail said it pays to ${formatIban(note.iban)}.` : ""}
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
        <p className="text-sm text-ink-soft">{progress || "Working…"}</p>
        <p className="text-xs text-ink-soft">Keep this screen open. Nothing here sends twice.</p>
      </div>
    );
  }

  if (step === "review" && opened) {
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
              <dd className="text-lg font-bold tabular-nums text-ink">{formatUsd(amt.toFixed(2))}</dd>
            </div>
            {estimate && (
              <div className="flex items-baseline justify-between gap-3 py-3">
                <dt className="text-sm text-ink-soft">About</dt>
                <dd className="text-lg font-bold tabular-nums text-ink">{estimate} TRY</dd>
              </div>
            )}
            {note.iban && (
              <div className="flex items-baseline justify-between gap-3 py-3">
                <dt className="text-sm text-ink-soft">To</dt>
                <dd className="text-right font-mono text-xs text-ink">{formatIban(note.iban)}</dd>
              </div>
            )}
            {note.until && (
              <div className="flex items-baseline justify-between gap-3 pt-3">
                <dt className="text-sm text-ink-soft">Rate held until</dt>
                <dd className={`text-sm ${expired ? "text-danger" : "text-ink"}`}>
                  {note.until.toLocaleTimeString()}
                  {expired ? " (expired)" : ""}
                </dd>
              </div>
            )}
          </dl>
        </MoneyCard>

        {/* The anchor's own words, whole. The figures above are read out of this sentence for
            convenience; the sentence is the source and it is shown so nothing is lost in reading. */}
        <MoneyCard className="p-4">
          <p className="text-sm font-semibold text-ink">What the rail said</p>
          <p className="mt-1 text-sm text-ink-soft">
            {opened.note ?? `Pay ${opened.destination} with reference ${opened.memo ?? "(none)"}. The rail gave no further detail.`}
          </p>
        </MoneyCard>

        <MoneyCard className="border-danger/40 p-5">
          <p className="flex items-center gap-2 font-semibold text-ink">
            <AlertTriangle className="size-4 text-danger" />
            What you are agreeing to
          </p>
          <ul className="mt-2 flex list-disc flex-col gap-2 pl-5 text-sm text-ink-soft">
            <li>
              <strong className="text-ink">The lira figure is the rail&apos;s statement, not ours.</strong>{" "}
              {rail?.homeDomain} locked that rate and pays the bank transfer on its own timing and
              under its own rules.
            </li>
            <li>
              <strong className="text-ink">The bank account is the one the rail holds for this wallet.</strong>{" "}
              We did not send it an account number, and we sent nothing about who you are. If that
              account is not yours, do not send; the rail is where to change it.
            </li>
          </ul>
        </MoneyCard>

        <label className="flex items-start gap-3 text-sm text-ink">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-1 size-4 accent-[var(--color-money,currentColor)]" />
          <span>I read what the rail said, and I understand the lira arrives on the rail&apos;s timing.</span>
        </label>

        {errorBlock}

        <PrimaryButton loading={busy} loadingLabel="Sending…" disabled={!understood || expired} onClick={confirm}>
          Send {formatUsd(amt.toFixed(2))}
        </PrimaryButton>
        {expired && (
          <button type="button" onClick={() => void open()} className="self-start text-sm font-semibold text-money underline-offset-2 hover:underline">
            Open it again
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
          Type the amount. The bank rail will tell you the rate it locks and the account it pays,
          and you approve once. Prefer an exchange?{" "}
          <Link href="/send-out" className="text-money underline-offset-2 hover:underline">
            Send to an exchange instead
          </Link>
          .
        </p>
        {balance !== null && <p className="mt-2 text-sm text-ink-soft">You have {formatUsd(balance)} to cash out.</p>}
        {legacy && (
          <p className="mt-2 text-sm text-ink-soft">
            This account also holds {formatUsd(legacy)} of old practice dollars from before 6 September.
            Those can&apos;t be sent any more; get fresh practice dollars from{" "}
            <Link href="/add-money" className="text-money underline-offset-2 hover:underline">
              Add money
            </Link>
            .
          </p>
        )}
      </header>

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
        The rail is {domain}. We send it the amount and nothing about who you are; it pays the bank
        account it already holds for this wallet.
      </p>

      {errorBlock}

      <PrimaryButton loading={busy} loadingLabel="Asking the rail…" disabled={!(amt > 0)} onClick={() => void open()}>
        See what the rail says
      </PrimaryButton>
    </div>
  );
}
