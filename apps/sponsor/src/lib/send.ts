/**
 * /send-link — the sponsor's onward-send endpoint (Stage 5, proven by Spike #5).
 *
 * A 0-XLM sender builds + signs the send inner tx
 *   beginSponsoringFutureReserves(sponsoredId=sender)   [source: sponsor]
 *   createClaimableBalance(USDC, amount, [bearer, sender-reclaim-7d]) [source: sender]
 *   endSponsoringFutureReserves()                        [source: sender]
 * (tx.source = sender; the sender signs create + end). The sponsor:
 *   1. re-parses the XDR,
 *   2. runs the SEND anti-drain policy (its OWN tight allowlist — the claim
 *      allowlist is never widened; bounds the reserve lock via claimant count +
 *      predicate shape),
 *   3. enforces a fee cap,
 *   4. ALSO SIGNS THE INNER TX (for its begin op — new vs the claim path),
 *   5. fee-bumps + submits, and returns the created Claimable Balance id.
 *
 * The USDC is the sender's own; the sponsor only sponsors the ~1.0-XLM reserve
 * (refundable on claim/reclaim) + the fee. Value can never leave the sponsor.
 */
import { TransactionBuilder, type Transaction, type Horizon } from "@stellar/stellar-sdk";
import { validateInnerTransaction, ALLOWED_SEND_OP_TYPES, type InnerTxPolicy } from "./anti-drain.js";
import { capsFromEnv, checkCaps, USDC_STROOPS } from "./caps.js";
import type { SponsorConfig } from "./config.js";
import type { SponsorSigner } from "./signer.js";
import { submit, createdBalanceIdFromResult } from "./stellar.js";

export interface SendLinkInput {
  /** Client-signed send inner tx (base64 XDR). */
  xdr: string;
  /** The sender account that must source the tx + the createClaimableBalance. */
  senderPublicKey: string;
}

export interface SendLinkResult {
  hash: string;
  ledger: number;
  /** The created Claimable Balance id (so the client can build the claim link). */
  balanceId: string;
}

/** Per-operation base fee (stroops) the sponsor pays on the fee-bump. */
const FEEBUMP_PER_OP_STROOPS = 1000;

/** The exact claimant shape the send flow builds: bearer (unconditional) + sender-reclaim. */
const EXPECTED_CLAIMANTS = 2;

export async function sendLinkHandler(
  server: Horizon.Server,
  config: SponsorConfig,
  signer: SponsorSigner,
  input: SendLinkInput,
): Promise<SendLinkResult> {
  const inner = TransactionBuilder.fromXDR(input.xdr, config.networkPassphrase) as Transaction;

  // D3 gate — the SEND policy (separate tight allowlist; the claim path is untouched).
  const policy: InnerTxPolicy = {
    expectedSource: input.senderPublicKey,
    sponsor: signer.publicKey(),
    expectedAsset: config.usdc,
    allowedOpTypes: ALLOWED_SEND_OP_TYPES,
    expectedClaimantCount: EXPECTED_CLAIMANTS,
    maxOps: 3,
    // Pin the exact ordered shape the send flow builds (defense-in-depth): a reordered
    // set of the same ops is rejected even though each op passes on its own.
    expectedOpSequence: [
      "beginSponsoringFutureReserves",
      "createClaimableBalance",
      "endSponsoringFutureReserves",
    ],
  };
  const verdict = validateInnerTransaction(inner, policy);
  if (!verdict.ok) throw new Error(`anti-drain rejected the send tx: ${verdict.reason}`);

  const totalFee = FEEBUMP_PER_OP_STROOPS * (inner.operations.length + 1);
  if (totalFee > Number.parseInt(config.feeBumpMaxStroops, 10)) {
    throw new Error(`fee ${totalFee} exceeds cap ${config.feeBumpMaxStroops}`);
  }

  // Canary caps — bound the escrow this endpoint will create (per-send + per-UTC-day).
  // The anti-drain policy above already pinned the op sequence, so index 1 IS the CB.
  const cbOp = inner.operations.find((op) => op.type === "createClaimableBalance") as
    | { amount?: string }
    | undefined;
  const amountStroops = BigInt(Math.round(Number.parseFloat(cbOp?.amount ?? "0") * Number(USDC_STROOPS)));
  const cap = await checkCaps(amountStroops, capsFromEnv());
  if (!cap.ok) throw new Error(`canary cap: ${cap.reason}`);

  let submitted: Awaited<ReturnType<typeof submit>>;
  try {
    // The sponsor signs the INNER tx too (it is the source of the begin op). Adding a
    // signature does not change the inner tx hash, so both signatures validate.
    await signer.sign(inner);

    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      signer.publicKey(),
      String(FEEBUMP_PER_OP_STROOPS),
      inner,
      config.networkPassphrase,
    );
    await signer.sign(feeBump);
    submitted = await submit(server, feeBump);
  } catch (e) {
    await cap.release?.(); // the send never landed — give the day's budget back
    throw e;
  }
  const { hash, ledger, resultXdr } = submitted;

  // The created CB's id comes from THIS transaction's result XDR. The previous
  // "newest CB where the sender is a claimant" Horizon query was racy: two sends
  // in flight from one sender could return each other's ids (and request money
  // makes concurrent sends more likely, not less). The result names the id exactly.
  const opIndex = inner.operations.findIndex((op) => op.type === "createClaimableBalance");
  let balanceId = resultXdr ? createdBalanceIdFromResult(resultXdr, opIndex) : null;
  if (!balanceId) {
    // Defensive fallback only — the tx HAS succeeded, so failing the request here
    // would strand a submitted send. This path keeps the old lookup's race, so it
    // must be LOUD: if this warning shows up in logs, the result-XDR shape has
    // drifted (e.g. an sdk bump) and the race is silently back — fix the parser.
    console.warn(`[send-link] balanceId fallback lookup used (result-XDR parse failed) for tx ${hash}`);
    const cb = await server.claimableBalances().claimant(input.senderPublicKey).order("desc").limit(1).call();
    balanceId = cb.records[0]?.id ?? null;
  }
  if (!balanceId) throw new Error("send submitted but the Claimable Balance id was not found");

  return { hash, ledger, balanceId };
}
