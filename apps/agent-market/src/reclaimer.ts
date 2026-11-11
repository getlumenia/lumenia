// Expired, unclaimed links go back to the treasury. The pass walks the state
// file: every link past its expiry is read from the chain and, when the
// contract says Expired, reclaimed through the library. It also looks again at
// jobs that were declined as failed: if their deposit landed after all (an RPC
// error after the broadcast), the links are adopted into the record so they are
// taken back after expiry instead of being forgotten.
import type { Logger } from "./log.js";
import { silentLogger } from "./log.js";
import { errorText, type PayoutRail } from "./rail.js";
import type { AssignmentRecord, LinkRecord, ReclaimEntry, StateStore } from "./state.js";

export interface ReclaimSummary {
  checked: number;
  reclaimed: ReclaimEntry[];
  claimed: number;
  open: number;
  skipped: number;
  adopted: number;
  errors: string[];
}

/** Statuses that need no further look. */
export function isFinalStatus(status: string): boolean {
  return status.startsWith("Claimed") || status === "Reclaimed" || status === "Failed" || status === "NotFound";
}

/** How long after a declined job the pass keeps checking whether its deposit landed anyway (max expiry + margin). */
export const ADOPT_WINDOW_MS = 8 * 24 * 3_600_000;

export async function reclaimPass(deps: { rail: PayoutRail; state: StateStore; now?: () => Date; log?: Logger }): Promise<ReclaimSummary> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;
  const summary: ReclaimSummary = { checked: 0, reclaimed: [], claimed: 0, open: 0, skipped: 0, adopted: 0, errors: [] };

  for (const rec of deps.state.all()) {
    let dirty = false;
    const nowIso = now().toISOString();

    if (rec.phase === "failed" && now().getTime() - Date.parse(rec.firstSeenAt) < ADOPT_WINDOW_MS) {
      const adopted = await adoptLandedLinks(rec, deps.rail, nowIso, summary);
      if (adopted > 0) {
        summary.adopted += adopted;
        dirty = true;
        log.warn("declined job has links on chain after all; adopted them for reclaim after expiry", { assignmentId: rec.assignmentId, links: adopted });
      }
    }

    for (const link of rec.links) {
      if (isFinalStatus(link.status)) continue;
      if (Date.parse(link.expiresAt) > now().getTime()) {
        summary.open++;
        continue;
      }
      summary.checked++;
      try {
        const status = await deps.rail.linkStatus(link.publicKey);
        link.lastCheckedAt = nowIso;
        dirty = true;
        switch (status.drop.kind) {
          case "Expired": {
            const r = await deps.rail.reclaim(link.publicKey);
            link.status = "Reclaimed";
            link.reclaimTxHash = r.txHash;
            const entry: ReclaimEntry = {
              at: nowIso,
              assignmentId: rec.assignmentId,
              publicKey: link.publicKey,
              label: link.label,
              amountUsdc: link.amountUsdc,
              txHash: r.txHash,
              explorerUrl: r.explorerUrl,
            };
            deps.state.addReclaim(entry);
            summary.reclaimed.push(entry);
            log.info("reclaimed an expired link", { assignmentId: rec.assignmentId, label: link.label, amountUsdc: link.amountUsdc, tx: r.txHash });
            break;
          }
          case "Claimed":
            link.status = status.drop.label;
            link.claimedTo = status.drop.claimedTo;
            summary.claimed++;
            break;
          case "Reclaimed":
            link.status = "Reclaimed";
            break;
          case "NotFound":
            link.status = "NotFound";
            link.note = "the contract has no drop for this key";
            break;
          case "Open":
            // the chain's clock disagrees with ours by a little; next pass
            if (status.drop.expiresAt) link.expiresAt = status.drop.expiresAt;
            summary.open++;
            break;
          default:
            summary.skipped++;
        }
      } catch (e) {
        const msg = `${rec.assignmentId} ${link.publicKey}: ${errorText(e)}`;
        summary.errors.push(msg);
        log.warn("reclaim check failed", { assignmentId: rec.assignmentId, publicKey: link.publicKey, error: errorText(e) });
      }
    }
    if (dirty) deps.state.put(rec, nowIso);
  }
  return summary;
}

async function adoptLandedLinks(rec: AssignmentRecord, rail: PayoutRail, nowIso: string, summary: ReclaimSummary): Promise<number> {
  const known = new Set(rec.links.map((l) => l.publicKey));
  let adopted = 0;
  for (const r of rail.receiptsByReference(rec.reference)) {
    if (known.has(r.publicKey)) continue;
    try {
      const status = await rail.linkStatus(r.publicKey);
      if (status.drop.kind === "NotFound") continue;
      const link: LinkRecord = {
        index: rec.links.length + 1,
        label: r.label ?? "",
        amountUsdc: r.amountUsdc,
        memo: r.memo,
        publicKey: r.publicKey,
        link: r.link ?? "",
        txHash: r.txHash,
        explorerUrl: r.explorerUrl,
        expiresAt: status.drop.expiresAt ?? r.expiresAt,
        status: status.drop.label,
        claimedTo: status.drop.claimedTo,
        reclaimTxHash: null,
        lastCheckedAt: nowIso,
        note: "landed on chain although the deposit was reported as failed; the buyer was refunded",
      };
      rec.links.push(link);
      rec.notes.push(`${nowIso}: adopted ${r.publicKey} (${r.amountUsdc} USDC) found on chain after the decline`);
      adopted++;
    } catch (e) {
      summary.errors.push(`${rec.assignmentId} ${r.publicKey}: ${errorText(e)}`);
    }
  }
  return adopted;
}
