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
import { TransactionBuilder, type FeeBumpTransaction, type Transaction, type Horizon } from "@stellar/stellar-sdk";
import { validateInnerTransaction, ALLOWED_SEND_OP_TYPES, type InnerTxPolicy } from "./anti-drain.js";
import { capsFromEnv, chargeSponsorFee, checkCaps, PublicRefusal, USDC_STROOPS } from "./caps.js";
import type { SponsorConfig } from "./config.js";
import type { SponsorSigner } from "./signer.js";
import { submit, createdBalanceIdFromResult, isSubmitUnconfirmed, SubmitUnconfirmedError } from "./stellar.js";

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
    sponsor: config.sponsorAccountId,
    sponsorSigner: signer.publicKey(), // a KMS key's own address is sponsor-controlled too (lib/anti-drain.ts)
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
  // The sender's key is the per-sender day bound: one wallet, or one client looping on a bug,
  // cannot spend the whole day's escrow budget on everybody else's behalf.
  const cap = await checkCaps(amountStroops, capsFromEnv(), Date.now(), input.senderPublicKey);
  if (!cap.ok) throw new PublicRefusal(`canary cap: ${cap.reason}`);

  let submitted: Awaited<ReturnType<typeof submit>>;
  try {
    /* The sponsor's bid is the fee-bump's declared fee: the base fee times (inner ops + 1), which
     * is exactly `totalFee` above (the SDK derives the bump's fee the same way; the check after the
     * bump is built pins that). It is charged before the FIRST signature, because the fee-bump
     * cannot be built until the inner is signed (the builder copies the inner envelope as it is)
     * and nothing may be signed on a refused charge. A refusal throws into the catch below, which
     * gives the escrow reservation back: nothing was signed, nothing was submitted. */
    const charge = await chargeSponsorFee(totalFee);

    let feeBump: FeeBumpTransaction;
    try {
      // The sponsor signs the INNER tx too (it is the source of the begin op). Adding a
      // signature does not change the inner tx hash, so both signatures validate.
      await signer.sign(inner);

      feeBump = TransactionBuilder.buildFeeBumpTransaction(
        config.sponsorAccountId,
        String(FEEBUMP_PER_OP_STROOPS),
        inner,
        config.networkPassphrase,
      );
      if (BigInt(feeBump.fee) !== BigInt(totalFee)) {
        throw new Error(`fee-bump fee ${feeBump.fee} differs from the ${totalFee} charged to the fee budget`);
      }
      await signer.sign(feeBump);
    } catch (e) {
      // Nothing left this process: whatever was signed was never posted, so the bid comes back.
      await charge.notIncluded();
      throw e;
    }
    submitted = await submit(server, feeBump, charge);
  } catch (e) {
    /* Give the day's budget back only when the send definitely never landed. A submission Horizon
     * never ruled on (timeout, 5xx) leaves a valid, signed transaction that may still be included;
     * releasing its cap here let the same amount be sent again on top of it, and the counter ended
     * the day under-counted by one real send. The undecided case keeps its reservation: the day's
     * budget is the one thing that must err on the side of "spent". */
    if (!isSubmitUnconfirmed(e)) await cap.release?.();
    throw e;
  }
  const { hash, ledger, resultXdr } = submitted;

  /* From here the send HAS landed. Any failure below is about naming its balance, never about the
   * money, so it must not read as "the send failed": a plain error here used to release the pilot
   * slot (worker.ts, withPilotSlot) and show the sender "Your money hasn't moved. Try again." for
   * money that had moved. It is raised as an unconfirmed submit with the hash instead: 202, the
   * slot and the escrow reservation kept, and the client settles it against the ledger. */
  try {
    // The created CB's id comes from THIS transaction's result XDR. The previous
    // "newest CB where the sender is a claimant" Horizon query was racy: two sends
    // in flight from one sender could return each other's ids (and request money
    // makes concurrent sends more likely, not less). The result names the id exactly.
    const opIndex = inner.operations.findIndex((op) => op.type === "createClaimableBalance");
    let balanceId = resultXdr ? createdBalanceIdFromResult(resultXdr, opIndex) : null;
    if (!balanceId) {
      // Defensive fallback only: the tx HAS succeeded, so failing the request here
      // would strand a submitted send. This path keeps the old lookup's race, so it
      // must be LOUD: if this warning shows up in logs, the result-XDR shape has
      // drifted (e.g. an sdk bump) and the race is silently back: fix the parser.
      console.warn(`[send-link] balanceId fallback lookup used (result-XDR parse failed) for tx ${hash}`);
      const cb = await server.claimableBalances().claimant(input.senderPublicKey).order("desc").limit(1).call();
      balanceId = cb.records[0]?.id ?? null;
    }
    if (!balanceId) throw new Error("the Claimable Balance id was not found");
    return { hash, ledger, balanceId };
  } catch (e) {
    throw new SubmitUnconfirmedError(`the send landed (tx ${hash}) but its balance id could not be read: ${(e as Error).message}`, hash);
  }
}
