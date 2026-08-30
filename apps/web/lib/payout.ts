/**
 * Sending dollars OUT to an address someone gave you — the cash-out leg, and the one
 * place in this product where a user can permanently lose money to a typo.
 *
 * Exchanges share ONE deposit account across every customer and tell them apart by a
 * MEMO. A deposit with a missing or wrong memo lands in that shared pot with nothing
 * to identify it, and getting it back means a support case that often fails. The
 * network will not stop you: memo-required (SEP-29) is a client-side convention, not
 * a protocol rule, so this file is the check. Three shapes, safest first:
 *
 *   1. a muxed M… address (SEP-23) — the memo is encoded INSIDE the address, so
 *      there is no memo field and no way to get it wrong.
 *   2. a payment URI / QR (SEP-7 `web+stellar:pay`) — address and memo arrive
 *      together, already paired.
 *   3. a plain G… address — then the memo is typed by hand, and we require it when
 *      the destination is flagged memo-required.
 *
 * The transfer itself is a real `payment` operation, NOT the Claimable Balance the
 * link-send uses: an exchange credits a payment, and would leave a Claimable Balance
 * sitting unclaimed. The user holds no XLM, so the sponsor fee-bumps it via /payout
 * (its own tight anti-drain policy). The memo rides through the fee-bump untouched.
 */
import {
  Asset,
  BASE_FEE,
  Horizon,
  Memo,
  MuxedAccount,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { Signer } from "./signer";
import { loadTransfer } from "./horizon";
import { activeNetwork } from "./network";
import { assertHealthMatchesPin, pinnedUsdcIssuer } from "./tx-guard";

/** Stellar text memos are capped at 28 bytes; longer input is a typo, not a memo. */
export const MEMO_TEXT_MAX_BYTES = 28;

export type MemoKind = "none" | "text" | "id";

export interface Destination {
  /** The address as it will be paid — G… or muxed M…. */
  address: string;
  /** A muxed address carries its own memo; the memo field is hidden for these. */
  muxed: boolean;
}

/** Is this a payable Stellar destination (a plain account or a muxed address)? */
export function parseDestination(raw: string): Destination | null {
  const address = raw.trim();
  if (StrKey.isValidMed25519PublicKey(address)) return { address, muxed: true };
  if (StrKey.isValidEd25519PublicKey(address)) return { address, muxed: false };
  return null;
}

/**
 * When someone pastes an address we can't pay, WHICH network did they copy?
 *
 * This is the most common real mistake at an exchange: the deposit screen defaults to
 * Ethereum or Tron, they copy whatever it shows, and it isn't a Stellar address at all.
 * "That isn't a deposit address we recognise" sends them back to stare at a correct
 * address. Naming the network they actually copied tells them exactly what to fix, and
 * costs one regex. Nothing here is a guess about their money: it never affects what we
 * sign, only what we say.
 */
export function guessOtherNetwork(raw: string): string | null {
  const a = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return "Ethereum (or a network that shares its address format, like Base, Arbitrum, Polygon or BNB Chain)";
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return "Tron";
  if (/^(bc1|tb1)[a-z0-9]{25,}$/i.test(a) || /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(a)) return "Bitcoin";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return "Solana";
  return null;
}

export interface ParsedPaymentUri {
  destination: string;
  amount?: string;
  memo?: string;
  memoKind?: MemoKind;
  /** Present when the URI names an asset — used to warn if it isn't the dollars we hold. */
  assetCode?: string;
  assetIssuer?: string;
}

/**
 * Parse a SEP-7 `web+stellar:pay?...` URI (what an exchange's deposit QR encodes).
 * Returns null for anything that isn't a pay URI with a payable destination, so a
 * pasted plain address falls through to the manual path instead of failing loudly.
 *
 * SEP-7 percent-encodes the memo, and `memo_type` is MEMO_TEXT / MEMO_ID / MEMO_HASH /
 * MEMO_RETURN. Only TEXT and ID are accepted here: hash and return memos are not what
 * exchange deposits use, and quietly turning one into text would build the wrong memo.
 */
export function parsePaymentUri(raw: string): ParsedPaymentUri | null {
  const input = raw.trim();
  if (!/^web\+stellar:pay\b/i.test(input)) return null;
  const query = input.slice(input.indexOf("?") + 1);
  if (!query || !input.includes("?")) return null;
  const q = new URLSearchParams(query);

  const destination = (q.get("destination") ?? "").trim();
  if (!parseDestination(destination)) return null;

  const memoTypeRaw = (q.get("memo_type") ?? "").toUpperCase();
  const memoValue = q.get("memo") ?? undefined;
  let memoKind: MemoKind | undefined;
  if (memoValue) {
    if (memoTypeRaw === "MEMO_ID") memoKind = "id";
    else if (memoTypeRaw === "MEMO_TEXT" || memoTypeRaw === "") memoKind = "text";
    else return { destination }; // hash/return memo — hand back the address only
  }

  const amountRaw = q.get("amount") ?? undefined;
  const amount = amountRaw && /^\d+(\.\d{1,7})?$/.test(amountRaw) ? amountRaw : undefined;

  return {
    destination,
    amount,
    memo: memoValue,
    memoKind,
    assetCode: q.get("asset_code") ?? undefined,
    assetIssuer: q.get("asset_issuer") ?? undefined,
  };
}

/** Byte length of a text memo (Stellar counts bytes, and people paste non-ASCII). */
export function memoTextBytes(memo: string): number {
  return new TextEncoder().encode(memo).length;
}

export interface DestinationCheck {
  /** Does the account exist on the ledger? A payment to a missing account fails. */
  exists: boolean;
  /** Can it hold these dollars? Without the trustline the payment fails. */
  canHoldDollars: boolean;
  /** SEP-29: the destination has declared that every payment must carry a memo. */
  memoRequired: boolean;
}

/**
 * Look the destination up before anyone signs anything. This is a read, and every
 * answer it gives is honest: a missing account, a missing trustline, and the SEP-29
 * memo-required flag are all reasons the money would be lost or bounced.
 *
 * Muxed addresses resolve to their underlying account, which is what the ledger
 * actually checks.
 */
export async function checkDestination(address: string, issuer: string): Promise<DestinationCheck> {
  const { horizonUrl: HORIZON_URL } = activeNetwork();
  const underlying = StrKey.isValidMed25519PublicKey(address)
    ? MuxedAccount.fromAddress(address, "0").baseAccount().accountId()
    : address;

  const res = await fetch(`${HORIZON_URL}/accounts/${underlying}`);
  if (res.status === 404) return { exists: false, canHoldDollars: false, memoRequired: false };
  if (!res.ok) throw new Error(`could not read the destination account (${res.status})`);
  const acc = (await res.json()) as {
    balances?: { asset_code?: string; asset_issuer?: string }[];
    data?: Record<string, string>;
  };

  const canHoldDollars = (acc.balances ?? []).some(
    (b) => b.asset_code === "USDC" && b.asset_issuer === issuer,
  );
  // SEP-29: a `config.memo_required` data entry (any value) means "always send a memo".
  const memoRequired = Object.prototype.hasOwnProperty.call(acc.data ?? {}, "config.memo_required");

  return { exists: true, canHoldDollars, memoRequired };
}

export interface PayoutInput {
  sponsorUrl: string;
  signer: Signer;
  /** amount of dollars to send out */
  amount: string;
  /** the destination address — G… or muxed M… */
  destination: string;
  /** the memo the destination asked for; omit for a muxed address (it carries its own) */
  memo?: string;
  memoKind?: MemoKind;
}

export interface PayoutResult {
  hash: string;
}

/**
 * Thrown when the payment was handed over but its outcome could not be established. Same
 * doctrine, same vocabulary as `DepositUncertainError` in lib/lumendrop.ts — one word for one
 * thing, so nobody has to learn two.
 *
 * It is NOT a failure. The transaction stays valid until its timebound expires, so it may still
 * be included; the caller must not offer a retry, because a second attempt here is a second
 * payment to an exchange, with no reclaim window and no link to un-send.
 *
 * It is also not permanent. It carries the two things that end it — the hash to ask the public
 * record about, and the moment after which that record's silence is proof — so a caller can
 * resolve it (`payoutRecord`) rather than leave someone holding a warning nothing can lift.
 */
export class PayoutUncertainError extends Error {
  constructor(
    /**
     * The payment's own transaction hash. The sponsor wraps it in a fee-bump before submitting,
     * but Horizon resolves a fee-bumped transaction by its INNER hash as well, so this is the id
     * that settles the question — and the only pointer that survives an answer that never came.
     */
    readonly hash: string,
    /**
     * Unix ms after which the signed payment can no longer be included, so its absence from the
     * public record is at last proof that nothing moved. A read taken before this can only ever
     * answer "not yet"; only past it may a caller offer to send again.
     */
    readonly retrySafeAfter: number,
  ) {
    super("payout submitted but not confirmed");
    this.name = "PayoutUncertainError";
  }
}

/**
 * Answers that decide nothing. Horizon times out with the transaction still queued, an edge that
 * dies mid-request says nothing about what the sponsor already submitted, and 202 is "accepted,
 * outcome unknown" — the shape /v2-deposit already answers with, accepted here so that a sponsor
 * which marks an unconfirmed submission is believed without a second change on this side. 503 is
 * deliberately absent: the kill-switch answers before anything is submitted, so it genuinely
 * means nothing moved.
 */
const UNCONFIRMED_STATUS = new Set([202, 408, 500, 502, 504, 522, 524]);

/**
 * The sponsor's mainnet answer when it will not say why: `{"error":"request failed","ref":…}`
 * (apps/sponsor/src/worker.ts), which every reason that isn't a published product rule collapses
 * into. Caps and floors keep their text on every network and the rate limiter answers 429 with
 * its own, but this one body still covers BOTH a submission Horizon never ruled on AND a refusal
 * decided before anything was submitted — a definitive `op_underfunded` reads exactly like a
 * gateway timeout. So it is a reason to go and ask the ledger, never on its own an answer.
 */
function sponsorGaveNoReason(text: string): boolean {
  try {
    return (JSON.parse(text) as { error?: unknown }).error === "request failed";
  } catch {
    return false;
  }
}

/**
 * What the public record says about one payment.
 *
 *  - `confirmed` — included and successful: the money moved.
 *  - `rejected`  — included and failed: the fee was consumed, the payment was not made. Final.
 *  - `absent`    — no such transaction. Final ONLY once the signed payment can no longer be
 *                  included (`retrySafeAfter`); before that it means "not yet", not "never".
 *  - `unknown`   — a read that did not complete. Never reported as either of the others.
 */
export type PayoutRecord = "confirmed" | "rejected" | "absent" | "unknown";

/**
 * Ask the ledger about a payment by its hash — the authority the send-out screen already points
 * people at, reachable here directly instead of only by hand. Callers must weigh `absent` against
 * `PayoutUncertainError.retrySafeAfter` before treating it as proof that nothing moved.
 */
export async function payoutRecord(hash: string): Promise<PayoutRecord> {
  try {
    const tx = await loadTransfer(hash);
    if (!tx) return "absent";
    return tx.successful ? "confirmed" : "rejected";
  } catch {
    return "unknown";
  }
}

/**
 * Send dollars out: one sender-signed `payment` with the memo attached, fee-bumped by
 * the sponsor so a 0-XLM user can still move their own money. The sponsor's /payout
 * policy re-checks the destination and amount against what we declare here, so a
 * mismatch between the signed bytes and the request is rejected rather than submitted.
 */
export async function sendOut(opts: PayoutInput): Promise<PayoutResult> {
  const net = activeNetwork();
  const { horizonUrl: HORIZON_URL, passphrase: NETWORK } = net;
  const base = opts.sponsorUrl.replace(/\/$/, "");
  // The asset comes from this build, never from the wire: a swapped /health would otherwise pick
  // which token leaves the user's account, and this one goes to a real exchange deposit address.
  const health = (await (await fetch(`${base}/health`)).json()) as {
    usdcIssuer: string;
    usdcCode: string;
  };
  assertHealthMatchesPin(health, net.id);
  const USDC = new Asset("USDC", pinnedUsdcIssuer(net.id));
  const sender = opts.signer.publicKey();

  const server = new Horizon.Server(HORIZON_URL);
  const acc = await server.loadAccount(sender);
  const builder = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(
      Operation.payment({
        destination: opts.destination,
        asset: USDC,
        amount: opts.amount,
        source: sender,
      }),
    )
    .setTimeout(180);

  if (opts.memo && opts.memoKind && opts.memoKind !== "none") {
    builder.addMemo(opts.memoKind === "id" ? Memo.id(opts.memo) : Memo.text(opts.memo));
  }

  const inner = builder.build();
  await opts.signer.sign(inner);

  const hash = inner.hash().toString("hex");
  /* The moment after which the ledger's silence stops being "not yet" and becomes proof. A
   * transaction with no upper bound would never reach it, so absence could never settle anything. */
  const retrySafeAfter = Number(inner.timeBounds?.maxTime ?? 0) * 1000 || Number.POSITIVE_INFINITY;

  /* An answer that decided nothing is not a verdict, and neither is a guess about it. Ask the one
   * authority that can rule — the same public record the screen tells people to check — and report
   * what it actually says. Only where it cannot yet rule does the payment stay undecided. */
  const settle = async (detail: string): Promise<PayoutResult> => {
    const record = await payoutRecord(hash);
    if (record === "confirmed") return { hash };
    if (record === "rejected" || (record === "absent" && Date.now() >= retrySafeAfter)) {
      throw new Error(detail);
    }
    throw new PayoutUncertainError(hash, retrySafeAfter);
  };

  let res: Response;
  let text: string;
  try {
    res = await fetch(`${base}/payout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        xdr: inner.toXDR(),
        senderPublicKey: sender,
        destination: opts.destination,
        amount: opts.amount,
      }),
    });
    text = await res.text();
  } catch {
    /* No answer at all. A phone that loses signal mid-flight looks identical to one whose request
     * never left, and the sponsor may already have submitted the payment. */
    return await settle("/payout → no answer");
  }
  /* Three outcomes, and conflating them is what sends money twice.
   *
   * A definite rejection that says why never reached the ledger: the caps and floors keep their
   * text on every network and the rate limiter answers 429 with its own, so those throw normally.
   *
   * Everything else is undecided BY THIS ANSWER, and only by it. `submit unconfirmed` is the
   * sponsor's word for a submission Horizon never ruled on (apps/sponsor/src/lib/stellar.ts) and
   * reaches us verbatim only where the Worker passes error text through; the status list covers a
   * dead edge that writes no body at all; and on mainnet a withheld reason hides a submission and
   * a plain refusal behind the same body. None of the three is grounds to tell someone their money
   * is safe — this is the one screen where a wrong "nothing moved" pays the exchange twice — but
   * none is grounds to leave them with an unresolvable warning either, so each goes to the ledger. */
  if (UNCONFIRMED_STATUS.has(res.status) || /submit unconfirmed/i.test(text) || sponsorGaveNoReason(text)) {
    return await settle(`/payout → ${res.status}: ${text}`);
  }
  if (!res.ok) throw new Error(`/payout → ${res.status}: ${text}`);
  return JSON.parse(text) as PayoutResult;
}
