// Drop records as the LumenDrop NEAR contract returns them, and the ft_transfer_call message that
// creates one. Keep this in sync with the contract (external/lumenia-near/contract/src/lib.rs).

export type DropStatus = "Open" | "Claiming" | "Claimed" | "Reclaimed";

export interface DropView {
  public_key?: string;
  status: DropStatus;
  /** u128 string, 6 decimals */
  amount: string;
  funder: string;
  created_at_ns: string | number;
  expires_at_ns: string | number;
  claimed_to: string | null;
  memo: string | null;
  /** block time of the last status change; a Claiming drop older than STUCK_CLAIM_MS may be reclaimed */
  status_changed_at_ns?: string | number;
}

export interface ConfigView {
  owner_id: string;
  token_id: string;
  root_account_id: string;
  paused: boolean;
  key_allowance: string;
  registration_deposit: string;
  max_expiry_s: number;
  /** yoctoNEAR sent along to a NEW account at claim time (0 for an existing named account) */
  starter_yocto?: string;
  /** smallest drop in 6-dp units (0.10 USDC on testnet) */
  min_amount?: string;
}

export interface StatsView {
  drops_created: number;
  drops_claimed: number;
  drops_reclaimed: number;
  open_drops: number;
  pool_balance: string;
  /** 6-dp unit strings */
  total_amount_created?: string;
  total_amount_claimed?: string;
  total_amount_reclaimed?: string;
}

/** The contract treats a claim that has been Claiming this long as stuck. */
export const STUCK_CLAIM_MS = 10 * 60 * 1000;
/** Memo limit enforced by the contract, in UTF-8 bytes. */
export const MAX_MEMO_BYTES = 256;

export function isConfigView(v: unknown): v is ConfigView {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.root_account_id === "string" && typeof c.paused === "boolean" && typeof c.max_expiry_s === "number";
}

export const DROP_STATUSES: ReadonlySet<string> = new Set(["Open", "Claiming", "Claimed", "Reclaimed"]);

export function isDropView(v: unknown): v is DropView {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return typeof d.status === "string" && DROP_STATUSES.has(d.status) && typeof d.amount === "string";
}

export function isStatsView(v: unknown): v is StatsView {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.drops_created === "number" && typeof s.drops_claimed === "number" && typeof s.drops_reclaimed === "number";
}

/** The `msg` of ft_transfer_call. `memo` is sent only when non-empty. */
export function buildDropMsg(publicKey: string, expiresInS: number, memo?: string): string {
  const body: { public_key: string; expires_in_s: number; memo?: string } = {
    public_key: publicKey,
    expires_in_s: expiresInS,
  };
  const m = memo?.trim();
  if (m) body.memo = m;
  return JSON.stringify(body);
}

export function isTerminal(status: DropStatus): boolean {
  return status === "Claimed" || status === "Reclaimed";
}

const NS_PER_MS = 1_000_000n;

/**
 * Whether the funder may call reclaim now: the drop has expired and is Open, or has been stuck in
 * Claiming for at least STUCK_CLAIM_MS.
 */
export function reclaimable(d: DropView, nowMs: number): boolean {
  const expiresAt = Number(BigInt(d.expires_at_ns) / NS_PER_MS);
  if (nowMs < expiresAt) return false;
  if (d.status === "Open") return true;
  if (d.status === "Claiming" && d.status_changed_at_ns !== undefined) {
    const changedAt = Number(BigInt(d.status_changed_at_ns) / NS_PER_MS);
    return nowMs >= changedAt + STUCK_CLAIM_MS;
  }
  return false;
}

export function memoBytes(memo: string): number {
  return new TextEncoder().encode(memo).length;
}
