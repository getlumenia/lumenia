/**
 * /feebump — the sponsor's value-moving endpoint (Instawards SOW, D1 + D3).
 *
 * The CLIENT builds + signs the claim inner tx (claimClaimableBalance, sourced by
 * the recipient) and sends it as XDR. The sponsor:
 *   1. re-parses the XDR,
 *   2. runs the CANONICAL anti-drain validator (strict) — this is the D3 gate,
 *   3. enforces a fee cap,
 *   4. fee-bumps the re-parsed tx with the sponsor key and submits it.
 *
 * The recipient holds 0 XLM throughout — the sponsor pays the fee via the bump.
 * The anti-drain validator is the sponsor-local ./anti-drain.js module, so esbuild
 * inlines it into the deployed function (no workspace:* dependency, which
 * npm/Vercel can't resolve); the SAME module runs in test-antidrain (18/18).
 */
import { TransactionBuilder, type Transaction, type Horizon } from "@stellar/stellar-sdk";
import { validateInnerTransaction, type InnerTxPolicy } from "./anti-drain.js";
import type { SponsorConfig } from "./config.js";
import type { SponsorSigner } from "./signer.js";
import { submit } from "./stellar.js";

export interface FeebumpInput {
  /** Client-signed inner claim tx (base64 XDR). */
  xdr: string;
  /** The recipient account that must source the claim (tx source). */
  recipientPublicKey: string;
  /** The exact Claimable Balance the claim is allowed to target. */
  balanceId: string;
}

export interface FeebumpResult {
  hash: string;
  ledger: number;
}

/** Per-operation base fee (stroops) the sponsor pays on the fee-bump. */
const FEEBUMP_PER_OP_STROOPS = 1000;

export async function feebumpHandler(
  server: Horizon.Server,
  config: SponsorConfig,
  signer: SponsorSigner,
  input: FeebumpInput,
): Promise<FeebumpResult> {
  const inner = TransactionBuilder.fromXDR(input.xdr, config.networkPassphrase) as Transaction;

  // D3 gate: the anti-drain validator must accept the client tx before we sign.
  const policy: InnerTxPolicy = {
    expectedSource: input.recipientPublicKey,
    sponsor: signer.publicKey(),
    expectedAsset: config.usdc,
    expectedBalanceId: input.balanceId,
    maxOps: 1, // the claim path is exactly one claimClaimableBalance op
  };
  const verdict = validateInnerTransaction(inner, policy);
  if (!verdict.ok) throw new Error(`anti-drain rejected the inner tx: ${verdict.reason}`);

  // Fee cap: the sponsor never pays more than feeBumpMaxStroops for a single bump.
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
  signer.sign(feeBump);
  return submit(server, feeBump);
}
