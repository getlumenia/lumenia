"use client";

/**
 * /split — split a bill between people. This is NOT a new backend feature: it's a COMPOSITION of
 * request money (lib/request). "Split $60 three ways" generates three ordinary request links of $20
 * each — every one is a normal /r link that lands paid money on your /home (if you have an account)
 * or comes back to the thread (if you don't). No server, no state we hold; the shares always sum to
 * the total exactly (the remainder rides on the last share).
 */
import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { useWallet } from "../../../lib/wallet";
import { buildRequestLink, clampAskName, makeNonce, saveAsk } from "../../../lib/request";
import { sendEvent } from "../../../lib/events";
import { formatUsd, sanitizeAmountInput } from "../../../lib/money";
import { shareMoneyLink } from "../../../lib/share";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";

interface Share {
  n: number;
  amount: string;
  link: string;
}

/** Even split whose parts sum to the total exactly — the remainder goes on the last share. */
function splitAmount(totalCents: number, count: number): number[] {
  const base = Math.floor(totalCents / count);
  const shares = Array(count).fill(base) as number[];
  let rem = totalCents - base * count;
  for (let i = count - 1; rem > 0; i--, rem--) shares[i] += 1; // spread the odd cents onto the last shares
  return shares;
}

export default function SplitPage() {
  const { status, account } = useWallet();
  const [name, setName] = useState("");
  const [total, setTotal] = useState("");
  const [count, setCount] = useState(3);
  const [error, setError] = useState("");
  const [shares, setShares] = useState<Share[] | null>(null);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;

  function create() {
    setError("");
    const cents = Math.round(Number.parseFloat(total) * 100);
    if (!Number.isFinite(cents) || cents < count) return setError("Enter a total to split.");
    const who = clampAskName(name);
    if (!who) return setError("Add your name so they know who's asking.");

    const parts = splitAmount(cents, count);
    const list: Share[] = parts.map((c, i) => {
      const amount = (c / 100).toFixed(2);
      const nonce = makeNonce();
      const link = buildRequestLink(window.location.origin, { nonce, amount, name: who, to: account?.address });
      saveAsk({ nonce, amount, name: who, to: account?.address, link, at: new Date().toISOString() });
      void sendEvent("request_created", nonce);
      return { n: i + 1, amount, link };
    });
    setShares(list);
  }

  if (shares) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <header>
          <h1 className="text-xl font-bold text-ink">
            {formatUsd(total)} split {shares.length} ways
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            Send each person their link. When they pay, {account ? "it lands on your home screen" : "they send a money link back"}.
          </p>
        </header>
        <div className="flex flex-col gap-3">
          {shares.map((s) => (
            <ShareRow key={s.n} share={s} name={clampAskName(name)} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Split a bill</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Divide a total between people. Each gets a link to pay their share.
        </p>
      </header>

      <label className="text-sm text-ink-soft">
        Total
        <div className="mt-1 flex items-center rounded-[14px] border border-line bg-surface px-3">
          <span className="text-lg text-ink-soft">$</span>
          <input
            inputMode="decimal"
            value={total}
            onChange={(e) => setTotal(sanitizeAmountInput(e.target.value))}
            placeholder="0.00"
            className="w-full bg-transparent px-2 py-3 text-lg text-ink outline-none"
          />
        </div>
      </label>

      <div className="text-sm text-ink-soft">
        Between
        <div className="mt-1 flex items-center gap-3">
          <button
            onClick={() => setCount((c) => Math.max(2, c - 1))}
            className="grid size-10 place-items-center rounded-full border border-line text-lg text-ink"
            aria-label="fewer people"
          >
            −
          </button>
          <span className="min-w-[3ch] text-center text-lg font-semibold tabular-nums text-ink">{count}</span>
          <button
            onClick={() => setCount((c) => Math.min(12, c + 1))}
            className="grid size-10 place-items-center rounded-full border border-line text-lg text-ink"
            aria-label="more people"
          >
            +
          </button>
          <span className="text-ink-soft">people</span>
          {total && Number.parseFloat(total) > 0 && (
            <span className="ml-auto text-sm text-ink-soft">
              ≈ {formatUsd((Number.parseFloat(total) / count).toFixed(2))} each
            </span>
          )}
        </div>
      </div>

      <label className="text-sm text-ink-soft">
        Your name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="So they know who's asking"
          className="mt-1 w-full rounded-[14px] border border-line bg-surface px-3 py-3 text-ink"
        />
      </label>

      {error && <p className="text-sm text-danger">{error}</p>}
      <PrimaryButton onClick={create}>Make the links</PrimaryButton>
    </div>
  );
}

function ShareRow({ share, name }: { share: Share; name: string }) {
  const [copied, setCopied] = useState(false);
  // The share sheet appends the link itself, so it stays out of this text — and out of any
  // third-party server's logs (see lib/share.ts).
  const shareText = `Hi, it's ${name}. Your share is ${formatUsd(share.amount)}. Pay it here:`;
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(share.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }
  async function doShare() {
    if ((await shareMoneyLink({ text: shareText, link: share.link })) !== "shared") {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }
  return (
    <MoneyCard className="flex items-center gap-3 p-4">
      <span className="grid size-9 place-items-center rounded-full bg-secondary text-sm font-semibold text-ink">
        {share.n}
      </span>
      <p className="flex-1 font-semibold tabular-nums text-ink">{formatUsd(share.amount)}</p>
      <button
        onClick={doShare}
        className="flex h-9 items-center rounded-full bg-money px-3 text-xs font-semibold text-primary-foreground"
      >
        Share
      </button>
      <button
        onClick={copyLink}
        className="flex size-9 items-center justify-center rounded-full border border-line text-ink"
        aria-label="copy link"
      >
        {copied ? <Check className="size-4 text-money" /> : <Copy className="size-4" />}
      </button>
    </MoneyCard>
  );
}
