"use client";

/**
 * /ledger: every link the escrow knows, newest first, 25 to a page, refreshed every 15 s. Amounts
 * and short account ids only. A memo belongs to the two people involved, so it is shown only on a
 * link THIS browser made (matched by the public key in local storage), and a link's secret never
 * appears anywhere here: the public key is what identifies a drop. The network is named inside the
 * Details disclosure under the footnote and inside each row's Details, nowhere else.
 */
import { useEffect, useMemo, useState } from "react";
import { StatusPill } from "../brand/StatusPill";
import { Details, Notice, SmallButton, Spinner, escrowExplorer, escrowRows } from "./primitives";
import { useLoadable, useNow } from "../../lib/near/hooks";
import { explorerAccountUrl, explorerTxUrl } from "../../lib/near/config";
import { formatUsd } from "../../lib/near/amount";
import type { DropStatus, StatsView } from "../../lib/near/drops";
import { formatLocal, isExpired, nsToMs } from "../../lib/near/expiry";
import { LEDGER_PAGE_SIZE, ledgerPage, toLedgerRows, type LocalDropInfo } from "../../lib/near/ledger";
import { getDrops, getStats } from "../../lib/near/rpc";
import { loadLinks } from "../../lib/near/store";

const REFRESH_MS = 15_000;

function statusWord(status: DropStatus, expiresAtNs: string, now: number): { status: "waiting" | "received" | "returned"; label: string } {
  if (status === "Claimed") return { status: "received", label: "Claimed" };
  if (status === "Reclaimed") return { status: "returned", label: "Returned" };
  if (status === "Claiming") return { status: "waiting", label: "Being claimed" };
  return isExpired(nsToMs(expiresAtNs), now) ? { status: "returned", label: "Expired" } : { status: "waiting", label: "Waiting" };
}

export function NearLedger({ initialStats }: { initialStats: StatsView | null }) {
  const now = useNow(1000);
  const [page, setPage] = useState(0);
  const stats = useLoadable(() => getStats(), [], REFRESH_MS);
  const live = stats.value.state === "ready" ? stats.value.value : initialStats;
  const total = live ? live.drops_created : null;
  const paging = ledgerPage(total ?? 0, page, LEDGER_PAGE_SIZE);
  const rows = useLoadable(() => getDrops(paging.from_index, paging.limit), [paging.from_index, paging.limit], REFRESH_MS);
  // Only this browser's own drops get a memo and a create-transaction link. Read after mount: local
  // storage is not something the server render can see.
  const [mine, setMine] = useState<Map<string, LocalDropInfo>>(() => new Map());
  useEffect(() => {
    const m = new Map<string, LocalDropInfo>();
    for (const l of loadLinks()) m.set(l.publicKey, { createTxHash: l.createTxHash });
    setMine(m);
  }, [rows.value]);
  const shown = useMemo(() => (rows.value.state === "ready" ? toLedgerRows(rows.value.value, mine) : []), [rows.value, mine]);

  return (
    <>
      {live ? (
        <p className="nr-ledger-totals">
          <span>
            <b>{live.drops_created}</b> {live.drops_created === 1 ? "link" : "links"}
          </span>
          <span>
            <b>{formatUsd(live.total_amount_created ?? "0")}</b> sent
          </span>
          <span>
            <b>{formatUsd(live.total_amount_claimed ?? "0")}</b> claimed
          </span>
          <span>
            <b>{formatUsd(live.total_amount_reclaimed ?? "0")}</b> returned
          </span>
          <span>
            <b>{live.open_drops}</b> open
          </span>
        </p>
      ) : stats.value.state === "error" ? (
        <div style={{ marginTop: 22 }}>
          <Notice kind="error" onRetry={stats.reload}>
            Could not read the totals: {stats.value.message}
          </Notice>
        </div>
      ) : (
        <p className="nr-ledger-totals">
          <Spinner /> Reading the totals...
        </p>
      )}

      <div className="nr-ledger" aria-live="polite">
        {rows.value.state === "loading" && shown.length === 0 ? (
          <div className="nr-ledger-row">
            <span className="nr-ledger-who">
              <Spinner /> Reading the links...
            </span>
          </div>
        ) : rows.value.state === "error" ? (
          <div className="nr-ledger-row">
            <div style={{ gridColumn: "1 / -1" }}>
              <Notice kind="error" onRetry={rows.reload}>
                Could not read the ledger: {rows.value.message}
              </Notice>
            </div>
          </div>
        ) : shown.length === 0 ? (
          <div className="nr-ledger-row">
            <span className="nr-ledger-who">No links yet{total ? " on this page" : ""}.</span>
          </div>
        ) : (
          shown.map((r) => {
            const s = statusWord(r.status, r.expiresAtNs, now);
            return (
              <div className="nr-ledger-row" key={r.publicKey}>
                <span className="nr-ledger-amt">{formatUsd(r.amountUnits)}</span>
                <span className="nr-ledger-who">
                  from <b>{r.funderShort}</b>
                  {r.claimedTo ? (
                    <>
                      {" "}
                      to <b>{r.claimedToShort}</b>
                    </>
                  ) : null}
                  <br />
                  made {formatLocal(nsToMs(r.createdAtNs))}, expires {formatLocal(nsToMs(r.expiresAtNs))}.
                  <Details
                    rows={[
                      ["Made", formatLocal(nsToMs(r.createdAtNs))],
                      ["Status", s.label],
                      ["Amount", formatUsd(r.amountUnits)],
                      ["Network fee", r.claimedTo ? "the claim was covered by Lumenia" : "covered by Lumenia at the claim"],
                      ["Expires", formatLocal(nsToMs(r.expiresAtNs))],
                    ]}
                    explorer={[
                      ...(r.createTxHash ? [["View the transaction on explorer", explorerTxUrl(r.createTxHash)] as [string, string]] : []),
                      [r.claimedTo ? "View the recipient on explorer" : "View the sender on explorer", explorerAccountUrl(r.claimedTo ?? r.funder)],
                    ]}
                  />
                </span>
                <span className="nr-ledger-status">
                  {r.mine ? <span className="nr-yours">yours</span> : null}
                  <StatusPill status={s.status} label={s.label} />
                </span>
                {r.mine && r.memo ? <span className="nr-ledger-memo">{r.memo}</span> : null}
              </div>
            );
          })
        )}
      </div>

      {total !== null && paging.pages > 1 ? (
        <div className="nr-pager">
          <SmallButton disabled={!paging.hasNewer} onClick={() => setPage(paging.page - 1)}>
            Newer
          </SmallButton>
          <span>
            page {paging.page + 1} of {paging.pages}
          </span>
          <SmallButton disabled={!paging.hasOlder} onClick={() => setPage(paging.page + 1)}>
            Older
          </SmallButton>
        </div>
      ) : null}
      <div className="nr-meta">
        <p>
          Read from the escrow every 15 seconds. Newest first. A link&apos;s secret never appears here; only its public key
          identifies a drop. Memos are shown only for links made in this browser.
        </p>
        {/* Where this ledger lives: the escrow account, what it holds, the network and the explorer. */}
        <Details rows={escrowRows()} explorer={escrowExplorer()} />
      </div>
    </>
  );
}
