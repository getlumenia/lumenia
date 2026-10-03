/**
 * The settle loop: read the escrow for every record that is not final yet, and move it along.
 *
 * It runs on an alarm every minute while anything is open, when the worker starts, and when the
 * popup opens; it reads only the public RPC (v2DepositLanded, loadV2DropStatus) with the record's
 * own network and the sender as the simulation source. It never talks to the sponsor: the mainnet
 * Worker allows 5 requests a minute per account, and those belong to sends.
 *
 * It never sends anything either. An uncertain deposit is re-read until the escrow settles it, and
 * a failed one is read once more an hour later (links.ts onRecheck).
 *
 * A read takes a while, and a take-back or a paste may write the same record meanwhile. The answer
 * is therefore applied to the record as stored when the read finishes, not to the snapshot the pass
 * started from, so a flag written in between is never overwritten.
 */
import type { NetworkConfig } from "../core";
import { isDue, isFinal, netForRecord, onDropRead, onLanded, onRecheck } from "../lib/links";
import type { LinkRecord, NetId } from "../lib/types";

export const SETTLE_ALARM = "settle";
/** Reads per pass, so a long list never turns one alarm into a burst against a public RPC. */
export const MAX_READS_PER_PASS = 10;

export interface SettleDeps {
  now(): number;
  records(): Promise<LinkRecord[]>;
  /** the record as stored right now (null once it is gone) */
  get(linkHex: string): Promise<LinkRecord | null>;
  put(r: LinkRecord): Promise<void>;
  netConfig(id: NetId): NetworkConfig;
  landed(linkHex: string, sender: string, net: NetworkConfig): Promise<boolean | "unknown">;
  dropStatus(linkHex: string, sender: string, net: NetworkConfig): Promise<"pending" | "settled" | "unknown">;
  /** a send in THIS worker still owns the record (its POST is in flight); leave it alone */
  inFlight(r: LinkRecord): boolean;
}

/**
 * One pass. `force` reads every open record now (the popup opened, or the user asked); `only`
 * limits the pass to one link. Returns the records that changed.
 */
export async function settleOnce(deps: SettleDeps, opts: { force?: boolean; only?: string } = {}): Promise<LinkRecord[]> {
  const start = deps.now();
  // `force` reads open links now; a failed link's one last check waits for its time even then, so
  // the node that just answered "empty" is not asked again a minute later in its place.
  const open = (await deps.records()).filter(
    (r) =>
      !isFinal(r) && !deps.inFlight(r) && (!opts.only || r.linkHex === opts.only) && ((opts.force && r.phase !== "failed") || isDue(r, start)),
  );
  open.sort((a, b) => (a.nextCheckAt ?? 0) - (b.nextCheckAt ?? 0));
  const changed: LinkRecord[] = [];
  for (const r of open.slice(0, MAX_READS_PER_PASS)) {
    let step: (x: LinkRecord) => LinkRecord;
    try {
      const net = netForRecord(deps.netConfig(r.net), r);
      if (r.phase === "submitted" || r.phase === "uncertain") {
        const landed = await deps.landed(r.linkHex, r.sender, net);
        step = (x) => onLanded(x, landed, deps.now());
      } else if (r.phase === "failed") {
        const landed = await deps.landed(r.linkHex, r.sender, net);
        step = (x) => onRecheck(x, landed, deps.now());
      } else {
        const read = await deps.dropStatus(r.linkHex, r.sender, net);
        step = (x) => onDropRead(x, read, deps.now());
      }
    } catch {
      // The readers answer "unknown" rather than throw; anything else is a bug, read as "unknown".
      step = (x) =>
        x.phase === "failed" ? onRecheck(x, "unknown", deps.now()) : x.phase === "confirmed" ? onDropRead(x, "unknown", deps.now()) : onLanded(x, "unknown", deps.now());
    }
    const current = await deps.get(r.linkHex);
    if (!current) continue; // forgotten while it was being read
    const next = step(current);
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      await deps.put(next);
      changed.push(next);
    }
  }
  return changed;
}

/** Is any record still open (so the alarm should keep running)? */
export function anyOpen(records: LinkRecord[]): boolean {
  return records.some((r) => !isFinal(r));
}
