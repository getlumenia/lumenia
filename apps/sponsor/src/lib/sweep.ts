/**
 * /sweep — consolidate an incoming per-link account into the user's ONE home
 * account (see docs/RECOVERY_ARCHITECTURE.md; proven on-chain by Spike #7).
 *
 * The CLIENT (the per-link throwaway account) builds + signs ONE inner tx it
 * sources itself. Two accepted shapes (the throwaway holds 0 XLM throughout):
 *   3-op (already-claimed — the PRODUCTION shape, since the frozen /c/[id] route
 *         claims the CB at claim time, leaving plain USDC):
 *     payment(USDC → home) → changeTrust(USDC, 0) → accountMerge(→ home)
 *   4-op (an unclaimed CB still sits on the throwaway):
 *     claimClaimableBalance(CB) → payment(→ home) → changeTrust(0) → accountMerge(→ home)
 * The sponsor:
 *   1. re-parses the XDR,
 *   2. runs the SEPARATE, tight SWEEP anti-drain policy (order-pinned; the claim
 *      and send allowlists are NEVER widened),
 *   3. enforces the fee cap,
 *   4. fee-bumps + submits.
 *
 * The sponsor sources NOTHING and moves no value of its own — funds go only
 * throwaway → home (both the user's own accounts) — and it RECLAIMS the
 * throwaway's sponsored reserves on the merge. It never needs to sign the inner
 * tx (unlike /send-link): every inner op is throwaway-sourced.
 */
import { TransactionBuilder, type Transaction, type Horizon } from "@stellar/stellar-sdk";
import { validateSweepTransaction, type SweepPolicy } from "./anti-drain.js";
import { chargeSponsorFee, signCharged } from "./caps.js";
import type { SponsorConfig } from "./config.js";
import type { SponsorSigner } from "./signer.js";
import { submit } from "./stellar.js";

export interface SweepInput {
  /** Client-signed sweep inner tx (base64 XDR), sourced by the throwaway account. */
  xdr: string;
  /** The per-link throwaway account (tx source + source of every op). */
  throwawayPublicKey: string;
  /** The user's persistent home account (payment + accountMerge destination). */
  homePublicKey: string;
  /**
   * The incoming Claimable Balance the sweep may claim. Provide ONLY for the 4-op
   * (unclaimed-CB) shape; omit for the 3-op already-claimed shape.
   */
  balanceId?: string;
  /** The exact amount being swept (must equal the throwaway's USDC balance). */
  amount: string;
}

export interface SweepResult {
  hash: string;
  ledger: number;
}

/** Per-operation base fee (stroops) the sponsor pays on the fee-bump. */
const FEEBUMP_PER_OP_STROOPS = 1000;

export async function sweepHandler(
  server: Horizon.Server,
  config: SponsorConfig,
  signer: SponsorSigner,
  input: SweepInput,
): Promise<SweepResult> {
  const inner = TransactionBuilder.fromXDR(input.xdr, config.networkPassphrase) as Transaction;

  const policy: SweepPolicy = {
    throwaway: input.throwawayPublicKey,
    sponsor: config.sponsorAccountId,
    sponsorSigner: signer.publicKey(), // a KMS key's own address is sponsor-controlled too (lib/anti-drain.ts)
    home: input.homePublicKey,
    usdc: config.usdc,
    expectedAmount: input.amount,
    expectedBalanceId: input.balanceId, // undefined for the 3-op already-claimed shape
  };
  const verdict = validateSweepTransaction(inner, policy);
  if (!verdict.ok) throw new Error(`anti-drain rejected the sweep tx: ${verdict.reason}`);

  const totalFee = FEEBUMP_PER_OP_STROOPS * (inner.operations.length + 1);
  if (totalFee > Number.parseInt(config.feeBumpMaxStroops, 10)) {
    throw new Error(`fee ${totalFee} exceeds cap ${config.feeBumpMaxStroops}`);
  }

  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    config.sponsorAccountId,
    String(FEEBUMP_PER_OP_STROOPS),
    inner,
    config.networkPassphrase,
  );
  /* The bid must be exactly the route's own: the SDK adds any resource fee the inner DECLARES
     (its Soroban data) to the fee-bump, and nothing above reads that field, so a client could
     declare 14 XLM on a claim and have the sponsor bid it (a review did). A classic inner carries
     no Soroban data; a bid other than the nominal one is refused before the charge. */
  if (BigInt(feeBump.fee) !== BigInt(totalFee)) {
    throw new Error(`fee-bump fee ${feeBump.fee} differs from the ${totalFee} this route bids (the inner declares Soroban resources)`);
  }
  // The fee is the sponsor's only cost here (the merge even hands reserves back), and it is bid
  // against the day's fee budget after every guard and before the signature. A sweep that never
  // reaches a ledger (an account that does not exist, a malformed operation) gives its bid back; one
  // that is included and fails counts what the ledger charged (lib/caps.ts, lib/stellar.ts).
  const charge = await chargeSponsorFee(feeBump.fee);
  await signCharged(charge, () => signer.sign(feeBump));
  const { hash, ledger } = await submit(server, feeBump, charge);
  return { hash, ledger };
}
