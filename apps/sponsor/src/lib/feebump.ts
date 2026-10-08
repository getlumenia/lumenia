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
 * The anti-drain validator is the sponsor-local ./anti-drain.js module (moved out of
 * packages/shared so the deployed code carries no workspace:* dependency); the live
 * Cloudflare Worker (src/worker.ts) bundles it directly, and the SAME module is
 * exercised by the full anti-drain suite in test-antidrain.ts.
 */
import { TransactionBuilder, type Transaction, type Horizon } from "@stellar/stellar-sdk";
import { validateInnerTransaction, type InnerTxPolicy } from "./anti-drain.js";
import { chargeSponsorFee, signCharged } from "./caps.js";
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
    sponsor: config.sponsorAccountId,
    sponsorSigner: signer.publicKey(), // a KMS key's own address is sponsor-controlled too (lib/anti-drain.ts)
    expectedAsset: config.usdc,
    expectedBalanceId: input.balanceId,
    maxOps: 1, // the claim path is exactly one claimClaimableBalance op
    expectedOpSequence: ["claimClaimableBalance"], // pin the exact shape (defense-in-depth)
  };
  const verdict = validateInnerTransaction(inner, policy);
  if (!verdict.ok) throw new Error(`anti-drain rejected the inner tx: ${verdict.reason}`);

  // Fee cap: the sponsor never pays more than feeBumpMaxStroops for a single bump.
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
  // The sponsor pays this bid. It is charged against the day's fee budget AFTER every guard and
  // BEFORE the signature, and settled by the network's answer: a signer that throws or a refusal
  // core made while validating gives it back, an included transaction counts what it was charged,
  // and an undecided one keeps the whole bid (lib/caps.ts, the fee budget header).
  const charge = await chargeSponsorFee(feeBump.fee);
  await signCharged(charge, () => signer.sign(feeBump));
  return submit(server, feeBump, charge);
}
