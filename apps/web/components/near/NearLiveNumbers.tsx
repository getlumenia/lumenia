"use client";

/**
 * The rail's live numbers, read from get_stats on the escrow itself. The server renders the first
 * answer (so the page carries real figures on arrival), and this island re-reads every 30 s while
 * the tab is visible. A failed read never becomes a zero: the tiles stay on the last good answer
 * and a line says the read failed; with no answer at all the space says so.
 */
import { useEffect, useState } from "react";
import type { StatsView } from "../../lib/near/drops";
import { formatUsd } from "../../lib/near/amount";
import { getStats } from "../../lib/near/rpc";

const REFRESH_MS = 30_000;
const nf = new Intl.NumberFormat("en-US");

export function NearLiveNumbers({ initial, compact = false }: { initial: StatsView | null; compact?: boolean }) {
  const [stats, setStats] = useState<StatsView | null>(initial);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = () => {
      if (document.visibilityState !== "visible") return;
      getStats()
        .then((s) => {
          if (!alive) return;
          if (s) setStats(s);
          setStale(false);
        })
        .catch(() => alive && setStale(true));
    };
    if (!initial) read();
    const id = window.setInterval(read, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [initial]);

  if (!stats) {
    return (
      <p className="nr-empty">
        The live numbers could not be read from the NEAR network just now. This space stays empty rather than guessing;
        check back in a moment.
      </p>
    );
  }

  return (
    <>
      <div className="nr-tiles">
        <div className="nr-tile">
          <span className="nr-tile-n nr-tile-n--accent">{nf.format(stats.drops_created)}</span>
          <span className="nr-tile-l">Links created</span>
          {!compact && <span className="nr-tile-s">each one an escrow on NEAR</span>}
        </div>
        <div className="nr-tile">
          <span className="nr-tile-n">{nf.format(stats.drops_claimed)}</span>
          <span className="nr-tile-l">Claimed</span>
          {!compact && <span className="nr-tile-s">into an account made at the claim</span>}
        </div>
        <div className="nr-tile">
          <span className="nr-tile-n">{nf.format(stats.drops_reclaimed)}</span>
          <span className="nr-tile-l">Returned</span>
          {!compact && <span className="nr-tile-s">taken back after the link expired</span>}
        </div>
        <div className="nr-tile">
          <span className="nr-tile-n">{formatUsd(stats.total_amount_created ?? "0")}</span>
          <span className="nr-tile-l">Sent in total</span>
          {!compact && <span className="nr-tile-s">test dollars, every cent on the ledger</span>}
        </div>
      </div>
      <p className="nr-meta">
        Read from the escrow contract on NEAR testnet{stale ? ", last read failed, showing the previous answer" : ""}.{" "}
        <a href="/near/ledger">Open the public ledger &rarr;</a>
      </p>
    </>
  );
}
