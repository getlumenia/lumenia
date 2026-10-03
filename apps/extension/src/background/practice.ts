/**
 * Practice dollars for the account held here (testnet only).
 *
 * A brand-new account is not on the ledger yet, and the faucet pays only an account that can already
 * hold these dollars (apps/sponsor/src/lib/faucet.ts). So the account is opened first, the same way
 * the website opens one: the sponsor builds a sponsored "create the account and add the dollar line"
 * transaction (no XLM needed), the extension checks its shape with the website's own guard
 * (prepareAccount -> assertSponsoredOnboarding / assertSponsoredTrustline) and signs it. Then the
 * faucet pays. Each step is injected so the self-test drives it without a network.
 */
import type { NetworkConfig, Signer } from "../core";
import { ExtError } from "../lib/errors";
import type { BalanceInfo } from "../lib/types";

export interface PracticeDeps {
  balance(pubkey: string, net: NetworkConfig): Promise<BalanceInfo>;
  signer(pubkey: string): Promise<Signer>;
  /** open the account (sponsored) and/or add its dollar line */
  prepare(signer: Signer, net: NetworkConfig): Promise<void>;
  faucet(sponsorUrl: string, pubkey: string): Promise<void>;
}

const plain = (e: unknown, fallback: string): string => {
  const m = e instanceof Error ? e.message.trim() : "";
  return /^[A-Z][^{}<>]{6,200}[.!?]$/.test(m) ? m : fallback;
};

export async function addPracticeDollars(deps: PracticeDeps, pubkey: string, net: NetworkConfig): Promise<BalanceInfo> {
  if (net.isMainnet) throw new ExtError("internal", "Practice dollars are for practice money only.");
  const before = await deps.balance(pubkey, net);
  if (before.missing || before.line === false) {
    const signer = await deps.signer(pubkey); // locked: refused here, before anything is asked of the sponsor
    try {
      await deps.prepare(signer, net);
    } catch (e) {
      throw new ExtError("sponsor-refused", plain(e, "We couldn't open your practice account just now. Try again in a moment."));
    }
  }
  try {
    await deps.faucet(net.sponsorUrl, pubkey);
  } catch (e) {
    throw new ExtError("sponsor-refused", plain(e, "Couldn't get practice dollars right now. Try again in a moment."));
  }
  return deps.balance(pubkey, net);
}
