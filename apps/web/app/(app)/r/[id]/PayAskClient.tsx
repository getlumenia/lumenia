"use client";

/**
 * The payer's decision surface. Honest states:
 *  - payer has an account → the ask + "Pay <name>" (hands off to /send, prefilled);
 *  - the ask is the payer's OWN (to === their address) → "this is your own
 *    request" — paying yourself is a guaranteed on-chain rejection (duplicate
 *    claimant destinations), so it never gets a Pay button;
 *  - payer has no account → the ask + the truth (money here arrives as a link) +
 *    a real way in (/demo) + the webview escape hint — the WhatsApp webview has
 *    its own storage, so "no account HERE" must not read as "no account";
 *  - malformed link → "ask them to send it again", never a broken form.
 * The pay state is the SSR default (the page's identity; also keeps LCP at first
 * paint) and holds the button in a loading state until the wallet has answered.
 * request_opened fires once per real view — the nonce is the funnel's join key.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../../lib/wallet";
import { sendEvent } from "../../../../lib/events";
import { formatUsd } from "../../../../lib/money";
import { copy } from "../../../../lib/copy";
import { PersonChip } from "../../../../components/brand/PersonChip";
import { PrimaryButton } from "../../../../components/brand/PrimaryButton";
import type { Ask } from "../../../../lib/request";

/** First name, capped — button labels are nowrap and must survive 40-char names. */
function shortName(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? name).slice(0, 12);
}

export function PayAskClient({ ask }: { ask: Ask | null }) {
  const { status, account } = useWallet();
  const router = useRouter();
  const opened = useRef(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (ask && !opened.current) {
      opened.current = true;
      void sendEvent("request_opened", ask.nonce);
    }
  }, [ask]);

  if (!ask) {
    return (
      <div className="py-16 text-center">
        <h1 className="text-xl font-bold text-ink">{copy.errors.notFound}</h1>
        <p className="mt-2 text-ink-soft">{copy.pay.invalid}</p>
        {/* A malformed link may be a brand-new visitor's first contact — never a wall. */}
        <div className="mt-4 flex flex-col items-center gap-2">
          <Link href="/try" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
            {copy.pay.tryDemo}
          </Link>
          <Link href="/" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
            See what Lumenia is
          </Link>
        </div>
      </div>
    );
  }

  const ownRequest = !!account && !!ask.to && ask.to === account.address;

  function pay() {
    const q = new URLSearchParams({ a: ask!.amount, req: ask!.nonce, reqName: ask!.name });
    if (ask!.to) q.set("to", ask!.to);
    router.push(`/send?${q.toString()}`);
  }

  async function copyPageLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <PersonChip name={ask.name} />
      <div>
        <p className="text-sm text-ink-soft">{copy.pay.asksFor(ask.name)}</p>
        <p className="mt-1 text-5xl font-bold tabular-nums text-ink">{formatUsd(ask.amount)}</p>
      </div>

      {ownRequest ? (
        <>
          <p className="font-semibold text-ink">{copy.pay.ownRequestTitle}</p>
          <p className="max-w-xs text-sm text-ink-soft">{copy.pay.ownRequestBody}</p>
          <Link href="/home" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
            Back to my money →
          </Link>
        </>
      ) : status === "loading" || account ? (
        <>
          <p className="max-w-xs text-sm text-ink-soft">{copy.pay.sub}</p>
          <div className="w-full max-w-xs">
            <PrimaryButton
              loading={status === "loading"}
              loadingLabel="One moment…"
              onClick={() => account && pay()}
            >
              {copy.pay.payCta(shortName(ask.name))} {formatUsd(ask.amount)}
            </PrimaryButton>
          </div>
          <p className="max-w-xs text-xs text-ink-soft">{copy.pay.doublePayNote(shortName(ask.name))}</p>
        </>
      ) : (
        <>
          <p className="font-semibold text-ink">{copy.pay.noMoneyTitle}</p>
          <p className="max-w-xs text-sm text-ink-soft">{copy.pay.noMoneyBody}</p>
          <p className="max-w-xs text-sm text-ink-soft">{copy.pay.browserHint}</p>
          <button
            onClick={copyPageLink}
            className="h-10 rounded-full border border-line px-4 text-sm font-medium text-ink"
          >
            {copied ? "Copied" : copy.pay.copyPageLink}
          </button>
          <Link
            href="/try"
            className="text-sm font-semibold text-money underline-offset-2 hover:underline"
          >
            {copy.pay.tryDemo} →
          </Link>
        </>
      )}
    </div>
  );
}
