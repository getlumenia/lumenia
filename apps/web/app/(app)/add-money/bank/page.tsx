"use client";

/**
 * /add-money/bank: lira in, through an anchor, SEP-6 only (hackathon build, 2026-09-19, decision
 * register D27 item 2.1). The inverse of /send-out/bank.
 *
 * The person types an amount in lira. The anchor opens a transfer for THEIR account (created and
 * trustlined by the sponsor, so the anchor always meets a ready account) and answers with where
 * to send the lira and under which reference. This screen shows those instructions exactly as the
 * anchor sent them, then watches the transfer until the dollars land on the ledger, and links the
 * Stellar payment. Nothing here signs or pays anything except the SEP-10 sign-in: the anchor is the
 * one that sends the dollars.
 *
 * SEP-6 ONLY, BY DECISION (D2): no SEP-12 (nothing about the person is sent) and no SEP-38 (no
 * quote of ours; the anchor's own sentence about its rate is shown verbatim).
 *
 * THE SANDBOX'S BANK. The Turkish sandbox anchor has no real bank behind it, so on the test network
 * a clearly labelled button plays the person's bank (`simulateBankTransfer`, which refuses to run
 * anywhere else). On a real anchor that button does not exist: the person pays from their own
 * bank app with the reference, and this screen simply keeps watching.
 *
 * The last completed run is kept on this device (lib/rail-record.ts) so the event board can show
 * the lira rail's latest round trip with its hashes, without any server storing it.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { useWallet } from "../../../../lib/wallet";
import { loadBalance } from "../../../../lib/horizon";
import { prepareAccount } from "../../../../lib/sponsor";
import {
  anchorHomeDomain,
  authenticate,
  readAnchorInfo,
  readDeposit,
  simulateBankTransfer,
  startDeposit,
  withSession,
  type AnchorDepositState,
  type AnchorSession,
  type DepositInstruction,
  type OpenedDeposit,
} from "../../../../lib/anchor";
import { isNeedsPassword } from "../../../../lib/signer-error";
import { formatUsd, sanitizeAmountInput } from "../../../../lib/money";
import { formatIban } from "../../../../lib/iban";
import { sendEvent } from "../../../../lib/events";
import { activeNetwork, explorerTx } from "../../../../lib/network";
import { netKey } from "../../../../lib/scoped-store";
import { RAIL_LAST_DEPOSIT_KEY, saveRailRun } from "../../../../lib/rail-record";
import { MoneyCard } from "../../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../../components/brand/PrimaryButton";
import type { Signer } from "../../../../lib/signer";

/** Draft of the form, this tab only, so the unlock detour does not wipe the amount. */
const DRAFT_KEY = () => netKey("lumenia.addmoney.bank.draft");

type Step = "form" | "instructions" | "done";

interface Draft {
  amount?: string;
  resumeAt?: number;
}

const POLL_MS = 3_000;
/** How long the screen watches for the bank transfer to arrive. A real transfer can take longer; the reference stays valid at the anchor. */
const TRANSFER_WAIT_MS = 30 * 60_000;
/** Once the anchor has the lira, how long before we call the dollar payment late. */
const SETTLE_WAIT_MS = 3 * 60_000;
/** Consecutive failed status reads that end the wait (same rule as /send-out/bank). */
const MAX_POLL_MISSES = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plain names for the fields the sandbox anchor sends; anything else keeps the anchor's own words. */
function label(i: DepositInstruction): string {
  switch (i.key) {
    case "bank_name":
      return "Bank";
    case "bank_account_number":
      return "IBAN";
    case "external_transfer_memo":
      return "Reference";
    default:
      return i.description ?? i.key.replace(/_/g, " ");
  }
}

function display(i: DepositInstruction): string {
  return i.key === "bank_account_number" ? formatIban(i.value) : i.value;
}

export default function BankAddMoneyPage() {
  const { status, account, getSigner, unlocked } = useWallet();
  const router = useRouter();
  const domain = anchorHomeDomain();
  const net = activeNetwork();

  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [opened, setOpened] = useState<OpenedDeposit | null>(null);
  const [stage, setStage] = useState<"awaiting-transfer" | "processing">("awaiting-transfer");
  const [simBusy, setSimBusy] = useState(false);
  const [result, setResult] = useState<Extract<AnchorDepositState, { status: "settled" }> | null>(null);
  const [lateNote, setLateNote] = useState("");
  const [copiedKey, setCopiedKey] = useState("");
  const [elapsed, setElapsed] = useState<number | null>(null);

  // The SEP-10 session token lives here, in memory, for this mount only. Never persisted.
  const session = useRef<AnchorSession | null>(null);
  const watching = useRef(false);
  const startedAt = useRef(0);
  const resumed = useRef(false);

  useEffect(() => {
    try {
      const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY()) ?? "null") as Draft | null;
      if (d?.amount) setAmount(d.amount);
    } catch {
      /* the form just starts empty */
    }
  }, []);

  /* After the unlock detour, open the transfer again on the person's behalf. Opening moves no
     money (it only asks the anchor for instructions), so resuming it is safe. */
  useEffect(() => {
    if (status !== "ready" || !unlocked || busy || resumed.current || step !== "form") return;
    let d: Draft | null = null;
    try {
      d = JSON.parse(sessionStorage.getItem(DRAFT_KEY()) ?? "null") as Draft | null;
    } catch {
      return;
    }
    if (!d?.resumeAt || Date.now() - d.resumeAt > 120_000 || !amount) return;
    resumed.current = true;
    try {
      sessionStorage.setItem(DRAFT_KEY(), JSON.stringify({ ...d, resumeAt: undefined }));
    } catch {
      /* the one-shot ref still holds */
    }
    void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, unlocked, busy, amount, step]);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  if (!account) {
    if (typeof window !== "undefined") router.replace("/home");
    return null;
  }

  const amt = Math.round(Number.parseFloat(amount || "0") * 100) / 100;

  /** Sign in to the anchor and ask it to open a lira-in transfer for this account. No money moves. */
  async function open() {
    setError("");
    setNeedsPassword(false);
    if (!domain) return;
    if (!Number.isFinite(amt) || amt <= 0) return setError("Enter an amount in lira.");

    setBusy(true);
    try {
      let signer: Signer;
      try {
        signer = await getSigner();
      } catch (e) {
        if (isNeedsPassword(e)) {
          setError((e as Error).message || "Set a password first. It is what keeps this money yours if this phone is lost.");
          setNeedsPassword(true);
          return;
        }
        try {
          sessionStorage.setItem(DRAFT_KEY(), JSON.stringify({ amount, resumeAt: Date.now() } satisfies Draft));
        } catch {
          /* the form is lost, nothing moved */
        }
        router.push(`/unlock?next=${encodeURIComponent("/add-money/bank")}`);
        return;
      }

      /* The anchor pays dollars to this account, so the account must be able to hold them. Every
         account the sponsor opens can; a practice account from before 2026-09-06 trusts only the
         retired issuer, and gets the missing trustline here on the sponsor's reserve, the same way
         the test-money button repairs it. */
      const bal = await loadBalance(account!.address);
      if (bal && !bal.issuer) await prepareAccount({ sponsorUrl: net.sponsorUrl, signer });

      const info = await readAnchorInfo(domain);
      if (info.door !== "sep6") return setError("This bank rail asks you to finish on its own screen, which this page doesn't do yet.");
      const token = await authenticate(info, signer);
      const live: AnchorSession = { info, token, signer };
      const d = await withSession(live, (t) => startDeposit(info, t, { assetCode: "USDC", account: account!.address, amount: amt.toFixed(2) }));
      session.current = live;
      setOpened(d);
      setStage("awaiting-transfer");
      setStep("instructions");
      startedAt.current = Date.now();
      void sendEvent("deposit_started", d.id, account!.address);
      try {
        sessionStorage.removeItem(DRAFT_KEY());
      } catch {
        /* convenience only */
      }
      void watch(live, d);
    } catch (e) {
      console.error("[add-money/bank] open", e);
      // Nothing has moved at this point, so the anchor's own words are safe to show.
      setError(e instanceof Error && e.message ? `The bank rail said: ${e.message}` : "Couldn't reach the bank rail just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  /** Read-only: watch the anchor until the dollars land. Nothing in this loop signs or pays. */
  async function watch(live: AnchorSession, d: OpenedDeposit) {
    if (watching.current) return;
    watching.current = true;
    let misses = 0;
    let transferDeadline = Date.now() + TRANSFER_WAIT_MS;
    let settleDeadline: number | null = null;
    try {
      for (;;) {
        await sleep(POLL_MS);
        const now = Date.now();
        if (settleDeadline === null && now > transferDeadline) {
          setLateNote("No bank transfer has arrived yet. The reference stays valid at the rail; come back to this screen after you pay.");
          return;
        }
        if (settleDeadline !== null && now > settleDeadline) {
          setLateNote("The rail has your lira but has not sent the dollars yet. It pays on its own clock; your balance will show them when they land.");
          return;
        }
        let state: AnchorDepositState;
        try {
          state = await withSession(live, (t) => readDeposit(live.info, t, d.id));
          misses = 0;
        } catch (e) {
          if (++misses >= MAX_POLL_MISSES) {
            setLateNote(`The bank rail could not be reached for a while (${e instanceof Error ? e.message : "no answer"}). Nothing was paid from your account.`);
            return;
          }
          continue;
        }
        if (state.status === "waiting") {
          setStage(state.stage);
          if (state.stage === "processing" && settleDeadline === null) settleDeadline = Date.now() + SETTLE_WAIT_MS;
          if (state.stage === "awaiting-transfer") transferDeadline = Math.max(transferDeadline, Date.now());
          continue;
        }
        if (state.status === "settled") {
          const secs = Math.round((Date.now() - startedAt.current) / 1000);
          setElapsed(secs);
          setResult(state);
          setStep("done");
          void sendEvent("deposit_completed", d.id, account!.address, { durationS: secs });
          saveRailRun(RAIL_LAST_DEPOSIT_KEY(), {
            at: new Date().toISOString(),
            rail: live.info.homeDomain,
            amountIn: state.amountIn,
            amountOut: state.amountOut,
            amountFee: state.amountFee,
            tx: state.stellarTransactionId,
            seconds: secs,
          });
          return;
        }
        if (state.status === "refunded") {
          setLateNote("The bank rail says it sent the lira back.");
          return;
        }
        setLateNote(`The bank rail reported a problem: ${state.reason}. Nothing was paid from your account.`);
        return;
      }
    } finally {
      watching.current = false;
    }
  }

  async function simulate() {
    if (!session.current || !opened) return;
    setError("");
    setSimBusy(true);
    try {
      await simulateBankTransfer(session.current.info, opened.id, amt.toFixed(2), net);
      setStage("processing");
    } catch (e) {
      setError(e instanceof Error && e.message ? `The test bank said: ${e.message}` : "The test bank didn't answer. Try again.");
    } finally {
      setSimBusy(false);
    }
  }

  async function copyValue(i: DepositInstruction) {
    try {
      await navigator.clipboard.writeText(i.value);
      setCopiedKey(i.key);
      setTimeout(() => setCopiedKey(""), 1500);
    } catch {
      /* clipboard blocked; the value is on screen */
    }
  }

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

  if (!domain || net.isMainnet) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <h1 className="text-xl font-bold text-ink">Add lira by bank transfer</h1>
        <p className="text-sm text-ink-soft">
          {net.isMainnet
            ? "The lira rail runs on the test network for now, against a sandbox bank. Switch to practice money to try it."
            : "No bank rail is connected on this network yet."}
        </p>
        <Link href="/add-money" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          Other ways to add money
        </Link>
      </div>
    );
  }

  if (step === "done" && result) {
    return (
      <div className="flex flex-col gap-4 py-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Test network</p>
        <h1 className="text-xl font-bold text-ink">
          {result.amountOut ? `${formatUsd(result.amountOut)} arrived` : "Your dollars arrived"}
        </h1>
        <MoneyCard className="p-5">
          <dl className="flex flex-col divide-y divide-line">
            {result.amountIn && (
              <div className="flex items-baseline justify-between gap-3 pb-3">
                <dt className="text-sm text-ink-soft">You paid in</dt>
                <dd className="text-lg font-bold tabular-nums text-ink">{result.amountIn} TRY</dd>
              </div>
            )}
            {result.amountOut && (
              <div className="flex items-baseline justify-between gap-3 py-3">
                <dt className="text-sm text-ink-soft">Dollars received</dt>
                <dd className="text-lg font-bold tabular-nums text-ink">{result.amountOut} USDC</dd>
              </div>
            )}
            {result.amountFee && (
              <div className="flex items-baseline justify-between gap-3 py-3">
                <dt className="text-sm text-ink-soft">Rail fee</dt>
                <dd className="text-sm tabular-nums text-ink">{result.amountFee} TRY</dd>
              </div>
            )}
            {elapsed !== null && (
              <div className="flex items-baseline justify-between gap-3 pt-3">
                <dt className="text-sm text-ink-soft">Time, request to dollars</dt>
                <dd className="text-sm tabular-nums text-ink">{elapsed} s</dd>
              </div>
            )}
          </dl>
        </MoneyCard>
        {result.stellarTransactionId && (
          <MoneyCard className="p-4">
            <p className="text-sm text-ink">The rail&apos;s payment to you, on the public record</p>
            <p className="mt-1 break-all font-mono text-xs text-ink-soft">{result.stellarTransactionId}</p>
            <a
              href={explorerTx(result.stellarTransactionId)}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block text-sm font-medium text-money underline-offset-2 hover:underline"
            >
              Open it ↗
            </a>
          </MoneyCard>
        )}
        <p className="text-sm text-ink-soft">
          The rate and the fee are the rail&apos;s ({session.current?.info.homeDomain ?? domain}), not ours. The
          dollars are in your account now and work like any others: send them as a link, or cash them
          back out.
        </p>
        <PrimaryButton onClick={() => router.push("/send")}>Send it as a link</PrimaryButton>
        <Link href="/home" className="text-center text-sm text-ink-soft underline-offset-2 hover:underline">
          Back home
        </Link>
      </div>
    );
  }

  if (step === "instructions" && opened) {
    return (
      <div className="flex flex-col gap-5 py-4">
        <button
          onClick={() => {
            setStep("form");
            setOpened(null);
            setLateNote("");
          }}
          className="flex items-center gap-1 self-start text-sm text-ink-soft"
        >
          <ArrowLeft className="size-4" /> Change the amount
        </button>
        <header>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Test network</p>
          <h1 className="text-xl font-bold text-ink">Send {amt.toFixed(2)} TRY with this reference</h1>
          <p className="mt-1 text-sm text-ink-soft">
            From your bank app, as a normal transfer. The reference is what tells the rail the lira is
            yours, so copy it exactly.
          </p>
        </header>

        <MoneyCard className="p-5">
          <dl className="flex flex-col divide-y divide-line">
            {opened.instructions.map((i) => (
              <div key={i.key} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <dt className="text-sm text-ink-soft">{label(i)}</dt>
                  <dd className="break-all font-mono text-sm text-ink">{display(i)}</dd>
                  {i.description && label(i) !== i.description && <p className="mt-0.5 text-xs text-ink-soft">{i.description}</p>}
                </div>
                <button
                  onClick={() => void copyValue(i)}
                  aria-label={`Copy ${label(i)}`}
                  className="flex h-9 shrink-0 items-center gap-1 rounded-full border border-line px-3 text-xs font-medium text-ink"
                >
                  {copiedKey === i.key ? <Check className="size-3.5 text-money" /> : <Copy className="size-3.5" />}
                  {copiedKey === i.key ? "Copied" : "Copy"}
                </button>
              </div>
            ))}
            {opened.instructions.length === 0 && <p className="text-sm text-ink-soft">The rail gave no payment details beyond its note below.</p>}
          </dl>
        </MoneyCard>

        {opened.note && (
          <MoneyCard className="p-4">
            <p className="text-sm font-semibold text-ink">What the rail said</p>
            <p className="mt-1 break-words text-sm text-ink-soft">{opened.note}</p>
          </MoneyCard>
        )}

        <MoneyCard className="p-4">
          {lateNote ? (
            <p className="text-sm text-ink">{lateNote}</p>
          ) : stage === "awaiting-transfer" ? (
            <p className="text-sm text-ink">Waiting for your bank transfer… This screen updates by itself.</p>
          ) : (
            <p className="text-sm text-ink">The rail has your lira and is sending the dollars…</p>
          )}
        </MoneyCard>

        {!net.isMainnet && stage === "awaiting-transfer" && !lateNote && (
          <div className="flex flex-col gap-2 rounded-[16px] border border-dashed border-line p-4">
            <p className="text-sm text-ink-soft">
              This rail is a sandbox with no real bank behind it. On the test network, this button
              plays your bank and reports the transfer to the rail. It does not exist on real money.
            </p>
            <PrimaryButton loading={simBusy} loadingLabel="Telling the rail…" onClick={() => void simulate()}>
              Simulate the bank transfer (test)
            </PrimaryButton>
          </div>
        )}

        {errorBlock}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-4">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Test network</p>
        <h1 className="text-xl font-bold text-ink">Add lira by bank transfer</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Type how much lira you want to send. The bank rail tells you where to send it and the
          reference to use; the dollars land in this account when your transfer arrives. Prefer
          something else?{" "}
          <Link href="/add-money" className="text-money underline-offset-2 hover:underline">
            Other ways to add money
          </Link>
          .
        </p>
      </header>

      <label className="text-sm text-ink-soft">
        Amount
        <div className="mt-1 flex items-center rounded-[14px] border border-line bg-surface px-3">
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(sanitizeAmountInput(e.target.value))}
            placeholder="0.00"
            className="w-full bg-transparent px-2 py-3 text-lg text-ink outline-none"
          />
          <span className="shrink-0 text-lg text-ink-soft">TRY</span>
        </div>
      </label>

      <p className="text-xs text-ink-soft">
        The rail is {domain}. We send it the amount and your account address, nothing about who you
        are. Its rate and its fee are its own and it states them when it answers.
      </p>

      {errorBlock}

      <PrimaryButton loading={busy} loadingLabel="Asking the rail…" disabled={!(amt > 0)} onClick={() => void open()}>
        Get the transfer details
      </PrimaryButton>
    </div>
  );
}
