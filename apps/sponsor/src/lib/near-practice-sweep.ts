/**
 * The Worker's sweep of expired links (NEAR HACKATHON 2026, testnet): its own scheduled run sends
 * every expired, unclaimed link on the escrow back to the account that funded it.
 *
 * WHY. Most links come home by themselves: whoever makes a link can arm its return timer
 * (`arm_return`, NEP-519 yield/resume), and the practice route arms every practice link it makes
 * (lib/near-practice.ts). A timer lives as long as the gas it was armed with (a few hours), and a link
 * can be made without one (another client, a link that outlives its timer). This job is the backstop:
 * without it such a link keeps its dollars locked until its funder thinks of `reclaim`, and the
 * shared practice balance runs dry while people try the demo.
 *
 * WHAT IT CAN DO, and nothing else: call the escrow's `return_expired(public_keys)` from the relayer
 * account. The escrow lets anyone make that call because it can only ever pay a link's FUNDER, and it
 * refuses a link that has not expired, is claimed, returned, or mid-claim. So this job can move money
 * nowhere but home.
 *
 * WHAT IT DOES, per run: read the escrow's ledger (`get_drops`, all funders, pages of SWEEP_PAGE),
 * pick the links that are "Open" and past their expiry, group them by funder (oldest expiry first,
 * at most SWEEP_MAX_KEYS per call, the escrow's limit), and send one `return_expired` per group, at
 * most `max` transactions per run, each waited on until FINAL and logged as one JSON line. A link that
 * is "Claiming" is NEVER picked: from a view one cannot tell whether that claim's transfer already
 * happened (only the funder's own `reclaim` may end a stuck claim). The first failure stops the run;
 * the next run tries again.
 *
 * WHEN. Its own cron (PRACTICE_SWEEP_CRON in wrangler.toml, testnet only), so its subrequests never
 * share an invocation's budget with the watchdog. Skipped when the sponsor is halted.
 */
import { actions, teraToGas } from "near-api-js";
import { messageOf, signAndSendActions, type NearSendDeps } from "./near-relay.js";

/** The sweep's cron: minutes 7, 22, 37 and 52, between the watchdog's quarter hours. Testnet Worker only. */
export const PRACTICE_SWEEP_CRON = "7,22,37,52 * * * *";
/** Links per `return_expired` call: the escrow's limit (MAX_RETURN_DROPS). */
export const SWEEP_MAX_KEYS = 30;
/** Transactions per run: three stay far inside a Free-plan invocation's 50 subrequests. */
export const SWEEP_MAX_PER_RUN = 3;

/**
 * Gas for a `return_expired` of `n` links: the escrow asks for 40 Tgas plus 2 per link (its own work,
 * the transfer and the callback); 20 more is margin, and what is not used is refunded.
 */
export function sweepReturnTgas(n: number): number {
  return 60 + 2 * n;
}
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
  /** Expired and Open: what the job may send home. */
  expired: number;
  /** Expired links that are Claiming: left alone on purpose. */
  skippedClaiming: number;
  /** Links sent home this run, with the transaction that carried each group. */
  returned: { publicKey: string; funder: string; amountUnits: string; txHash: string }[];
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

/** Expired Open links, oldest expiry first. Pure: the unit of the suite. */
export function expiredOpenDrops(drops: SweepDrop[], nowMs: number): SweepDrop[] {
  const nowNs = BigInt(Math.floor(nowMs)) * 1_000_000n;
  return drops
    .filter((d) => d.status === "Open" && BigInt(d.expires_at_ns) <= nowNs)
    .sort((a, b) => (BigInt(a.expires_at_ns) < BigInt(b.expires_at_ns) ? -1 : BigInt(a.expires_at_ns) > BigInt(b.expires_at_ns) ? 1 : 0));
}

/**
 * The calls one run would send: the due links grouped by funder, at most SWEEP_MAX_KEYS a call, in the
 * order of each group's oldest expiry. Pure.
 */
export function returnGroups(due: SweepDrop[]): SweepDrop[][] {
  const byFunder = new Map<string, SweepDrop[]>();
  for (const d of due) {
    const list = byFunder.get(d.funder) ?? [];
    list.push(d);
    byFunder.set(d.funder, list);
  }
  const groups: SweepDrop[][] = [];
  for (const list of byFunder.values()) {
    for (let i = 0; i < list.length; i += SWEEP_MAX_KEYS) groups.push(list.slice(i, i + SWEEP_MAX_KEYS));
  }
  return groups;
}

/** Expired links that are mid-claim: counted, never touched. */
function expiredClaiming(drops: SweepDrop[], nowMs: number): number {
  const nowNs = BigInt(Math.floor(nowMs)) * 1_000_000n;
  return drops.filter((d) => d.status === "Claiming" && BigInt(d.expires_at_ns) <= nowNs).length;
}

/** True when the transaction and every receipt in it ended without a Failure. */
export function outcomeSucceeded(response: unknown): boolean {
  const r = response as { status?: unknown; receipts_outcome?: { outcome?: { status?: unknown } }[] } | null;
  const failed = (s: unknown) => !!s && typeof s === "object" && "Failure" in (s as Record<string, unknown>);
  if (!r || failed(r.status)) return false;
  return !(r.receipts_outcome ?? []).some((o) => failed(o?.outcome?.status));
}

/** One run of the sweep. Never throws: a failure is reported in the result and the log. */
export async function sweepExpiredLinks(
  deps: SweepDeps,
  opts: { now?: () => number; max?: number; log?: (line: string) => void } = {},
): Promise<SweepResult> {
  const now = opts.now ?? Date.now;
  const max = opts.max ?? SWEEP_MAX_PER_RUN;
  const log = opts.log ?? ((line: string) => console.log(line));
  const { config, rpc } = deps;
  const result: SweepResult = { checked: 0, expired: 0, skippedClaiming: 0, returned: [] };
  const line = (fields: Record<string, unknown>) => log(JSON.stringify({ at: new Date(now()).toISOString(), job: "near/sweep", ...fields }));

  if (!rpc.viewFunction) {
    result.error = "the RPC offers no contract views";
    line({ decision: "skipped", reason: result.error });
    return result;
  }

  const drops: SweepDrop[] = [];
  try {
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const rows = await rpc.viewFunction(config.escrowId, "get_drops", { from_index: page * SWEEP_PAGE, limit: SWEEP_PAGE });
      if (!Array.isArray(rows)) throw new Error("get_drops answered no list");
      drops.push(...rows.filter(isSweepDrop));
      if (rows.length < SWEEP_PAGE) break;
    }
  } catch (e) {
    result.error = `the ledger could not be read: ${messageOf(e)}`;
    line({ decision: "stopped", reason: result.error });
    return result;
  }
  result.checked = drops.length;
  const due = expiredOpenDrops(drops, now());
  result.expired = due.length;
  result.skippedClaiming = expiredClaiming(drops, now());

  for (const group of returnGroups(due).slice(0, Math.max(0, max))) {
    const keys = group.map((d) => d.public_key);
    const action = actions.functionCall("return_expired", { public_keys: keys }, teraToGas(sweepReturnTgas(keys.length)), 0n);
    try {
      const { txHash, response } = await signAndSendActions(deps, config.escrowId, [action]);
      if (!outcomeSucceeded(response)) {
        result.error = `the return of ${keys.length} link(s) of ${group[0]!.funder} ended in a failure (tx ${txHash})`;
        line({ decision: "failed", funder: group[0]!.funder, links: keys.length, txHash });
        break;
      }
      for (const d of group) result.returned.push({ publicKey: d.public_key, funder: d.funder, amountUnits: d.amount, txHash });
      line({ decision: "returned", funder: group[0]!.funder, links: keys.length, txHash });
    } catch (e) {
      result.error = `the return of ${keys.length} link(s) of ${group[0]!.funder} could not be sent: ${messageOf(e)}`;
      line({ decision: "failed", funder: group[0]!.funder, links: keys.length, reason: messageOf(e) });
      break;
    }
  }
  line({ decision: "done", checked: result.checked, expired: result.expired, returned: result.returned.length, skippedClaiming: result.skippedClaiming });
  return result;
}
