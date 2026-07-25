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
    sponsor: signer.publicKey(),
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
    signer.publicKey(),
    String(FEEBUMP_PER_OP_STROOPS),
    inner,
    config.networkPassphrase,
  );
  await signer.sign(feeBump);
  const { hash, ledger } = await submit(server, feeBump);
  return { hash, ledger };
}
