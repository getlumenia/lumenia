/**
 * Off-ramp exit adapters (Tyler conditions #3 + #4).
 *
 * OUTSIDE the trust boundary. Off-ramp is the user's own edge choice; every
 * value move here is signed by the RECIPIENT's own key (never the sponsor KMS).
 * Each path is an independent, removable adapter behind one interface — if a
 * card/exchange policy changes, the core claim flow is unaffected.
 *
 * v1 user-facing cash-out = the card adapter ("spend", fits the hold-dollars
 * thesis, sidesteps the 72h bank-withdrawal hold). The CCTP adapter is the
 * partner-independent fallback proven (Stellar-side) by Spike #4.
 *
 * NOTE (Elliot): the CCTP amount decimal scale (USDC 6 vs Stellar SAC 7) is
 * UNVERIFIED until a funded burn — confirm before any real value moves.
 */

export type OffRampKind = "card" | "exchange" | "cctp-bridge";

/** Status surfaced to the UI as plain "spend / send to bank" — never crypto terms. */
export type OffRampStatus = "idle" | "pending" | "attestation" | "settling" | "done" | "failed";

export interface OffRampQuote {
  kind: OffRampKind;
  /** What the user sees: dollars in, lira out (indicative). */
  usdIn: string;
  tryOut: string;
  etaSeconds: number;
  /** True if this path avoids the MASAK 72h first-withdrawal hold (card spend does). */
  avoidsBankHold: boolean;
}

export interface OffRampAdapter {
  readonly kind: OffRampKind;
  quote(usdAmount: string): Promise<OffRampQuote>;
  /** Recipient-signed; pluggable. CCTP returns through pending→attestation→settling→done. */
  start(usdAmount: string, onStatus: (s: OffRampStatus) => void): Promise<void>;
}

/** Registry so the UI offers whatever adapters are enabled; none selected → user just holds dollars. */
export const offRampAdapters: Partial<Record<OffRampKind, OffRampAdapter>> = {
  // card: createKastAdapter(),       // v1 user-facing (stub)
  // "cctp-bridge": createCctpAdapter(), // fallback, Stellar-side proven in Spike #4 (stub)
};
