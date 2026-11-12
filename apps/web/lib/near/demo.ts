// The shared practice balance's gate and limits. The deployment names the practice account (only to
// read its balance) and the sponsor's NEAR mount makes the links: no key of the practice balance is
// ever part of this app, so nothing here can sign for it.
import { isValidAccountId } from "./account-id";

/** Per-link cap for the shared practice balance, so it lasts through judging (1.00 USDC); the Worker holds the same line. */
export const DEMO_MAX_LINK_UNITS = "1000000";
/** The smallest practice link (0.10 USDC), the escrow's own minimum. */
export const DEMO_MIN_LINK_UNITS = "100000";
export const DEMO_DEFAULT_AMOUNT = "1.00";
/** Practice links keep their memo short (bytes, UTF-8); the Worker refuses a longer one. */
export const DEMO_MAX_MEMO_BYTES = 64;
/** A practice link lives an hour by default and a day at most (the Worker refuses longer), and the sponsor takes an
 *  expired one back to the practice balance on its own, so unclaimed practice dollars never sit locked for a week. */
export const DEMO_DEFAULT_EXPIRY_S = 3_600;
export const DEMO_MAX_EXPIRY_S = 86_400;

/** Offered when the practice account is named and there is a relayer to make its links. */
export function practiceAvailable(accountId: string | undefined, relayerUrl: string | undefined): boolean {
  const id = (accountId ?? "").trim();
  const base = (relayerUrl ?? "").trim();
  return isValidAccountId(id) && /^https?:\/\/[^\s/]+/.test(base);
}

/** The amount defaults and the per-link cap for a sender: demo mode is tighter, the testnet cap stays for everyone else. */
export function linkLimits(demo: boolean, testnetMaxUnits: string): { maxUnits: string; defaultAmount: string } {
  return demo ? { maxUnits: DEMO_MAX_LINK_UNITS, defaultAmount: DEMO_DEFAULT_AMOUNT } : { maxUnits: testnetMaxUnits, defaultAmount: "1" };
}
