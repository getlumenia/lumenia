"use client";

/**
 * Pay it forward: the claimed account makes a new link from its own USDC. It signs a NEP-366
 * delegate with the full-access key the escrow gave it; the relayer pays the fee, so the account
 * keeps its starter NEAR. The orchestration is lib/near/pay-forward.ts (record before sign, held by
 * the self-test); this is the screen around it, plus the list of links this account paid forward
 * with a relayer-paid take-back after expiry.
 */
import { useState, type FormEvent } from "react";
import type { KeyPairString } from "near-api-js";
import QRCode from "react-qr-code";
import { MoneyCard } from "../../../components/brand/MoneyCard";
import { PrimaryButton } from "../../../components/brand/PrimaryButton";
import { CopyButton, ExplorerLink, Field, Notice, SmallButton, StateLine } from "../../../components/near/primitives";
import { useInterval, useLoadable, useNow } from "../../../lib/near/hooks";
import { NEAR_CONTRACT_ID, NEAR_NETWORK, NEAR_USDC_ID, explorerTxUrl, nearLinkOrigin } from "../../../lib/near/config";
import { formatNear, formatUsd, formatUsdc, parseUsdcAmount } from "../../../lib/near/amount";
import { DEFAULT_MIN_AMOUNT_UNITS } from "../../../lib/near/batch";
import { MAX_MEMO_BYTES, isTerminal, memoBytes } from "../../../lib/near/drops";
import { describeError } from "../../../lib/near/errors";
import { EXPIRY_OPTIONS } from "../../../lib/near/expiry";
import { claimUrl, newLinkKey } from "../../../lib/near/keys";
import { getConfig, getDrop, nearBalance } from "../../../lib/near/rpc";
import { sharedProvider } from "../../../lib/near/chain";
import { canTakeBack, linkStateOf, linkStatusLine, recordDrop } from "../../../lib/near/link-state";
import { describeRelayError, isRelayerExpiry, runPayForward, type PayForwardResult } from "../../../lib/near/pay-forward";
import { buildSignedDelegateForPayForward, buildSignedDelegateForReclaim, relay } from "../../../lib/near/relayer";
import { loadLinks, saveLink, upsertLink, type ClaimedAccount, type StoredLink } from "../../../lib/near/store";

const RELAYER_EXPIRIES = EXPIRY_OPTIONS.filter((o) => isRelayerExpiry(o.seconds));

export function PayForwardCard({
  account,
  privateKey,
  balanceUnits,
  onChanged,
}: {
  account: ClaimedAccount;
  privateKey: string;
  balanceUnits: string | null;
  onChanged?: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [expiry, setExpiry] = useState<number>(RELAYER_EXPIRIES[RELAYER_EXPIRIES.length - 1]?.seconds ?? 604_800);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [errTx, setErrTx] = useState<string | null>(null);
  const [done, setDone] = useState<(PayForwardResult & { created: true }) | null>(null);
  const [version, setVersion] = useState(0);
  const config = useLoadable(() => getConfig(), [], 60_000);
  const minUnits = config.value.state === "ready" ? (config.value.value.min_amount ?? DEFAULT_MIN_AMOUNT_UNITS) : DEFAULT_MIN_AMOUNT_UNITS;
  const nearLeft = useLoadable(() => nearBalance(account.accountId), [account.accountId, version]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setErrTx(null);
    const parsed = parseUsdcAmount(amount, { maxUnits: balanceUnits ?? undefined });
    if (!parsed.ok) {
      setErr(balanceUnits !== null && /limit here/.test(parsed.reason) ? `You hold ${formatUsd(balanceUnits)}; the link cannot be larger than that.` : parsed.reason);
      return;
    }
    if (BigInt(parsed.units) < BigInt(minUnits)) {
      setErr(`The smallest link is ${formatUsdc(minUnits)} USDC.`);
      return;
    }
    if (memoBytes(memo) > MAX_MEMO_BYTES) {
      setErr(`The memo is too long (${memoBytes(memo)} of ${MAX_MEMO_BYTES} bytes).`);
      return;
    }
    setBusy(true);
    try {
      setStep("Keeping the link safe");
      const result = await runPayForward(
        { senderId: account.accountId, amountUnits: parsed.units, memo, expiresInS: expiry, network: NEAR_NETWORK, usdcId: NEAR_USDC_ID, escrowId: NEAR_CONTRACT_ID },
        {
          newKey: newLinkKey,
          saveLink: async (l) => {
            await saveLink(l);
            onChanged?.();
          },
          updateLink: (p) => {
            upsertLink(p);
            onChanged?.();
          },
          buildDelegate: (a) => {
            setStep("Signing with your key");
            return buildSignedDelegateForPayForward({
              senderId: a.senderId,
              senderKeyPair: privateKey as KeyPairString,
              usdcId: a.usdcId,
              escrowId: a.escrowId,
              amountUnits: a.amountUnits,
              msg: a.msg,
              provider: sharedProvider(),
            });
          },
          relay: (b64) => {
            setStep("Asking the relayer to pay the fee");
            return relay(b64);
          },
          now: Date.now,
        },
      );
      if (!result.created) {
        setErr(`The link was not created: ${result.reason}`);
        setErrTx(result.txHash);
        return;
      }
      setStep("Confirming the link");
      try {
        const d = await getDrop(result.link.publicKey);
        if (d) recordDrop(result.link.publicKey, d);
      } catch {
        // the state line keeps polling below
      }
      setDone(result);
      setAmount("");
      setMemo("");
      setVersion((v) => v + 1);
    } catch (e2) {
      setErr(describeRelayError(e2));
    } finally {
      setBusy(false);
      setStep("");
      onChanged?.();
    }
  };

  return (
    <>
      <MoneyCard className="nc-card flex flex-col gap-4 p-5">
        <div>
          <h2 className="text-lg font-semibold text-ink">Pay it forward</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Send part of this money on as a new link, straight from your account. You sign with your own key; the relayer pays
            the NEAR fee, so you keep your starter NEAR.
          </p>
        </div>
        {done ? (
          <PayForwardDone result={done} nearLeft={nearLeft.value.state === "ready" ? nearLeft.value.value : null} onAnother={() => setDone(null)} />
        ) : (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
            <Field
              label="Amount"
              htmlFor="nc-pf-amount"
              hint={balanceUnits !== null ? `You hold ${formatUsd(balanceUnits)}; the smallest link is ${formatUsdc(minUnits)} USDC.` : `The smallest link is ${formatUsdc(minUnits)} USDC.`}
            >
              <div className="nr-amount">
                <span>$</span>
                <input id="nc-pf-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.25" autoComplete="off" />
              </div>
            </Field>
            <Field label="The link expires in" htmlFor="nc-pf-expiry" hint="The relayer pays for links that live between 1 hour and 7 days.">
              <select id="nc-pf-expiry" className="nr-select" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
                {RELAYER_EXPIRIES.map((o) => (
                  <option key={o.seconds} value={o.seconds}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Memo (optional)" htmlFor="nc-pf-memo">
              <input id="nc-pf-memo" className="nr-input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Your share of the dinner" maxLength={MAX_MEMO_BYTES} />
            </Field>
            {err ? (
              <Notice kind="error">
                {err}
                {errTx ? (
                  <div className="mt-2">
                    <ExplorerLink href={explorerTxUrl(errTx)}>View the transaction on the explorer</ExplorerLink>
                  </div>
                ) : null}
              </Notice>
            ) : null}
            <PrimaryButton type="submit" loading={busy} loadingLabel={step ? `${step}...` : "Working..."} disabled={balanceUnits === null || BigInt(balanceUnits) < BigInt(minUnits)}>
              Create the link, fee paid by the relayer
            </PrimaryButton>
          </form>
        )}
      </MoneyCard>
      <PayForwardLinks account={account} privateKey={privateKey} version={version} onChanged={() => setVersion((v) => v + 1)} />
    </>
  );
}

function PayForwardDone({ result, nearLeft, onAnother }: { result: PayForwardResult & { created: true }; nearLeft: bigint | null; onAnother: () => void }) {
  const url = claimUrl(nearLinkOrigin(), result.link.secret as KeyPairString);
  const now = useNow(1000);
  const [live, setLive] = useState<StoredLink>(() => loadLinks().find((l) => l.publicKey === result.link.publicKey) ?? result.link);
  const terminal = live.lastStatus ? isTerminal(live.lastStatus) : false;
  useInterval(
    () => {
      getDrop(result.link.publicKey)
        .then((d) => {
          if (d) recordDrop(result.link.publicKey, d);
          setLive(loadLinks().find((l) => l.publicKey === result.link.publicKey) ?? live);
        })
        .catch(() => undefined);
    },
    terminal ? null : 5000,
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-3xl font-bold tabular-nums text-ink">{formatUsd(result.link.amountUnits)}</p>
      <p className="nc-mono break-all rounded-[12px] border border-line bg-paper px-3 py-2 text-xs text-ink-soft">{url}</p>
      <div className="nr-qr">
        <QRCode value={url} size={160} bgColor="#FFFFFF" fgColor="#000000" level="M" />
      </div>
      <StateLine state={linkStateOf(live, now)} />
      <p className="text-sm text-ink-soft">{linkStatusLine(live, now)}</p>
      <p className="text-sm text-ink">The relayer paid the fee; you still hold {nearLeft !== null ? `${formatNear(nearLeft, 2)} NEAR` : "your NEAR"}.</p>
      <div className="nr-row-actions">
        <CopyButton text={url} />
        <SmallButton onClick={onAnother}>Pay forward again</SmallButton>
        <ExplorerLink href={result.explorerUrl || explorerTxUrl(result.txHash)}>explorer</ExplorerLink>
      </div>
    </div>
  );
}

/** Links this account paid forward, with live state and a relayer-paid take-back after expiry. */
function PayForwardLinks({ account, privateKey, version, onChanged }: { account: ClaimedAccount; privateKey: string; version: number; onChanged: () => void }) {
  const mineOnly = () => loadLinks().filter((l) => l.relayed && l.funder === account.accountId);
  const [links, setLinks] = useState<StoredLink[]>(mineOnly);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const now = useNow(1000);
  useInterval(() => setLinks(mineOnly()), 1000);
  const pending = links.filter((l) => !(l.lastStatus && isTerminal(l.lastStatus)));
  useInterval(
    () => {
      void (async () => {
        for (const l of pending) {
          try {
            const d = await getDrop(l.publicKey);
            if (d) recordDrop(l.publicKey, d);
          } catch {
            // keep the last chain-read status
          }
        }
        setLinks(mineOnly());
      })();
    },
    pending.length ? 5000 : null,
  );
  void version;

  const takeBack = async (l: StoredLink) => {
    setBusyKey(l.publicKey);
    setRowErr((m) => ({ ...m, [l.publicKey]: "" }));
    try {
      const built = await buildSignedDelegateForReclaim({
        senderId: account.accountId,
        senderKeyPair: privateKey as KeyPairString,
        escrowId: NEAR_CONTRACT_ID,
        linkPublicKey: l.publicKey,
        provider: sharedProvider(),
      });
      const r = await relay(built.base64);
      upsertLink({ publicKey: l.publicKey, reclaimTxHash: r.txHash });
      if (r.outcome.status !== "success" || r.outcome.reclaimed === false) {
        throw new Error(r.outcome.failures[0] ?? r.outcome.summary ?? "the contract did not return the money");
      }
      const d = await getDrop(l.publicKey);
      if (d) recordDrop(l.publicKey, d);
    } catch (e) {
      setRowErr((m) => ({ ...m, [l.publicKey]: e instanceof Error && e.name === "RelayRequestError" ? describeRelayError(e) : describeError(e) }));
    } finally {
      setBusyKey(null);
      setLinks(mineOnly());
      onChanged();
    }
  };

  if (!links.length) return null;
  return (
    <MoneyCard className="nc-card p-5">
      <h2 className="text-lg font-semibold text-ink">Links you paid forward</h2>
      <div className="nr-rows mt-2">
        {links.map((l) => {
          const state = linkStateOf(l, now);
          const err = rowErr[l.publicKey];
          const tx = l.lastStatus === "Reclaimed" && l.reclaimTxHash ? l.reclaimTxHash : l.createTxHash;
          return (
            <div className="nr-row" key={l.publicKey}>
              <div className="nr-row-top">
                <span className="nr-row-amt">{formatUsd(l.amountUnits)}</span>
                {l.memo ? <span className="nr-row-when">{l.memo}</span> : null}
              </div>
              <StateLine state={state} />
              <p className="nr-row-sub">{linkStatusLine(l, now)}</p>
              {err ? <Notice kind="error">{err}</Notice> : null}
              <div className="nr-row-actions">
                {canTakeBack(l, now) ? (
                  <SmallButton className="nr-btn--accent" busy={busyKey === l.publicKey} onClick={() => void takeBack(l)}>
                    Take it back, fee paid by the relayer
                  </SmallButton>
                ) : null}
                {tx ? <ExplorerLink href={explorerTxUrl(tx)}>explorer</ExplorerLink> : null}
              </div>
            </div>
          );
        })}
      </div>
    </MoneyCard>
  );
}
