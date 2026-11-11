"use client";

/**
 * Send to many: one transaction, up to 30 links. Rows are `label, amount[, memo]`; the label is for
 * the sender's own bookkeeping and never leaves this browser (it travels into the CSV export, not
 * into the chain). Every key is generated and kept BEFORE the transfer is signed, the same rule the
 * single link follows; the escrow refunds the whole batch if any row is off, so nothing half-lands.
 *
 * Own account key only. The shared practice balance makes one link per request, one request every
 * 30 seconds (lib/near/practice.ts), so a batch from it would be a slow loop pretending to be one
 * transaction: in practice mode this tab says so and offers the own-key path instead.
 */
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import type { KeyPairString } from "near-api-js";
import QRCode from "react-qr-code";
import { MoneyCard } from "../brand/MoneyCard";
import { PrimaryButton } from "../brand/PrimaryButton";
import { CopyButton, Details, ExplorerLink, Field, Notice, SmallButton, StateLine } from "./primitives";
import { useInterval, useLoadable, useNow } from "../../lib/near/hooks";
import { NEAR_CONTRACT_ID, NEAR_MAX_LINK_UNITS, NEAR_NETWORK, NEAR_USDC_ID, explorerTxUrl, nearLinkOrigin } from "../../lib/near/config";
import { formatUsd } from "../../lib/near/amount";
import { DEFAULT_MIN_AMOUNT_UNITS, MAX_BATCH_DROPS, buildBatchMsg, parseBatchRows, type BatchRow } from "../../lib/near/batch";
import { describeError } from "../../lib/near/errors";
import { DEFAULT_EXPIRY_S, EXPIRY_OPTIONS, formatLocal, toIso } from "../../lib/near/expiry";
import { claimUrl, newLinkKey } from "../../lib/near/keys";
import { getConfig, getDropsByFunder, usdcBalance } from "../../lib/near/rpc";
import { sendFunctionCall } from "../../lib/near/chain";
import { ftTransferCallUsedAmount, refusalReason, txFailure } from "../../lib/near/outcome";
import { linkExpiresAt, linkStateOf, linkStatusLine } from "../../lib/near/link-state";
import { loadLinks, saveLink, upsertLink, type FunderSession, type StoredLink } from "../../lib/near/store";

const EXAMPLE = "Ada, 5, rent\nBob, 0.10\nCy, 1.25, thanks";

type Outcome =
  | { kind: "created"; batchId: string; txHash: string; confirmed: number; expected: number; links: StoredLink[] }
  | { kind: "failed"; batchId: string; txHash: string | null; message: string };

export function NearSendMany({ funder, onChange, onUseOwnKey }: { funder: FunderSession; onChange: () => void; onUseOwnKey?: () => void }) {
  if (funder.demo || !funder.secret) return <PracticeManyNote onUseOwnKey={onUseOwnKey} />;
  return <SendManyForm funder={{ accountId: funder.accountId, secret: funder.secret }} onChange={onChange} />;
}

function PracticeManyNote({ onUseOwnKey }: { onUseOwnKey?: () => void }) {
  return (
    <MoneyCard className="flex flex-col gap-3 p-5">
      <p className="font-semibold text-ink">Send to many</p>
      <p className="text-sm text-ink-soft">
        The shared practice balance makes one link at a time. Send to many puts every link in one transaction from your own
        account, so it needs your own account key.
      </p>
      {onUseOwnKey ? (
        <SmallButton className="self-start" onClick={onUseOwnKey}>
          Use your own account key
        </SmallButton>
      ) : null}
    </MoneyCard>
  );
}

function SendManyForm({ funder, onChange }: { funder: { accountId: string; secret: string }; onChange: () => void }) {
  const [text, setText] = useState("");
  const [expiry, setExpiry] = useState<number>(DEFAULT_EXPIRY_S);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const config = useLoadable(() => getConfig(), [], 60_000);
  const balance = useLoadable(() => usdcBalance(funder.accountId), [funder.accountId], 15_000);
  const minUnits = config.value.state === "ready" ? (config.value.value.min_amount ?? DEFAULT_MIN_AMOUNT_UNITS) : DEFAULT_MIN_AMOUNT_UNITS;
  const maxExpiry = config.value.state === "ready" ? config.value.value.max_expiry_s : Number.MAX_SAFE_INTEGER;
  const maxUnitsPerRow = NEAR_MAX_LINK_UNITS;
  const parsed = useMemo(() => parseBatchRows(text, { minUnits, maxUnitsPerRow }), [text, minUnits, maxUnitsPerRow]);
  const balanceUnits = balance.value.state === "ready" ? BigInt(balance.value.value) : null;
  const overBalance = balanceUnits !== null && BigInt(parsed.totalUnits) > balanceUnits;
  const ready = parsed.errors.length === 0 && parsed.rows.length > 0 && !overBalance && balanceUnits !== null && expiry <= maxExpiry;

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    f.text()
      .then((t) => setText(t))
      .catch((err: unknown) => setText(`# could not read the file: ${describeError(err)}`));
  };

  const run = async () => {
    if (!ready) return;
    const rows = parsed.rows;
    const batchId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = toIso(Date.now());
    const links: StoredLink[] = rows.map((r: BatchRow) => {
      const key = newLinkKey();
      return {
        publicKey: key.publicKey,
        secret: key.secret,
        amountUnits: r.amountUnits,
        memo: r.memo,
        expiresInS: expiry,
        createdAt,
        funder: funder.accountId,
        network: NEAR_NETWORK,
        label: r.label,
        batchId,
      };
    });
    setBusy(true);
    setOutcome(null);
    // Every key is generated and KEPT before anything is signed.
    setStep("Keeping the links safe");
    for (const l of links) await saveLink(l);
    onChange();
    let txHash: string | null = null;
    try {
      const msg = buildBatchMsg(
        links.map((l) => ({ publicKey: l.publicKey, amountUnits: l.amountUnits, memo: l.memo })),
        expiry,
        parsed.totalUnits,
        minUnits,
      );
      setStep("Signing and sending");
      const sent = await sendFunctionCall({
        signerId: funder.accountId,
        secretKey: funder.secret as KeyPairString,
        receiverId: NEAR_USDC_ID,
        methodName: "ft_transfer_call",
        args: { receiver_id: NEAR_CONTRACT_ID, amount: parsed.totalUnits, msg },
        gasTgas: 300,
        depositYocto: 1n,
        onSigned: (h) => {
          txHash = h;
          for (const l of links) upsertLink({ publicKey: l.publicKey, createTxHash: h });
          onChange();
        },
      });
      txHash = sent.txHash;
      const failure = txFailure(sent.outcome);
      if (failure) throw new Error(`The transaction failed: ${failure}`);
      const used = ftTransferCallUsedAmount(sent.outcome);
      if (used !== null && used !== parsed.totalUnits) {
        const why = refusalReason(sent.outcome);
        const message = `The escrow handed the money back to ${funder.accountId}${why ? ` (${why})` : ""}. No links were created.`;
        for (const l of links) upsertLink({ publicKey: l.publicKey, createError: why ?? "refunded" });
        setOutcome({ kind: "failed", batchId, txHash, message });
        return;
      }
      setStep("Confirming the links");
      const confirmed = await confirmBatch(funder.accountId, links);
      setOutcome({ kind: "created", batchId, txHash: sent.txHash, confirmed, expected: links.length, links });
      setText("");
    } catch (e) {
      const message = describeError(e);
      for (const l of links) upsertLink({ publicKey: l.publicKey, createError: message });
      setOutcome({ kind: "failed", batchId, txHash, message });
    } finally {
      setBusy(false);
      setStep("");
      onChange();
    }
  };

  if (outcome?.kind === "created") {
    return <BatchCreated outcome={outcome} feeNote="paid by your account" onAnother={() => setOutcome(null)} />;
  }

  return (
    <MoneyCard className="flex flex-col gap-4 p-5">
      <div>
        <p className="font-semibold text-ink">Send to many</p>
        <p className="mt-1 text-sm text-ink-soft">
          One row per person: <code className="nr-mono">label, amount[, memo]</code>. Up to {MAX_BATCH_DROPS} rows, at least {formatUsd(minUnits)} each.
          One transaction makes every link; if anything is off, the escrow returns all of it.
        </p>
      </div>
      <Field label="Rows" htmlFor="nr-rows" hint="Paste, or load a CSV file below. The label is only for you; it never leaves this browser.">
        <textarea id="nr-rows" className="nr-textarea nr-textarea--mono" value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} spellCheck={false} />
      </Field>
      <Field label="Or load a file" htmlFor="nr-rows-file">
        <input id="nr-rows-file" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={onFile} className="text-sm text-ink-soft" />
      </Field>
      <Field label="The links expire in" htmlFor="nr-many-expiry">
        <select id="nr-many-expiry" className="nr-select" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
          {EXPIRY_OPTIONS.filter((o) => o.seconds <= maxExpiry).map((o) => (
            <option key={o.seconds} value={o.seconds}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      {text.trim() ? (
        <div className="flex flex-col gap-3">
          <table className="nr-table">
            <thead>
              <tr>
                <th>Label</th>
                <th className="nr-num">Amount</th>
                <th>Memo</th>
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((r) => (
                <tr key={r.line}>
                  <td>{r.label}</td>
                  <td className="nr-num">{formatUsd(r.amountUnits)}</td>
                  <td className="text-ink-soft">{r.memo}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>
                  {parsed.rows.length} {parsed.rows.length === 1 ? "link" : "links"}
                </th>
                <th className="nr-num">{formatUsd(parsed.totalUnits)}</th>
                <th />
              </tr>
            </tfoot>
          </table>
          {parsed.errors.length ? (
            <Notice kind="error">
              {parsed.errors.map((e) => (
                <div key={`${e.line}-${e.reason}`}>
                  {e.line ? `line ${e.line}: ` : ""}
                  {e.reason}
                </div>
              ))}
            </Notice>
          ) : null}
        </div>
      ) : null}
      {balance.value.state === "error" ? (
        <Notice kind="error" onRetry={balance.reload}>
          Could not read your balance: {balance.value.message}
        </Notice>
      ) : overBalance && balanceUnits !== null ? (
        <Notice kind="error">
          The rows add up to {formatUsd(parsed.totalUnits)} but {funder.accountId} holds {formatUsd(balanceUnits)}.
        </Notice>
      ) : null}
      {outcome?.kind === "failed" ? (
        <Notice kind="error">
          {outcome.message}
          {outcome.txHash ? (
            <div className="mt-2">
              <ExplorerLink href={explorerTxUrl(outcome.txHash)}>View the transaction on the explorer</ExplorerLink>
            </div>
          ) : null}
        </Notice>
      ) : null}
      <PrimaryButton loading={busy} loadingLabel={step ? `${step}...` : "Working..."} disabled={!ready} onClick={() => void run()}>
        {parsed.rows.length ? `Create ${parsed.rows.length} ${parsed.rows.length === 1 ? "link" : "links"} for ${formatUsd(parsed.totalUnits)}` : "Create links"}
      </PrimaryButton>
    </MoneyCard>
  );
}

/** Confirms the batch with one get_drops_by_funder read (retrying for up to 20 s); returns how many were seen. */
async function confirmBatch(funder: string, links: StoredLink[]): Promise<number> {
  const wanted = new Set(links.map((l) => l.publicKey));
  const started = Date.now();
  for (;;) {
    const drops = await getDropsByFunder(funder, 0, 100);
    let seen = 0;
    for (const d of drops) {
      if (d.public_key && wanted.has(d.public_key)) {
        seen++;
        upsertLink({
          publicKey: d.public_key,
          lastStatus: d.status,
          lastReadAt: toIso(Date.now()),
          claimedTo: d.claimed_to,
          expiresAtNs: String(d.expires_at_ns),
          statusChangedAtNs: d.status_changed_at_ns === undefined ? undefined : String(d.status_changed_at_ns),
          createError: undefined,
        });
      }
    }
    if (seen === wanted.size || Date.now() - started > 20_000) return seen;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function BatchCreated({ outcome, feeNote, onAnother }: { outcome: Extract<Outcome, { kind: "created" }>; feeNote: string; onAnother: () => void }) {
  // The secrets are in memory on `outcome.links`; the statuses come from what Your links keeps polling.
  const [records, setRecords] = useState<StoredLink[]>(() => loadLinks().filter((l) => l.batchId === outcome.batchId));
  const [qrFor, setQrFor] = useState<string | null>(null);
  const now = useNow(1000);
  useInterval(() => setRecords(loadLinks().filter((l) => l.batchId === outcome.batchId)), 5000);
  useEffect(() => setRecords(loadLinks().filter((l) => l.batchId === outcome.batchId)), [outcome.batchId]);
  const secretOf = new Map(outcome.links.map((l) => [l.publicKey, l.secret as KeyPairString]));
  const shown = outcome.links.map((l) => records.find((r) => r.publicKey === l.publicKey) ?? l);
  return (
    <MoneyCard className="flex flex-col gap-3 p-5">
      <p className="font-semibold text-ink">
        {shown.length} {shown.length === 1 ? "link is" : "links are"} ready
      </p>
      <p className="text-sm text-ink-soft">
        One transaction made them
        {outcome.confirmed < outcome.expected ? ` (${outcome.confirmed} of ${outcome.expected} confirmed so far; the rest are still being checked)` : ""}.{" "}
        <ExplorerLink href={explorerTxUrl(outcome.txHash)}>View it on the explorer</ExplorerLink>
      </p>
      <div className="nr-rows">
        {shown.map((l) => {
          const secret = secretOf.get(l.publicKey);
          const url = secret ? claimUrl(nearLinkOrigin(), secret) : null;
          const state = linkStateOf(l, now);
          return (
            <div className="nr-row" key={l.publicKey}>
              <div className="nr-row-top">
                <span className="nr-row-amt">
                  {formatUsd(l.amountUnits)}
                  {l.label ? <small>{l.label}</small> : null}
                </span>
              </div>
              {l.memo ? <p className="nr-row-memo">{l.memo}</p> : null}
              <StateLine state={state} />
              {url ? <p className="nr-mono break-all rounded-[12px] border border-line bg-paper px-3 py-2 text-xs text-ink-soft">{url}</p> : null}
              <Details
                rows={[
                  ["Made", formatLocal(Date.parse(l.createdAt))],
                  ["Status", linkStatusLine(l, now)],
                  ["Amount", formatUsd(l.amountUnits)],
                  ["Network fee", feeNote],
                  ["Expires", formatLocal(linkExpiresAt(l))],
                ]}
                explorer={[["View the transaction on explorer", explorerTxUrl(outcome.txHash)]]}
              />
              <div className="nr-row-actions">
                {url ? <CopyButton text={url} /> : null}
                {url ? (
                  <SmallButton onClick={() => setQrFor(qrFor === l.publicKey ? null : l.publicKey)} aria-pressed={qrFor === l.publicKey}>
                    {qrFor === l.publicKey ? "Hide QR" : "Show QR"}
                  </SmallButton>
                ) : null}
              </div>
              {qrFor === l.publicKey && url ? (
                <div className="nr-qr">
                  <QRCode value={url} size={160} bgColor="#FFFFFF" fgColor="#000000" level="M" />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <button type="button" className="nr-btn self-start" onClick={onAnother}>
        Send to many again
      </button>
    </MoneyCard>
  );
}
