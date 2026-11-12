/**
 * The practice balance's sweep (NEAR HACKATHON 2026, testnet): the Worker's own scheduled run takes
 * expired, unclaimed practice links back to the shared practice balance.
 *
 * WHY. A practice link is funded by the relayer account (lib/near-practice.ts), so only that
 * account's key can call the escrow's `reclaim`. Without this job an unclaimed practice link keeps
 * its dollars locked in the escrow, and the shared balance runs dry while people try the demo.
 *
 * WHAT IT CAN DO, and nothing else: call `reclaim(public_key)` on the escrow from the relayer
 * account. The escrow itself refuses a reclaim before the link's expiry and from anyone but the
 * link's funder, so this job can only ever move practice dollars back to the practice balance.
 *
 * WHAT IT DOES, per run: read the relayer's links from the escrow (`get_drops_by_funder`, pages of
 * SWEEP_PAGE), then send `reclaim` for at most `max` of them whose status is "Open" and whose expiry
 * has passed, oldest first, one transaction each (SWEEP_RECLAIM_TGAS, no deposit), waited on until
 * FINAL and logged as one JSON line. A link that is "Claiming" is NEVER touched, although the escrow
 * would accept a reclaim of a claim stuck for ten minutes: from a view one cannot tell whether that
 * claim's transfer already happened, and a second payout would come out of the shared pool. The
 * first failure stops the run; the next run tries again.
 *
 * WHEN. Its own cron (PRACTICE_SWEEP_CRON in wrangler.toml, testnet only), so its subrequests never
 * share an invocation's budget with the watchdog. Skipped when the sponsor is halted.
 */
import { actions, teraToGas } from "near-api-js";
import { messageOf, signAndSendActions, type NearSendDeps } from "./near-relay.js";

/** The sweep's cron: minutes 7, 22, 37 and 52, between the watchdog's quarter hours. Testnet Worker only. */
export const PRACTICE_SWEEP_CRON = "7,22,37,52 * * * *";
/** Gas for one reclaim; the escrow asks for at least 30 Tgas. */
export const SWEEP_RECLAIM_TGAS = 50;
/** Reclaims per run: three transactions stay far inside a Free-plan invocation's 50 subrequests. */
export const SWEEP_MAX_PER_RUN = 3;
/** One ledger page; the escrow returns at most 100. */
export const SWEEP_PAGE = 100;
/** Pages read per run at most (1,000 links): a bound on views, whatever the ledger holds. */
export const SWEEP_MAX_PAGES = 10;

/** The fields of the escrow's DropView this job reads. */
export interface SweepDrop {
  public_key: string;
  status: string;
  funder: string;
  amount: string;
  expires_at_ns: string;
}

export interface SweepResult {
  /** Links read from the ledger. */
  checked: number;
  /** Expired, Open and funded by the practice balance: what the job may take back. */
  expired: number;
  /** Expired links that are Claiming: left alone on purpose. */
  skippedClaiming: number;
  reclaimed: { publicKey: string; amountUnits: string; txHash: string }[];
  /** Why the run stopped early, when it did. */
  error?: string;
}

/** The view this job needs; the live RPC (lib/near-relay.ts jsonRpcNearRpc) provides it. */
type SweepDeps = NearSendDeps & { rpc: NearSendDeps["rpc"] & { viewFunction?(contractId: string, method: string, args: Record<string, unknown>): Promise<unknown> } };

function isSweepDrop(d: unknown): d is SweepDrop {
  if (!d || typeof d !== "object") return false;
  const r = d as Record<string, unknown>;
  return typeof r.public_key === "string" && typeof r.status === "string" && typeof r.funder === "string" && typeof r.amount === "string" && typeof r.expires_at_ns === "string" && /^\d+$/.test(r.expires_at_ns);
}

/** Expired Open links funded by `funderId`, oldest expiry first. Pure: the unit of the suite. */
export function expiredOpenDrops(drops: SweepDrop[], funderId: string, nowMs: number): SweepDrop[] {
  const nowNs = BigInt(Math.floor(nowMs)) * 1_000_000n;
  return drops
    .filter((d) => d.funder === funderId && d.status === "Open" && BigInt(d.expires_at_ns) <= nowNs)
    .sort((a, b) => (BigInt(a.expires_at_ns) < BigInt(b.expires_at_ns) ? -1 : BigInt(a.expires_at_ns) > BigInt(b.expires_at_ns) ? 1 : 0));
}

/** Expired links that are mid-claim: counted, never reclaimed. */
function expiredClaiming(drops: SweepDrop[], funderId: string, nowMs: number): number {
  const nowNs = BigInt(Math.floor(nowMs)) * 1_000_000n;
  return drops.filter((d) => d.funder === funderId && d.status === "Claiming" && BigInt(d.expires_at_ns) <= nowNs).length;
}

/** True when the transaction and every receipt in it ended without a Failure. */
export function outcomeSucceeded(response: unknown): boolean {
  const r = response as { status?: unknown; receipts_outcome?: { outcome?: { status?: unknown } }[] } | null;
  const failed = (s: unknown) => !!s && typeof s === "object" && "Failure" in (s as Record<string, unknown>);
  if (!r || failed(r.status)) return false;
  return !(r.receipts_outcome ?? []).some((o) => failed(o?.outcome?.status));
}

/** One run of the sweep. Never throws: a failure is reported in the result and the log. */
export async function sweepExpiredPracticeLinks(
  deps: SweepDeps,
  opts: { now?: () => number; max?: number; log?: (line: string) => void } = {},
): Promise<SweepResult> {
  const now = opts.now ?? Date.now;
  const max = opts.max ?? SWEEP_MAX_PER_RUN;
  const log = opts.log ?? ((line: string) => console.log(line));
  const { config, rpc } = deps;
  const funder = config.relayerAccountId;
  const result: SweepResult = { checked: 0, expired: 0, skippedClaiming: 0, reclaimed: [] };
  const line = (fields: Record<string, unknown>) => log(JSON.stringify({ at: new Date(now()).toISOString(), job: "near/practice-sweep", ...fields }));

  if (!rpc.viewFunction) {
    result.error = "the RPC offers no contract views";
    line({ decision: "skipped", reason: result.error });
    return result;
  }

  const drops: SweepDrop[] = [];
  try {
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const rows = await rpc.viewFunction(config.escrowId, "get_drops_by_funder", { funder, from_index: page * SWEEP_PAGE, limit: SWEEP_PAGE });
      if (!Array.isArray(rows)) throw new Error("get_drops_by_funder answered no list");
      drops.push(...rows.filter(isSweepDrop));
      if (rows.length < SWEEP_PAGE) break;
    }
  } catch (e) {
    result.error = `the ledger could not be read: ${messageOf(e)}`;
    line({ decision: "stopped", reason: result.error });
    return result;
  }
  result.checked = drops.length;
  const due = expiredOpenDrops(drops, funder, now());
  result.expired = due.length;
  result.skippedClaiming = expiredClaiming(drops, funder, now());

  for (const d of due.slice(0, Math.max(0, max))) {
    const action = actions.functionCall("reclaim", { public_key: d.public_key }, teraToGas(SWEEP_RECLAIM_TGAS), 0n);
    try {
      const { txHash, response } = await signAndSendActions(deps, config.escrowId, [action]);
      if (!outcomeSucceeded(response)) {
        result.error = `the reclaim of ${d.public_key} ended in a failure (tx ${txHash})`;
        line({ decision: "failed", publicKey: d.public_key, txHash });
        break;
      }
      result.reclaimed.push({ publicKey: d.public_key, amountUnits: d.amount, txHash });
      line({ decision: "reclaimed", publicKey: d.public_key, amount: d.amount, txHash });
    } catch (e) {
      result.error = `the reclaim of ${d.public_key} could not be sent: ${messageOf(e)}`;
      line({ decision: "failed", publicKey: d.public_key, reason: messageOf(e) });
      break;
    }
  }
  line({ decision: "done", checked: result.checked, expired: result.expired, reclaimed: result.reclaimed.length, skippedClaiming: result.skippedClaiming });
  return result;
}
