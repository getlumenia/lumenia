"use client";

/**
 * /send-out — sending your dollars to an exchange so you can turn them into local money.
 *
 * Deliberately NOT the same screen as /send. Sending to a person is a link; sending to
 * an exchange is a payment to a shared deposit account that only credits you if the
 * reference tag is right. Get the tag wrong and the money lands in the exchange's
 * common pot with nothing to say it was yours. That is the single biggest way someone
 * loses money here, so this screen is built around avoiding it:
 *
 *   - it prefers an address that carries its own tag (muxed M…), where the mistake
 *     cannot be made,
 *   - it reads a deposit link/QR (SEP-7) so the address and tag arrive already paired,
 *   - and when it's a plain address it demands the tag and looks the destination up
 *     first (does it exist, can it hold these dollars, does it declare memo-required).
 *
 * Then it makes you read a review screen before anything is signed. No technical error
 * codes reach this surface; the honest statement is that nothing moved.
 *
 * Vocabulary: the money surfaces stay in money-and-people language ("the exchange",
 * "reference tag"). One deliberate exception: the network is named outright, because
 * the user has to pick it from a dropdown on the exchange's own screen and picking the
 * wrong one destroys the money. Not naming it there would be a vocabulary rule enforced
 * at the user's expense.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { useWallet } from "../../../lib/wallet";
import { loadBalance } from "../../../lib/horizon";
import {
  checkDestination,
  guessOtherNetwork,
  memoTextBytes,
  parseDestination,
  parsePaymentUri,
  sendOut,
  MEMO_TEXT_MAX_BYTES,
  type DestinationCheck,
  type MemoKind,
} from "../../../lib/payout";
import { formatUsd } from "../../../lib/money";
import { sendEvent } from "../../../lib/events";
import { copy } from "../../../lib/copy";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";
import { activeNetwork, explorerTx } from "../../../lib/network";

const explorer = explorerTx;
/** Draft of the form, kept only for this tab so an unlock detour doesn't wipe it. */
const DRAFT_KEY = "lumenia.sendout.draft";
/**
 * The last destination that actually WORKED, kept on this device. Reusing it is both
 * the fastest path and the safest one: the second cash-out repeats an address the
 * ledger already accepted, instead of another paste that could carry a typo or a
 * hijacked clipboard. Local only; never sent anywhere.
 */
const SAVED_KEY = "lumenia.sendout.destination";

interface SavedDestination {
  address: string;
  memo: string;
  memoKind: MemoKind;
  at: string;
}

type Step = "form" | "review" | "done";

export default function SendOutPage() {
  const { status, account, getSigner } = useWallet();
  const router = useRouter();

  const [balance, setBalance] = useState<string | null>(null);
  const [issuer, setIssuer] = useState<string | null>(null);
  const [raw, setRaw] = useState("");
  const [memo, setMemo] = useState("");
  const [memoKind, setMemoKind] = useState<MemoKind>("text");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<DestinationCheck | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hash, setHash] = useState("");
  const [saved, setSaved] = useState<SavedDestination | null>(null);

  useEffect(() => {
    if (account) void loadBalance(account.address).then((b) => setBalance(b?.usd ?? "0"));
  }, [account]);

  // Restore a draft after the unlock detour. Retyping a deposit address is exactly where
  // a typo gets introduced, so losing the form to a password prompt would be its own
  // hazard. Nothing secret is kept here: an address and an amount, for this tab only.
  useEffect(() => {
    try {
      const draft = sessionStorage.getItem(DRAFT_KEY);
      if (draft) {
        const d = JSON.parse(draft) as { raw?: string; memo?: string; memoKind?: MemoKind; amount?: string };
        if (d.raw) setRaw(d.raw);
        if (d.memo) setMemo(d.memo);
        if (d.memoKind) setMemoKind(d.memoKind);
        if (d.amount) setAmount(d.amount);
      }
      const last = localStorage.getItem(SAVED_KEY);
      if (last) setSaved(JSON.parse(last) as SavedDestination);
    } catch {
      /* storage blocked — the form just starts empty */
    }
  }, []);

  function useSaved() {
    if (!saved) return;
    setRaw(saved.address);
    setMemo(saved.memo);
    setMemoKind(saved.memoKind);
    setError("");
  }

  function forgetSaved() {
    setSaved(null);
    try {
      localStorage.removeItem(SAVED_KEY);
    } catch {
      /* nothing to clear */
    }
  }

  // A deposit link can name the amount too. Take it while the field is untouched, so a
  // pasted link fills the whole form instead of stalling on "enter an amount".
  useEffect(() => {
    const parsed = parsePaymentUri(raw);
    if (parsed?.amount) setAmount((a) => (a === "" ? parsed.amount! : a));
  }, [raw]);

  // The exact dollars we hold — needed to tell whether the destination can receive them.
  // Mainnet-aware: an approved user on real money must read the issuer from the MAINNET
  // sponsor (its own USDC), not testnet — otherwise the destination check runs against the
  // wrong asset. activeNetwork() is testnet by default, so nothing changes for practice money.
  useEffect(() => {
    let alive = true;
    fetch(`${activeNetwork().sponsorUrl.replace(/\/$/, "")}/health`)
      .then((r) => r.json() as Promise<{ usdcIssuer?: string }>)
      .then((h) => alive && setIssuer(h.usdcIssuer ?? null))
      .catch(() => alive && setIssuer(null));
    return () => {
      alive = false;
    };
  }, []);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  if (!account) {
    if (typeof window !== "undefined") router.replace("/home");
    return null;
  }

  // A pasted deposit link carries the address and the tag together; a pasted address
  // is just an address. Both end up as the same three values.
  const uri = parsePaymentUri(raw);
  const destination = parseDestination(uri?.destination ?? raw);
  const tagFromLink = Boolean(uri?.memo);
  const effectiveMemo = tagFromLink ? uri!.memo! : memo.trim();
  const effectiveMemoKind: MemoKind = tagFromLink ? (uri!.memoKind ?? "text") : memoKind;
  const needsTag = Boolean(destination && !destination.muxed);
  // Not a Stellar address? Name the network they actually copied instead of shrugging.
  const otherNetwork = !destination && raw.trim() !== "" ? guessOtherNetwork(uri?.destination ?? raw) : null;
  const memoTooLong = effectiveMemoKind === "text" && memoTextBytes(effectiveMemo) > MEMO_TEXT_MAX_BYTES;
  const memoNotANumber = effectiveMemoKind === "id" && effectiveMemo !== "" && !/^\d+$/.test(effectiveMemo);

  async function review() {
    setError("");
    if (!destination) return setError("That doesn't look like a deposit address. Copy it again from the exchange.");
    const amt = Math.round(Number.parseFloat(amount) * 100) / 100;
    if (!Number.isFinite(amt) || amt < 0.01) return setError("Enter an amount to send.");
    if (balance !== null && amt > Number.parseFloat(balance)) return setError("That's more than you have.");
    if (needsTag && !effectiveMemo) {
      return setError("Add the reference tag the exchange gave you. Without it your deposit can't be matched to you.");
    }
    if (memoTooLong) return setError(`That tag is too long. ${MEMO_TEXT_MAX_BYTES} characters at most.`);
    if (memoNotANumber) return setError("A number tag can only contain digits.");

    setChecking(true);
    try {
      const result = issuer ? await checkDestination(destination.address, issuer) : null;
      setCheck(result);
      if (result && !result.exists) {
        return setError(
          "We can't find that account. Check the address against the exchange character for character, and make sure it's the one it gave you for the Stellar network.",
        );
      }
      if (result && !result.canHoldDollars) {
        // The most common real failure, and the reason this screen checks first: most
        // Turkish exchanges don't accept these dollars on this network at all. Saying
        // "wrong address" would send people back to re-copy a correct address.
        return setError(
          "That account can't hold these dollars. Most Turkish exchanges can't yet, so this isn't your typo. The guide has the route that does work.",
        );
      }
      setUnderstood(false);
      setStep("review");
    } catch {
      // A failed lookup must not become a green light — we simply can't confirm.
      setError("We couldn't check that address just now. Try again in a moment.");
    } finally {
      setChecking(false);
    }
  }

  async function confirm() {
    if (!destination) return;
    setError("");
    setBusy(true);
    try {
      let signer;
      try {
        signer = await getSigner();
      } catch {
        // Locked account: keep the draft so nothing has to be retyped on the way back.
        try {
          sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ raw, memo, memoKind, amount }));
        } catch {
          /* storage blocked — the form is lost, but no money moved */
        }
        router.push(`/unlock?next=${encodeURIComponent("/send-out")}`);
        return;
      }
      const result = await sendOut({
        // Real-money users hit the mainnet sponsor; practice users the testnet one.
        sponsorUrl: activeNetwork().sponsorUrl,
        signer,
        amount: (Math.round(Number.parseFloat(amount) * 100) / 100).toFixed(2),
        destination: destination.address,
        memo: destination.muxed ? undefined : effectiveMemo,
        memoKind: destination.muxed ? "none" : effectiveMemoKind,
      });
      void sendEvent("cashout_sent", account!.address);
      try {
        sessionStorage.removeItem(DRAFT_KEY);
        // Only ever save a destination the ledger just accepted.
        localStorage.setItem(
          SAVED_KEY,
          JSON.stringify({
            address: destination.address,
            memo: destination.muxed ? "" : effectiveMemo,
            memoKind: destination.muxed ? "none" : effectiveMemoKind,
            at: new Date().toISOString(),
          } satisfies SavedDestination),
        );
      } catch {
        /* storage blocked — one less convenience, nothing broken */
      }
      setHash(result.hash);
      setStep("done");
    } catch (e) {
      console.error("[send-out]", e);
      setError(copy.errors.moneySafe);
    } finally {
      setBusy(false);
    }
  }

  if (step === "done") {
    return (
      <div className="flex flex-col gap-4 py-6">
        <h1 className="text-xl font-bold text-ink">On its way</h1>
        <p className="text-ink-soft">
          {formatUsd(amount)} left your account. Exchanges usually show a deposit within a few
          minutes. If it hasn&apos;t appeared in an hour, give them the record below.
        </p>
        {/* Our leg is done in seconds; the exchange's and the bank's are not, and they are not
            ours to speed up. Saying which part is whose — and that we already did ours as fast as
            it can be done — turns "why is it slow" into "I know where it is". */}
        <MoneyCard className="p-4">
          <p className="text-sm text-ink">Our part is finished.</p>
          <p className="mt-1 text-sm text-ink-soft">
            Anything that happens from here — the exchange crediting you, a first-time review, your
            bank&apos;s own timing — runs on their clock, not ours. We can&apos;t shorten those, but
            we&apos;ve already done our side the fastest way there is: your money moved the moment
            you tapped, and the record below proves it.
          </p>
        </MoneyCard>
        <a
          href={explorer(hash)}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-money underline-offset-2 hover:underline"
        >
          See it on the public record ↗
        </a>
        <Link href="/account" className="text-sm text-ink-soft underline-offset-2 hover:underline">
          Back to my account
        </Link>
      </div>
    );
  }

  if (step === "review") {
    return (
      <div className="flex flex-col gap-5 py-4">
        <button
          onClick={() => setStep("form")}
          className="flex items-center gap-1 self-start text-sm text-ink-soft"
        >
          <ArrowLeft className="size-4" /> Change something
        </button>
        <header>
          <h1 className="text-xl font-bold text-ink">Read this before you send</h1>
          <p className="mt-1 text-sm text-ink-soft">This one can&apos;t be undone.</p>
        </header>

        <MoneyCard className="p-5">
          <dl className="flex flex-col divide-y divide-line">
            <div className="flex items-baseline justify-between gap-3 pb-3">
              <dt className="text-sm text-ink-soft">Amount</dt>
              <dd className="text-lg font-bold tabular-nums text-ink">{formatUsd(amount)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-3">
              <dt className="text-sm text-ink-soft">To</dt>
              <dd className="break-all text-right font-mono text-xs text-ink">{destination?.address}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 pt-3">
              <dt className="text-sm text-ink-soft">Reference tag</dt>
              <dd className="break-all text-right font-mono text-xs text-ink">
                {destination?.muxed ? "carried in the address" : effectiveMemo}
              </dd>
            </div>
          </dl>
        </MoneyCard>

        <MoneyCard className="border-danger/40 p-5">
          <p className="flex items-center gap-2 font-semibold text-ink">
            <AlertTriangle className="size-4 text-danger" />
            Two things that lose money
          </p>
          <ul className="mt-2 flex list-disc flex-col gap-2 pl-5 text-sm text-ink-soft">
            <li>
              <strong className="text-ink">The wrong network.</strong>{" "}These are Stellar dollars.
              On the exchange, pick Stellar (XLM) as the deposit network, not Ethereum and not Tron.
              Money sent on the wrong network is gone, and nobody can bring it back.
            </li>
            {destination?.muxed ? (
              <li>
                <strong className="text-ink">The tag.</strong>{" "}This address carries its own tag, so
                there&apos;s nothing to type and nothing to get wrong.
              </li>
            ) : (
              <li>
                <strong className="text-ink">The wrong tag.</strong>{" "}The exchange tells your deposit
                apart from everyone else&apos;s by that tag. A wrong or missing one lands your money
                in their shared pot. We can&apos;t recover it, and often neither can they.
                {check?.memoRequired ? " This exchange has said the tag is mandatory." : ""}
              </li>
            )}
          </ul>
          <p className="mt-3 text-sm text-ink-soft">
            Sending for the first time? Send a couple of dollars, wait for it to arrive, then send the rest.
          </p>
          {/* Set the expectation BEFORE they send, not after: a first cash-out can sit for a while
              at the exchange or the bank, and someone who wasn't told reads that silence as "my
              money is gone". Naming whose clock it runs on costs nothing and prevents the panic. */}
          <p className="mt-2 text-sm text-ink-soft">
            Your money leaves here in seconds. After that it&apos;s on the exchange&apos;s and your
            bank&apos;s timing — a first withdrawal in particular can take longer than the rest.
            That part isn&apos;t ours to speed up, but nothing is stuck: it&apos;s yours the whole
            way, and you can follow it on the public record.
          </p>
        </MoneyCard>

        {/* What lands here is the full amount. What they end up with in lira is not, and
            saying so at the confirm step is the difference between an expectation and a
            complaint. We can't quote the exchange's numbers, so we don't invent any. */}
        <p className="text-sm text-ink-soft">
          All {formatUsd(amount)} arrives at the exchange. What you get in lira afterwards is less,
          because the exchange charges its own fees to sell and to pay out. Those are theirs, not
          ours, and we can&apos;t tell you the number in advance.
        </p>

        <label className="flex items-start gap-3 text-sm text-ink">
          <input
            type="checkbox"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
            className="mt-1 size-4 accent-[var(--color-money,currentColor)]"
          />
          <span>
            I checked the address and the tag against the exchange, and I picked Stellar as the
            deposit network.
          </span>
        </label>

        {error && <p className="text-sm text-danger">{error}</p>}

        <PrimaryButton loading={busy} loadingLabel="Sending…" disabled={!understood} onClick={confirm}>
          Send {amount ? formatUsd(amount) : ""}
        </PrimaryButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Send to an exchange</h1>
        <p className="mt-1 text-sm text-ink-soft">
          This is how you turn dollars into local money: move them to your account at a licensed
          exchange, sell them there, and withdraw to your bank.{" "}
          <Link href="/cash-out" className="text-money underline-offset-2 hover:underline">
            Read the guide first
          </Link>
          .
        </p>
        {balance !== null && (
          <p className="mt-2 text-sm text-ink-soft">You have {formatUsd(balance)} to send.</p>
        )}
      </header>

      {/* Been here before? Repeat the address that already worked. Fewer taps, and one
          fewer chance to paste something wrong. */}
      {saved && raw.trim() === "" && (
        <MoneyCard className="p-4">
          <p className="text-sm font-semibold text-ink">Send to the same place again</p>
          <p className="mt-1 break-all font-mono text-xs text-ink-soft">
            {saved.address.slice(0, 8)}…{saved.address.slice(-6)}
            {saved.memo ? ` · tag ${saved.memo}` : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={useSaved}
              className="flex h-10 items-center rounded-full border border-money px-4 text-sm font-medium text-money"
            >
              Use this again
            </button>
            <button
              onClick={forgetSaved}
              className="flex h-10 items-center rounded-full border border-line px-4 text-sm font-medium text-ink-soft"
            >
              Forget it
            </button>
          </div>
        </MoneyCard>
      )}

      <div className="rounded-[16px] border border-line bg-paper p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
          <AlertTriangle className="size-4 text-danger" />
          Pick Stellar as the deposit network
        </p>
        <p className="mt-1 text-sm text-ink-soft">
          Exchanges list the same dollars on several networks. Yours travel on Stellar. Choose
          Stellar (XLM) on the deposit screen, then copy the address it gives you.
        </p>
        {/* The single most useful thing we can say before they go hunting: Turkish exchanges
            don't offer this network, so the address they're about to fetch has to come from
            the global platform. Stated here, not only in the guide, because this is the
            moment they open the exchange app. */}
        <p className="mt-2 text-sm text-ink-soft">
          Turkish exchanges don&apos;t offer Stellar for these dollars yet, so the deposit address
          has to come from a platform that does.{" "}
          <Link href="/cash-out" className="text-money underline-offset-2 hover:underline">
            The guide names the route
          </Link>
          .
        </p>
        <Link
          href="/cash-out"
          className="mt-3 inline-flex h-9 items-center rounded-full border border-money px-4 text-sm font-medium text-money"
        >
          See the route ↗
        </Link>
      </div>

      <label className="text-sm text-ink-soft">
        Deposit address, or the deposit link
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder="Paste it here"
          className="mt-1 w-full resize-none break-all rounded-[14px] border border-line bg-surface px-3 py-3 font-mono text-xs text-ink outline-none"
        />
      </label>
      {raw.trim() !== "" && !destination && (
        <p className="-mt-3 text-sm text-danger">
          {otherNetwork
            ? `That's an address for ${otherNetwork}. Your dollars travel on Stellar, so go back to the exchange's deposit screen, switch the network to Stellar, and copy the address it shows there instead.`
            : "That isn't a deposit address we recognise. Copy it again from the exchange."}
        </p>
      )}
      {destination?.muxed && (
        <p className="-mt-3 text-sm text-money">
          This address carries its own reference tag. Nothing else to fill in, and nothing to get wrong.
        </p>
      )}
      {tagFromLink && (
        <p className="-mt-3 text-sm text-money">
          The link came with its reference tag: <span className="font-mono">{uri!.memo}</span>
        </p>
      )}

      {needsTag && !tagFromLink && (
        <div className="flex flex-col gap-2">
          <label className="text-sm text-ink-soft">
            Reference tag from the exchange
            <input
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              spellCheck={false}
              placeholder="e.g. 104882913"
              className="mt-1 w-full rounded-[14px] border border-line bg-surface px-3 py-3 font-mono text-sm text-ink outline-none"
            />
          </label>
          <div className="flex gap-2">
            {(["text", "id"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setMemoKind(k)}
                className={`h-8 rounded-full border px-3 text-xs font-medium ${
                  memoKind === k ? "border-money text-money" : "border-line text-ink-soft"
                }`}
              >
                {k === "text" ? "Letters and numbers" : "Numbers only"}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-soft">
            Whatever the exchange shows next to the deposit address. It may call it a memo, a tag or
            a note. Copy it exactly. Sending to a person instead?{" "}
            <Link href="/send" className="text-money underline-offset-2 hover:underline">
              Send them a link
            </Link>
            .
          </p>
        </div>
      )}

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
          {/* Cashing out is usually "all of it". Typing the balance by hand is pure
              friction, and rounding it wrong is the "more than you have" dead end. */}
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

      {error && <p className="text-sm text-danger">{error}</p>}

      <PrimaryButton loading={checking} loadingLabel="Checking the address…" onClick={review}>
        Review the transfer
      </PrimaryButton>

      <p className="text-sm text-ink-soft">
        Bringing money in instead?{" "}
        <Link href="/add-money" className="text-money underline-offset-2 hover:underline">
          Here&apos;s what they need
        </Link>
        .
      </p>
    </div>
  );
}
