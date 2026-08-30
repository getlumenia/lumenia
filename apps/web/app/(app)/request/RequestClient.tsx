"use client";

/**
 * The ask form + share card. Two honest variants of the same surface (§5.1):
 *  - no local account → the link carries amount + name only; the payer will send
 *    a money link back in the same chat (the note says exactly that);
 *  - returning asker → the link also carries her address; paid money lands on
 *    /home as "Money waiting for you".
 * No credential is ever asked for here — an ask must cost nothing.
 */
import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import { useWallet } from "../../../lib/wallet";
import { buildRequestLink, clampAskName, loadAsks, makeNonce, saveAsk, type AskRecord } from "../../../lib/request";
import { sendEvent } from "../../../lib/events";
import { formatUsd, sanitizeAmountInput } from "../../../lib/money";
import { copy } from "../../../lib/copy";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";

function AskReadyCard({ ask, hasAccount }: { ask: AskRecord; hasAccount: boolean }) {
  const [copied, setCopied] = useState(false);
  const waText = encodeURIComponent(copy.request.waText(ask.name, formatUsd(ask.amount), ask.link));

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(ask.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the share button still works */
    }
  }

  return (
    <MoneyCard className="flex flex-col gap-3 p-5">
      <p className="font-semibold text-ink">{copy.request.readyTitle}</p>
      <p
        data-testid="request-link"
        className="break-all rounded-[14px] border border-line bg-paper px-3 py-2 text-xs text-ink-soft"
      >
        {ask.link}
      </p>
      <a
        href={`https://wa.me/?text=${waText}`}
        target="_blank"
        rel="noreferrer"
        className="flex h-12 w-full items-center justify-center rounded-full bg-money text-sm font-semibold text-primary-foreground"
      >
        {copy.request.shareCta}
      </a>
      <button
        onClick={copyLink}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-full border border-line text-sm font-medium text-ink"
      >
        {copied ? <Check className="size-4 text-money" /> : <Copy className="size-4" />}
        {copied ? "Copied" : "Copy link"}
      </button>
      <p className="text-xs text-ink-soft">
        {hasAccount ? copy.request.noteWithAccount : copy.request.noteWithoutAccount}
      </p>
    </MoneyCard>
  );
}

export function RequestClient() {
  const { status, account } = useWallet();
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState<AskRecord | null>(null);
  const [recent, setRecent] = useState<AskRecord[]>([]);

  useEffect(() => {
    setRecent(loadAsks());
  }, [ready]);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;

  function create() {
    setError("");
    // Same bounds parseAsk enforces on the payer's side — otherwise "0.001"
    // rounds to a link that every payer sees as broken while the asker was
    // told it was ready.
    const amt = Math.round(Number.parseFloat(amount) * 100) / 100;
    if (!Number.isFinite(amt) || amt < 0.01 || amt >= 1_000_000_000) {
      return setError("Enter the amount you need.");
    }
    const who = clampAskName(name);
    if (!who) return setError("Add your name so they know it's you.");

    const nonce = makeNonce();
    const link = buildRequestLink(window.location.origin, {
      nonce,
      amount: amt.toFixed(2),
      name: who,
      to: account?.address,
    });
    const rec: AskRecord = {
      nonce,
      amount: amt.toFixed(2),
      name: who,
      to: account?.address,
      link,
      at: new Date().toISOString(),
    };
    saveAsk(rec);
    void sendEvent("request_created", nonce);
    setReady(rec);
  }

  if (ready) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <h1 className="text-xl font-bold text-ink">
          You&apos;re asking for {formatUsd(ready.amount)}
        </h1>
        <AskReadyCard ask={ready} hasAccount={!!account} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">{copy.request.title}</h1>
        <p className="mt-1 text-sm text-ink-soft">{copy.request.sub}</p>
      </header>

      <label className="text-sm text-ink-soft">
        {copy.request.amountLabel}
        <div className="mt-1 flex items-center rounded-[14px] border border-line bg-surface px-3">
          <span className="text-lg text-ink-soft">$</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(sanitizeAmountInput(e.target.value))}
            placeholder="0.00"
            className="w-full bg-transparent px-2 py-3 text-lg text-ink outline-none"
          />
        </div>
      </label>
      <label className="text-sm text-ink-soft">
        {copy.request.nameLabel}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={copy.request.namePlaceholder}
          className="mt-1 w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-ink"
        />
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <PrimaryButton onClick={create}>{copy.request.cta}</PrimaryButton>
      <p className="text-xs text-ink-soft">
        {account ? copy.request.noteWithAccount : copy.request.noteWithoutAccount}
      </p>

      {recent.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-semibold text-ink-soft">{copy.request.recentTitle}</h2>
          <div className="rounded-[20px] border border-line bg-surface px-4">
            {recent.map((r) => (
              <RecentAskRow key={r.nonce} ask={r} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** One past ask: what + when + copy-again. No invented status — /home shows real money. */
function RecentAskRow({ ask }: { ask: AskRecord }) {
  const [copied, setCopied] = useState(false);
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(ask.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-3 last:border-b-0">
      <div>
        <p className="text-sm font-semibold tabular-nums text-ink">{formatUsd(ask.amount)}</p>
        <p className="text-xs text-ink-soft">{new Date(ask.at).toLocaleDateString("en-US")}</p>
      </div>
      <button
        onClick={copyLink}
        className="flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-xs font-medium text-ink"
      >
        {copied ? <Check className="size-3.5 text-money" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
