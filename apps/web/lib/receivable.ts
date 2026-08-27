/**
 * Can this account actually be paid?
 * ============================================================================
 *
 * THE BUG THIS EXISTS BECAUSE OF. An address is copyable from the account menu, which is on every
 * screen. Opening the account on chain — the sponsored 0-XLM account plus its USDC trustline — was
 * mounted on exactly two screens, /account and /add-money. So somebody could open an account, copy
 * their address from the nav, paste it into an outside wallet, and be told "the destination account
 * doesn't exist" — because it did not. The wallet then flagged the payment as suspicious, which is
 * the correct thing for a wallet to do about a payment to an account that is not there.
 *
 * The address is offered everywhere, so the account has to be openable everywhere. That is all this
 * module is.
 *
 * ONE OPENER FOR THE WHOLE APP. The shell calls this on every screen and the card on /account calls
 * it too, so without a shared guard two callers could each decide the account needs opening and
 * each spend the sponsor a reserve that never comes back. A module-scoped promise makes the second
 * caller wait for the first, and a completed address is remembered so a navigation does not re-ask
 * Horizon on every screen.
 */
import { activeNetwork, USDC_ISSUER } from "./network";
import { prepareAccount } from "./sponsor";
import type { Signer } from "./signer";

/** ready = it can hold dollars · locked = only the password is in the way · error = say so. */
export type Receivable =
  | { state: "ready" }
  /** The key is needed and not available. `reason` is getSigner's own words — a Phase-1 account on
   *  mainnet is told to SET a password, a Phase-2 one to unlock, and those are different errands. */
  | { state: "locked"; reason: string }
  | { state: "error"; error: string };

let inFlight: Promise<Receivable> | null = null;
const settled = new Set<string>();

export async function ensureCanReceive(
  address: string,
  getSigner: () => Promise<Signer>,
): Promise<Receivable> {
  const net = activeNetwork();
  const memo = `${net.id}:${address}`;
  if (settled.has(memo)) return { state: "ready" };
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<Receivable> => {
    const issuer = USDC_ISSUER[net.id];
    let needsOpening: boolean;
    try {
      const res = await fetch(`${net.horizonUrl}/accounts/${address}`);
      if (res.status === 404) {
        needsOpening = true; // no account on this chain at all
      } else if (!res.ok) {
        return { state: "error", error: "We couldn't check your account just now." };
      } else {
        const acc = (await res.json()) as { balances?: { asset_code?: string; asset_issuer?: string }[] };
        needsOpening = !(acc.balances ?? []).some(
          (b) => b.asset_code === "USDC" && b.asset_issuer === issuer,
        );
      }
    } catch {
      return { state: "error", error: "We couldn't reach the network just now." };
    }

    if (!needsOpening) {
      settled.add(memo);
      return { state: "ready" };
    }

    // A trustline is sourced by the account itself, so this cannot be done without its key.
    let signer: Signer;
    try {
      signer = await getSigner();
    } catch (e) {
      return { state: "locked", reason: (e as Error).message };
    }

    try {
      await prepareAccount({ sponsorUrl: net.sponsorUrl, signer });
      settled.add(memo);
      return { state: "ready" };
    } catch (e) {
      return { state: "error", error: (e as Error).message };
    }
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
