/**
 * /payout — the user sends their OWN dollars straight out to an address they name.
 *
 * This is the "cash out" leg: to turn dollars into local money, people move them to
 * a deposit address at a licensed exchange. An exchange credits that deposit when a
 * `payment` operation carrying the right MEMO arrives — so this endpoint exists
 * because the onward-send endpoint (/send-link) creates a Claimable Balance, which
 * an exchange would never pick up.
 *
 * The CLIENT builds + signs one inner tx it sources itself:
 *   payment(USDC, amount → destination)   [source: sender]   + an optional memo
 * The sponsor:
 *   1. re-parses the XDR,
 *   2. runs the SEPARATE, tight PAYOUT policy (the claim/send/sweep allowlists are
 *      never widened),
 *   3. enforces the fee cap,
 *   4. fee-bumps + submits.
 *
 * The sponsor sources nothing and moves none of its own value — it pays the fee, and
 * that is its whole exposure. The memo rides through untouched: a fee-bump wraps the
 * inner transaction whole (test-antidrain.ts asserts this, because a dropped memo on
 * an exchange deposit is exactly how people lose money).
 */
import { TransactionBuilder, type Transaction, type Horizon } from "@stellar/stellar-sdk";
import { validatePayoutTransaction, type PayoutPolicy } from "./anti-drain.js";
import { chargeSponsorFee, signCharged } from "./caps.js";
import type { SponsorConfig } from "./config.js";
import type { SponsorSigner } from "./signer.js";
import { submit } from "./stellar.js";

export interface PayoutInput {
  /** Client-signed payout inner tx (base64 XDR), sourced by the user's account. */
  xdr: string;
  /** The user's account (tx source + payment source). */
  senderPublicKey: string;
  /** The declared destination — a G… account or a muxed M… address. */
  destination: string;
  /** The declared amount (must equal the payment op's amount). */
  amount: string;
}

export interface PayoutResult {
  hash: string;
  ledger: number;
}

/** Per-operation base fee (stroops) the sponsor pays on the fee-bump. */
const FEEBUMP_PER_OP_STROOPS = 1000;

export async function payoutHandler(
  server: Horizon.Server,
  config: SponsorConfig,
  signer: SponsorSigner,
  input: PayoutInput,
): Promise<PayoutResult> {
  const inner = TransactionBuilder.fromXDR(input.xdr, config.networkPassphrase) as Transaction;

  const policy: PayoutPolicy = {
    sender: input.senderPublicKey,
    sponsor: config.sponsorAccountId,
    sponsorSigner: signer.publicKey(), // a KMS key's own address is sponsor-controlled too (lib/anti-drain.ts)
    usdc: config.usdc,
    expectedDestination: input.destination,
    expectedAmount: input.amount,
  };
  const verdict = validatePayoutTransaction(inner, policy);
  if (!verdict.ok) throw new Error(`anti-drain rejected the payout tx: ${verdict.reason}`);

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
  // The sponsor's whole exposure on this route is the fee, and this is where it is bounded: the
  // bid joins the day's fee budget after every guard and before the signature, and the network's
  // answer settles it (lib/caps.ts).
  const charge = await chargeSponsorFee(feeBump.fee);
  await signCharged(charge, () => signer.sign(feeBump));
  const { hash, ledger } = await submit(server, feeBump, charge);
  return { hash, ledger };
}
