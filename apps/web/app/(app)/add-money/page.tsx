"use client";

/**
 * /add-money — money coming IN, and the exact inverse of /send-out.
 *
 * The belief people arrive with, because every exchange trains it: "I need a memo." They need one
 * to pay INTO an exchange, where thousands of customers share a single deposit account and the
 * memo is the only thing saying which of them a transfer belongs to. They need nothing to be paid
 * HERE, because the account is theirs alone. This screen's first job is to correct that, as a
 * reason rather than a rule, and its second is to keep them off the wrong network.
 *
 * It is honest about where the product actually is: on the test network no exchange can send real
 * money here, and the page says so instead of showing a receive address that will never be used.
 * The state is derived from the sponsor's own /health issuer (lib/receive.ts::moneyOrigin), not a
 * build flag, so it starts telling a different truth the day the sponsor moves to mainnet.
 *
 * Publishing side effect, and the reason it exists: copying the address or revealing the code
 * marks it PUBLISHED (keystore.markPublished). /home consolidates every non-home account and that
 * sweep ends in accountMerge, which CLOSES the account on-chain — so without this an address a
 * user handed to an exchange could be destroyed underneath them by a later restore, and the
 * incoming transfer would bounce.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import QRCode from "react-qr-code";
import { AlertTriangle, Copy, Check, QrCode } from "lucide-react";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../lib/wallet";
import { activeNetwork } from "../../../lib/network";
import { loadTotalUsd } from "../../../lib/horizon";
import { markPublished } from "../../../lib/keystore";
import { buildReceiveUri, moneyOrigin, NETWORK_LABEL, getTestMoney } from "../../../lib/receive";
import { usePolling, agoLabel } from "../../../lib/poll";
import { formatUsd } from "../../../lib/money";
import { copy } from "../../../lib/copy";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";

/**
 * The sponsor for the network this device is ACTUALLY on. A module-level constant here pointed at
 * the testnet Worker regardless of the switch, so on real money these calls went to a service that
 * cannot serve them. Read at call time — switching networks reloads, but a constant captured at
 * import is how this drifted.
 */
function sponsorUrl(): string {
  return activeNetwork().sponsorUrl;
}

export default function AddMoneyPage() {
  const { status, account, accounts } = useWallet();
  const router = useRouter();
  const [health, setHealth] = useState<{ usdcCode: string; usdcIssuer: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [plainQr, setPlainQr] = useState(false);
  const [total, setTotal] = useState<string | null>(null);
  const [arrived, setArrived] = useState<string | null>(null);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    fetch(`${sponsorUrl().replace(/\/$/, "")}/health`)
      .then((r) => r.json() as Promise<{ usdcCode?: string; usdcIssuer?: string }>)
      .then((h) => alive && h.usdcIssuer && setHealth({ usdcCode: h.usdcCode ?? "USDC", usdcIssuer: h.usdcIssuer }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // The whole point of this screen is waiting for something to land, so it watches. Visible-tab
  // only, with backoff, and it says when it last looked rather than spinning forever (lib/poll).
  const addresses = accounts.length ? accounts.map((a) => a.address) : account ? [account.address] : [];
  const poll = usePolling(
    async () => {
      if (addresses.length === 0) return;
      const r = await loadTotalUsd(addresses);
      setTotal((prev) => {
        if (prev !== null && Number.parseFloat(r.usd) > Number.parseFloat(prev)) {
          setArrived(formatUsd((Number.parseFloat(r.usd) - Number.parseFloat(prev)).toFixed(2)));
        }
        return r.usd;
      });
    },
    { enabled: addresses.length > 0 },
  );

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;
  if (!account) {
    if (typeof window !== "undefined") router.replace("/home");
    return null;
  }

  const origin = moneyOrigin(health?.usdcIssuer);
  const network = NETWORK_LABEL[origin];
  const uri = health
    ? buildReceiveUri({ address: account.address, assetCode: health.usdcCode, assetIssuer: health.usdcIssuer })
    : account.address;

  /** Handing the address out is what makes it publishable — and un-sweepable. */
  async function publish() {
    try {
      await markPublished(account!.address);
    } catch {
      /* storage blocked — the sweep guard is best-effort, the money is still fine */
    }
  }

  async function copyAddress() {
    // Always the BARE address. A QR is scanned by a wallet, where a SEP-7 URI helps; a copied
    // string is pasted into an exchange's withdrawal field, which only accepts the address.
    try {
      await navigator.clipboard.writeText(account!.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      void publish();
    } catch {
      /* clipboard blocked */
    }
  }

  async function faucet() {
    setFaucetBusy(true);
    setError("");
    try {
      await getTestMoney(sponsorUrl(), account!.address);
      poll.refreshNow();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFaucetBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">{copy.receive.title}</h1>
        <p className="mt-1 text-sm text-ink-soft">{copy.receive.lead}</p>
      </header>

      {/* The correction, first, because it is the thing people get wrong. */}
      <MoneyCard className="p-5">
        <p className="font-semibold text-ink">{copy.receive.ownAccount}</p>
        <p className="mt-2 text-sm text-ink-soft">{copy.receive.noMemo}</p>
      </MoneyCard>

      {/* The network, named. Same deliberate exception /send-out makes. */}
      <div className="rounded-[16px] border border-line bg-paper p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
          <AlertTriangle className="size-4 text-danger" />
          {copy.receive.networkTitle}
        </p>
        <p className="mt-1 text-sm text-ink-soft">{copy.receive.networkBody(network)}</p>
        <p className="mt-2 text-sm text-ink-soft">{copy.receive.reciprocal}</p>
      </div>

      {origin === "test" && (
        <MoneyCard className="p-5">
          <p className="font-semibold text-ink">{copy.receive.testTitle}</p>
          <p className="mt-1 text-sm text-ink-soft">{copy.receive.testBody}</p>
          <p className="mt-2 text-sm text-ink-soft">{copy.receive.testFuture}</p>
          <div className="mt-3">
            <PrimaryButton loading={faucetBusy} loadingLabel="Getting test money…" onClick={faucet}>
              {copy.receive.faucetCta}
            </PrimaryButton>
          </div>
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </MoneyCard>
      )}

      {/* The address itself. */}
      <MoneyCard className="p-5">
        <p className="text-sm font-medium text-ink-soft">{copy.receive.addressLabel}</p>
        <p className="mt-2 break-all rounded-[12px] border border-line bg-paper px-3 py-2 font-mono text-xs text-ink-soft">
          {account.address}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={copyAddress}
            className="flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm font-medium text-ink"
          >
            {copied ? <Check className="size-4 text-money" /> : <Copy className="size-4" />}
            {copied ? copy.receive.copied : copy.receive.copyCta}
          </button>
          <button
            onClick={() => {
              setShowQr((v) => !v);
              if (!showQr) void publish();
            }}
            aria-expanded={showQr}
            className="flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm font-medium text-ink"
          >
            <QrCode className="size-4" />
            {showQr ? copy.receive.qrHide : copy.receive.qrShow}
          </button>
        </div>
        {showQr && (
          <div className="mt-4 flex flex-col items-center gap-2">
            <div className="rounded-[16px] bg-white p-4">
              <QRCode value={plainQr ? account.address : uri} size={176} bgColor="#FFFFFF" fgColor="#000000" level="M" />
            </div>
            <button
              onClick={() => setPlainQr((v) => !v)}
              className="text-xs font-medium text-money underline-offset-2 hover:underline"
            >
              {plainQr ? copy.receive.qrSep7 : copy.receive.qrPlain}
            </button>
            <p className="max-w-xs text-center text-xs text-ink-soft">{copy.receive.qrNote}</p>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-soft">{copy.receive.minimum}</p>
      </MoneyCard>

      {/* Waiting, stated honestly: what it last saw and when, plus a way to look again. */}
      <MoneyCard className="p-5">
        {arrived ? (
          <p className="font-semibold text-money">{copy.receive.arrived(arrived)}</p>
        ) : (
          <p className="font-semibold text-ink">{copy.receive.waiting}</p>
        )}
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-sm text-ink-soft">
            {total === null
              ? "Looking…"
              : `You have ${formatUsd(total)}${poll.lastCheckedAt ? ` · checked ${agoLabel(poll.lastCheckedAt)}` : ""}`}
          </p>
          <button
            onClick={poll.refreshNow}
            disabled={poll.checking}
            className="shrink-0 rounded-full border border-line px-3 py-1 text-xs font-medium text-money disabled:opacity-50"
          >
            {poll.checking ? "Checking…" : copy.receive.checkAgain}
          </button>
        </div>
      </MoneyCard>

      <p className="text-sm text-ink-soft">
        Sending money out instead?{" "}
        <Link href="/send-out" className="text-money underline-offset-2 hover:underline">
          Send to an exchange
        </Link>
        .
      </p>
    </div>
  );
}
