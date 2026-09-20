/**
 * The last lira rail run completed on THIS device, kept in localStorage per network.
 *
 * Why on the device: the anchor lists a person's transfers only to that person's own SEP-10
 * session, and this product keeps no server-side record of anyone's bank activity. The event board
 * (/event) reads it back to show the rail's latest round trip with its hashes; on any other device
 * the tile honestly says there is no run on record here.
 */
import { activeNetwork, type NetworkId } from "./network";

export interface RailRun {
  at: string;
  rail: string;
  amountIn: string | null;
  amountOut: string | null;
  amountFee: string | null;
  /** The Stellar payment hash. */
  tx: string | null;
  seconds: number;
}

/** Same `<base>.<network>` convention as lib/scoped-store.ts netKey, with the network nameable. */
export const RAIL_LAST_DEPOSIT_KEY = (net: NetworkId = activeNetwork().id) => `lumenia.rail.lastDeposit.${net}`;
export const RAIL_LAST_WITHDRAW_KEY = (net: NetworkId = activeNetwork().id) => `lumenia.rail.lastWithdraw.${net}`;

export function saveRailRun(key: string, run: RailRun): void {
  try {
    localStorage.setItem(key, JSON.stringify(run));
  } catch {
    /* storage blocked: the board just shows less */
  }
}

export function readRailRun(key: string): RailRun | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null") as RailRun | null;
    return v && typeof v.at === "string" ? v : null;
  } catch {
    return null;
  }
}
