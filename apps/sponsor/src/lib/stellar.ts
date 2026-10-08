/**
 * Thin Horizon helpers shared by the sponsor endpoints and the CLI.
 */
import { Horizon, xdr } from "@stellar/stellar-sdk";
import type { FeeCharge } from "./caps.js";
import type { SponsorConfig } from "./config";

/**
 * The Claimable Balance id created by a transaction, read from ITS OWN result XDR
 * (Horizon's hex id string). This is the unambiguous source — a "newest CB where X
 * is a claimant" Horizon query races against concurrent txs. Handles the fee-bump
 * wrapper (fee-bumped submits put the inner tx's op results one level down) and a
 * plain (unwrapped) result. Returns null on any shape surprise so the caller can
 * fall back rather than fail a tx that already succeeded.
 */
export function createdBalanceIdFromResult(resultXdr: string, opIndex: number): string | null {
  if (opIndex < 0) return null;
  try {
    const top = xdr.TransactionResult.fromXDR(resultXdr, "base64").result();
    const inner = top.switch().name.startsWith("txFeeBumpInner")
      ? top.innerResultPair().result().result()
      : top;
    const op = inner.results()[opIndex];
    if (!op) return null;
    return op.tr().createClaimableBalanceResult().balanceId().toXDR("hex");
  } catch {
    return null;
  }
}

/**
 * The fee the ledger charged for a transaction, from its own result (`TransactionResult.feeCharged`,
 * stroops; for a fee-bump it is the outer result, what the fee source paid). Takes the base64 XDR
 * Horizon returns or the object the Soroban RPC client has already parsed (getTransaction's
 * `resultXdr`: "the raw TransactionResult XDR struct for this transaction",
 * developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getTransaction). Null when absent
 * or unreadable, and the caller then keeps the whole bid counted (lib/caps.ts, `FeeCharge.settled`).
 */
export function feeChargedOf(result: string | xdr.TransactionResult | null | undefined): bigint | null {
  if (!result) return null;
  try {
    const r = typeof result === "string" ? xdr.TransactionResult.fromXDR(result, "base64") : result;
    return BigInt(r.feeCharged().toString());
  } catch {
    return null;
  }
}

/**
 * The result codes stellar-core gives a transaction it refuses while VALIDATING it, before any
 * ledger, so a transaction refused with one of them paid no fee. For a fee-bump the inner code
 * counts when the outer one is txFeeBumpInnerFailed.
 *
 * Deliberately absent: txFailed, txInternalError, txBadSponsorship and every code newer than this
 * list, because those can describe a transaction that WAS included and did pay. An included
 * transaction can carry a code from this list too, but only in a same-ledger race its sender pays
 * for with a transaction of their own (another of their transactions moving the sequence first),
 * one undercounted bid per paid transaction; the readiness report states that residual.
 */
const VALIDATION_ONLY_CODES = new Set([
  "txTooEarly",
  "txTooLate",
  "txMissingOperation",
  "txBadSeq",
  "txBadAuth",
  "txInsufficientBalance",
  "txNoAccount",
  "txInsufficientFee",
  "txBadAuthExtra",
  "txNotSupported",
  "txBadMinSeqAgeOrGap",
  "txMalformed",
  "txSorobanInvalid",
]);

/** True when a result names a refusal core only makes while validating (see the set above). */
export function refusedWhileValidating(result: string | xdr.TransactionResult | null | undefined): boolean {
  if (!result) return false;
  try {
    const r = typeof result === "string" ? xdr.TransactionResult.fromXDR(result, "base64") : result;
    let code = r.result().switch().name;
    if (code === "txFeeBumpInnerFailed") code = r.result().innerResultPair().result().result().switch().name;
    return VALIDATION_ONLY_CODES.has(code);
  } catch {
    return false;
  }
}

/** How long `ledgerFeeCharged` waits before asking a second time: about one ledger close. */
let ledgerRecheckMs = 5_000;

/** Test seam: shorten the wait between the two lookups. */
export function setLedgerRecheckMsForTests(ms: number): void {
  ledgerRecheckMs = ms;
}

/**
 * What the ledger says about a transaction Horizon refused with a code that is NOT validation-only
 * (txFailed and its kin). stellar-core gives the same codes to an operation it refuses while
 * validating (a malformed one) and to a transaction that was included and failed, and only the
 * ledger tells the two apart. Horizon answers a synchronous submission only after it has ingested an
 * included transaction, but the lookup may reach ANOTHER Horizon instance behind the same URL, one
 * that has not ingested that ledger yet, and a single 404 from it would hand back a fee that was paid.
 * So a 404 is asked again after about one ledger, and only a second 404 reads as never included.
 * Returns the fee the ledger charged, null when Horizon does not know the hash twice (never included,
 * so nothing was paid), and undefined when a read itself failed (undecided: the caller keeps the
 * count high).
 */
async function ledgerFeeCharged(
  server: Horizon.Server,
  tx: Parameters<Horizon.Server["submitTransaction"]>[0],
): Promise<bigint | null | undefined> {
  let hash: string;
  try {
    hash = tx.hash().toString("hex");
  } catch {
    return undefined;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const rec = (await server.transactions().transaction(hash).call()) as { fee_charged?: string | number };
      const fee = rec.fee_charged;
      return fee === undefined || fee === null ? undefined : BigInt(String(fee));
    } catch (e) {
      const err = e as { name?: string; response?: { status?: number } } | null | undefined;
      if (!(err?.response?.status === 404 || err?.name === "NotFoundError")) return undefined;
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, ledgerRecheckMs));
    }
  }
  return null;
}

/**
 * Settle a fee charge on a DECIDED Horizon refusal (one `outcomeUnknown` says was ruled on). With a
 * result: the whole bid comes back for a validation-only code; for any other code the ledger is
 * asked (`ledgerFeeCharged`): a hash it does not know was never included and gives the bid back, an
 * included one counts what it was charged, and an unreadable answer counts the fee the result names
 * (a nominal figure for a transaction that was not included, which keeps the count high, never low).
 * Without a result: Horizon refused the request itself (a malformed envelope, its own rate limit) or
 * the SEP-29 guard stopped it before the POST, so core never saw it; unless result codes came without
 * their XDR, which names nothing, and the bid stays.
 */
async function settleRefusal(
  server: Horizon.Server,
  tx: Parameters<Horizon.Server["submitTransaction"]>[0],
  charge: FeeCharge,
  e: unknown,
): Promise<void> {
  const extras = (e as { response?: { data?: { extras?: { result_xdr?: string; result_codes?: unknown } } } })?.response
    ?.data?.extras;
  if (extras?.result_xdr) {
    if (refusedWhileValidating(extras.result_xdr)) {
      await charge.notIncluded();
      return;
    }
    const onLedger = await ledgerFeeCharged(server, tx);
    if (onLedger === null) await charge.notIncluded();
    else if (onLedger !== undefined) await charge.settled(onLedger);
    else await charge.settled(feeChargedOf(extras.result_xdr));
    return;
  }
  if (extras?.result_codes) await charge.settled(null);
  else await charge.notIncluded();
}

export function horizon(config: SponsorConfig): Horizon.Server {
  return new Horizon.Server(config.horizonUrl);
}

/**
 * A submission whose OUTCOME IS UNKNOWN — which is not the same as one that failed.
 *
 * Horizon answers 504 while the transaction is still queued, and the transaction stays valid
 * until its own timebound expires, so it may be included seconds after we gave up listening.
 * A caller that collapses this into "it failed" tells the user their money never moved, and on
 * the payout leg — a payment to an exchange, with no reclaim and no link to un-send — that
 * sentence invites a SECOND irreversible payment. The hash is the only pointer that survives
 * an answer that never came; it is what an operator or a later read settles this against.
 */
export class SubmitUnconfirmedError extends Error {
  readonly submitUnconfirmed = true;
  constructor(detail: string, readonly hash?: string) {
    super(`submit unconfirmed: ${detail}`);
    this.name = "SubmitUnconfirmedError";
  }
}

/** True for a submission that was never definitively decided. Reads the brand, not the class. */
export function isSubmitUnconfirmed(e: unknown): boolean {
  return (
    e instanceof SubmitUnconfirmedError ||
    (e as { submitUnconfirmed?: boolean } | null | undefined)?.submitUnconfirmed === true
  );
}

/**
 * Did anything actually DECIDE this transaction? Only two answers are definitive: the ledger's
 * own verdict (Horizon's `extras.result_codes`), and a refusal raised here before the envelope
 * was ever posted. Everything else — a gateway timeout, a 5xx, an answer that never arrived —
 * leaves a valid transaction that may still be included.
 *
 * The bias is deliberate and one-directional: a wrong "we could not confirm" costs the user a
 * check and a wait, a wrong "nothing moved" costs them the money twice.
 */
function outcomeUnknown(e: unknown): boolean {
  // Horizon's SEP-29 guard runs client-side, BEFORE the POST — nothing was submitted.
  if ((e as Error | null | undefined)?.name === "AccountRequiresMemoError") return false;
  const res = (e as { response?: { status?: number; data?: { extras?: { result_codes?: unknown } } } })
    ?.response;
  if (res?.data?.extras?.result_codes) return false;
  const status = res?.status;
  return typeof status !== "number" || status === 408 || status >= 500;
}

/**
 * Submit a tx, surfacing Horizon's `extras` (the useful part) on failure.
 *
 * With `charge` (the day's fee budget entry for this transaction, lib/caps.ts) the answer also
 * settles the charge: an included transaction counts the fee its result names, a refusal core made
 * while validating gives the bid back, and an undecided answer leaves the whole bid counted.
 */
export async function submit(
  server: Horizon.Server,
  tx: Parameters<Horizon.Server["submitTransaction"]>[0],
  charge?: FeeCharge,
): Promise<{ hash: string; ledger: number; resultXdr?: string }> {
  let res: Awaited<ReturnType<Horizon.Server["submitTransaction"]>>;
  try {
    res = await server.submitTransaction(tx);
  } catch (e: unknown) {
    const extras = (e as { response?: { data?: { extras?: unknown } } })?.response?.data?.extras;
    const detail = extras ? JSON.stringify(extras) : (e as Error).message;
    if (outcomeUnknown(e)) {
      let hash: string | undefined;
      try {
        hash = tx.hash().toString("hex");
      } catch {
        /* an envelope we cannot hash is one we cannot name; the error still has to be raised */
      }
      throw new SubmitUnconfirmedError(detail, hash);
    }
    if (charge) await settleRefusal(server, tx, charge, e);
    throw new Error(`submit failed: ${detail}`);
  }
  // result_xdr names exactly what THIS tx did (e.g. the created CB id): callers
  // that need an id must read it from here, not from a "newest matching entry"
  // Horizon query, which races against concurrent txs.
  const resultXdr = (res as { result_xdr?: string }).result_xdr;
  if (charge) await charge.settled(feeChargedOf(resultXdr) ?? (res as { fee_charged?: string | number }).fee_charged);
  return { hash: res.hash, ledger: res.ledger, resultXdr };
}

export async function nativeBalance(server: Horizon.Server, pub: string): Promise<string> {
  const acc = await server.loadAccount(pub);
  return acc.balances.find((b) => b.asset_type === "native")?.balance ?? "0";
}

export async function trustlineBalance(
  server: Horizon.Server,
  pub: string,
  code: string,
  issuer: string,
): Promise<string> {
  const acc = await server.loadAccount(pub);
  const line = acc.balances.find(
    (b) => "asset_code" in b && b.asset_code === code && "asset_issuer" in b && b.asset_issuer === issuer,
  );
  return line ? line.balance : "NO_TRUSTLINE";
}

export async function friendbot(pub: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot failed for ${pub}: ${res.status}`);
}
