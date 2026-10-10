/**
 * What the owner CLI prints for `pilot list`, `pilot waitlist` and `pilot status` (cli/pilot.ts),
 * as pure functions so test-pilot.ts can pin the lines without running the CLI.
 *
 * Owner terminal only. The waitlist lines are email addresses, and nothing here is ever served.
 */
import { type PilotListRow, type PilotSource, type PilotState } from "./pilot.js";

/** A list filter: a state, "revoked" (declined by a revoke), or everything. */
export type PilotListFilter = PilotState | "revoked" | "all";

/** The label a row is shown with: "revoked" for a revoked wallet, its state otherwise. */
function rowLabel(r: PilotListRow): string {
  return r.state === "rejected" && r.revoked ? "revoked" : r.state;
}

/**
 * Counts per state over EVERY wallet on this network (a declined wallet, "rejected", and a revoked
 * one counted apart, under the same names the filter takes), then the wallets the filter keeps, one
 * line each with the contact flag and where it last asked from.
 */
export function pilotListLines(all: PilotListRow[], want: PilotListFilter, net: string): string[] {
  const counts = { pending: 0, approved: 0, rejected: 0, revoked: 0, none: 0 };
  for (const r of all) counts[rowLabel(r) as keyof typeof counts]++;
  const kept = all.filter((r) => want === "all" || (want === "revoked" ? rowLabel(r) === "revoked" : rowLabel(r) === want));
  return [
    `${net} pilot: ${all.length} wallet(s): pending ${counts.pending}, approved ${counts.approved}, rejected ${counts.rejected}, revoked ${counts.revoked}, none ${counts.none}`,
    `${kept.length} wallet(s) with state "${want}"`,
    ...kept.map((r) => `  ${r.pubkey}  ${rowLabel(r).padEnd(8)}  email:${r.hasEmail ? "yes" : "no "}  src:${r.src ?? "-"}`),
  ];
}

/** The people who asked for real money with no account yet (the "pilot" notify-me list). */
export function waitlistLines(emails: string[]): string[] {
  return [
    `waitlist: ${emails.length} address(es) asked for real money before they had an account (no wallet to approve; answer them by hand)`,
    ...emails.map((e) => `  ${e}`),
  ];
}

/** `pilot status`: one wallet's whole reading. */
export function pilotStatusLines(
  net: string,
  pubkey: string,
  s: { state: PilotState; approved: boolean; used: number; limit: number; revoked: boolean },
  src: PilotSource | null,
): string[] {
  return [
    `${net} pilot: ${pubkey}`,
    `  state:    ${s.state}`,
    `  approved: ${s.approved}`,
    `  revoked:  ${s.revoked}`,
    `  used:     ${s.used} / ${s.limit}`,
    `  src:      ${src ?? "-"}`,
  ];
}
