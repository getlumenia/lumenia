/**
 * Open this account on real money: the sponsor builds a sponsored "create the account and add the
 * dollar line" transaction (no XLM needed), the website's own guard checks its shape
 * (prepareAccount -> assertSponsoredOnboarding / assertSponsoredTrustline) and the account's key
 * signs it. Without it an approved account that never received real money has nowhere for dollars
 * to arrive, and a send reads "account not found".
 *
 * The same gates as the switch to real money come first, in this order, and every one that needs no
 * network is checked before anything is asked of anyone: the agreement, an account with a password
 * lock, its backup, an unlocked key, then a fresh pilot answer (approved, approved with no sends
 * left, or real money open to everyone), then a real-money balance read that shows the account is
 * missing there or cannot hold dollars yet. Every step is injected, so the self-test drives it
 * without a network (test/router.selftest.ts).
 */
import type { NetworkConfig, Signer } from "../core";
import { ExtError, fail } from "../lib/errors";
import { pilotStanding, standingError } from "../lib/standing";
import type { BalanceInfo, PilotInfo } from "../lib/types";

export interface OpenRealDeps {
  /** the first-run agreement (null: not agreed) */
  consentAt(): Promise<number | null>;
  account(): Promise<{ pubkey: string; phase: 1 | 2 } | null>;
  /** the account may exist only in this browser (BackupView.needed) */
  backupNeeded(): Promise<boolean>;
  /** refuses as `locked` unless the session is unlocked for this account */
  signer(pubkey: string): Promise<Signer>;
  /** a FRESH answer from the real-money server (forced ask) */
  pilot(pubkey: string): Promise<PilotInfo>;
  balance(pubkey: string, net: NetworkConfig): Promise<BalanceInfo>;
  /** open the account (sponsored) and/or add its dollar line */
  prepare(signer: Signer, net: NetworkConfig): Promise<void>;
  /** the real-money network */
  net: NetworkConfig;
}

const plain = (e: unknown, fallback: string): string => {
  const m = e instanceof Error ? e.message.trim() : "";
  return /^[A-Z][^{}<>]{6,200}[.!?]$/.test(m) ? m : fallback;
};

export async function runOpenReal(deps: OpenRealDeps): Promise<BalanceInfo> {
  const { net } = deps;
  if (!net.isMainnet) throw new ExtError("internal", "This opens an account on real money only.");
  if (!(await deps.consentAt())) throw fail("needs-consent");
  const acct = await deps.account();
  if (!acct) throw fail("no-account");
  if (acct.phase !== 2) throw fail("needs-password");
  if (await deps.backupNeeded()) throw fail("needs-backup");
  const signer = await deps.signer(acct.pubkey); // locked: refused here, before anything is asked of anyone

  // Opened only while it may use real money: approved (with or without sends left: with none, money
  // can still arrive and links can still be taken back) or real money open to everyone.
  const p = await deps.pilot(acct.pubkey);
  const refused = standingError(pilotStanding(p), "switch", { pubkey: acct.pubkey, used: p.used, limit: p.limit });
  if (refused) throw refused;

  // Only an account that is not on real money yet, or is there without the dollar line, is opened.
  const before = await deps.balance(acct.pubkey, net);
  if (!before.missing) {
    if (before.line === true) throw new ExtError("internal", "This account is already open on real money.");
    if (before.line === undefined) throw new ExtError("internal", "We couldn't check this account on real money just now. Try again.");
  }
  try {
    await deps.prepare(signer, net);
  } catch (e) {
    throw new ExtError("sponsor-refused", plain(e, "We couldn't open your account on real money just now. Your money hasn't moved. Try again in a moment."));
  }
  return deps.balance(acct.pubkey, net);
}
