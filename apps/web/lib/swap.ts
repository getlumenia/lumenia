/**
 * Turning the XLM an account holds into the dollars the rails actually settle in.
 *
 * WHY THIS EXISTS, in one sentence: the lira rail settles in USDC and refuses everything else, so
 * an account holding XLM cannot reach it at all. Someone pays you in XLM, or you fund the account
 * from a wallet that only sends XLM, and the money is on the ledger but no product surface can
 * move it: /send-out, the link send and the lira rail all speak dollars. This module converts what
 * the account holds into dollars ONCE, at a price read from the order book, with a bound under it,
 * into the same account.
 *
 * WHAT IT IS NOT. Nothing is held anywhere, by us or by anyone else. There is no position, no
 * counterparty holding the money overnight and no second asset left behind: one Stellar path
 * payment whose destination is the account itself either lands inside the bound or fails. The only
 * verbs for this feature are convert and turn into.
 *
 * THE BOUND IS THE WHOLE SAFETY STORY. Testnet order books are thin, so a swap submitted without a
 * bound can fill at a price nobody agreed to. Every operation this module builds carries one --
 * `destMin` on a strict-send, `sendMax` on a strict-receive -- and the LEDGER enforces it: the
 * transaction fails rather than settling outside it. `buildSwapTx` throws when the bound is missing
 * or is not a 7dp string, so the rule cannot be regressed by a later edit.
 *
 * THE SPONSOR IS NOT INVOLVED, deliberately. The account signs and pays its own fee, which it can
 * afford because the conversion is only ever offered to an account that already holds XLM. That
 * keeps the anti-drain validator and the watchdog untouched: a sponsor-sourced path payment is the
 * one shape the watchdog reads as a stolen key, and this feature never asks for it. It also means
 * "the recipient pays no gas" must never be said on a conversion screen -- that promise belongs to
 * the claim path, and this is a sender-side step.
 *
 * ENGINE NAMING. `SwapQuote.engine` records which order book produced a price, and the screen
 * renders the name from that field rather than from a hardcoded string, so no surface can print a
 * partner's name for a quote that partner did not produce. Today there is exactly one engine: the
 * built-in Stellar DEX.
 */
import {
  Asset,
  Horizon,
  Operation,
  TransactionBuilder,
  type Transaction,
  type TransactionSource,
} from "@stellar/stellar-sdk";
import { USDC_ISSUER, type NetworkConfig, type NetworkId } from "./network";
import type { Signer } from "./signer";
import { pinnedUsdcIssuer } from "./tx-guard";

/** Which order book priced a conversion. One member today, and the label never has a default arm. */
export type SwapEngine = "sdex";

export type SwapKind = "strict-send" | "strict-receive";

export interface SwapQuote {
  engine: SwapEngine;
  /** What is spent. Always the native asset in this build. */
  sendAsset: Asset;
  /** 7dp decimal string, as Horizon renders amounts. */
  sendAmount: string;
  /** What arrives. Always the dollars THIS BUILD pins, checked on parse, never taken on trust. */
  destAsset: Asset;
  destAmount: string;
  /** The hops between them, in order. Empty is the direct case, which is what testnet returns. */
  path: Asset[];
  /** Unix ms the price was read. A price is a fact about a moment; staleness is checked, not assumed. */
  quotedAt: number;
}

/**
 * How long a quoted price may be shown before it is re-read. The re-quote is silent, but a bound
 * that has moved more than `REPRICE_TOLERANCE_BPS` from the figure the person was shown stops the
 * submit and asks for a second tap -- substituting a different transaction under someone's finger
 * is exactly what the price bound cannot protect them from.
 */
export const QUOTE_TTL_MS = 20_000;
export const REPRICE_TOLERANCE_BPS = 200;

/**
 * A fixed 0.001 XLM fee rather than BASE_FEE. The transaction carries a 45 second timebound, so a
 * busy ledger that prices this out turns the beat into `tx_too_late` instead of a conversion; ten
 * times the base fee is still a rounding error against the amount being converted.
 */
export const SWAP_FEE_STROOPS = "10000";
export const SWAP_TIMEOUT_SECONDS = 45;

/**
 * Below this there is nothing worth a transaction: the network fee and a thin book eat it, and the
 * screen says so instead of offering a button that spends more than it moves.
 */
export const MIN_CONVERT_XLM = "1";

const SCALE = 10_000_000n;
/** One base reserve on both networks today (0.5 XLM). */
const BASE_RESERVE_STROOPS = 5_000_000n;
/**
 * Kept back on top of the ledger's own minimum. It pays the fee for this transaction and the next
 * few, and it is what stops "convert everything" from leaving an account that cannot pay to move.
 */
const FEE_HEADROOM_STROOPS = 5_000_000n;

/** A 7dp decimal amount, the only shape a bound may take (see `buildSwapTx`). */
const SEVEN_DP = /^\d+\.\d{7}$/;

/** Decimal string to integer stroops. Money never crosses a module boundary as a float. */
export function toStroops(dec: string): bigint {
  const raw = (dec ?? "").trim();
  if (!/^\d+(\.\d{1,7})?$/.test(raw)) throw new Error(`not an amount this app can read: ${raw || "(empty)"}`);
  const [whole, frac = ""] = raw.split(".");
  return BigInt(whole) * SCALE + BigInt((frac + "0000000").slice(0, 7));
}

/** Integer stroops back to the 7dp string Horizon and the XDR both speak. */
export function fromStroops(s: bigint): string {
  const whole = s / SCALE;
  const frac = (s % SCALE).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}

/**
 * The same number, readable. Trailing zeros only: the value itself is never rounded for display,
 * because the figure on screen is the figure that gets signed.
 */
export function formatXlm(dec: string): string {
  const trimmed = dec.includes(".") ? dec.replace(/0+$/, "").replace(/\.$/, "") : dec;
  return trimmed || "0";
}

/** The name a screen may print for this quote's engine. No default arm, so no partner can be implied. */
export function engineLabel(quote: Pick<SwapQuote, "engine">): string {
  switch (quote.engine) {
    case "sdex":
      return "Stellar DEX";
  }
}

/**
 * Testnet books are thin, so the bound is wider there. Both figures are ours and are named on
 * screen; neither is a market convention we are borrowing.
 */
export function defaultSlippageBps(net: Pick<NetworkConfig, "isMainnet">): number {
  return net.isMainnet ? 100 : 200;
}

function assertBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > 5_000) {
    throw new Error(`that slippage is not a whole number of basis points between 0 and 5000: ${bps}`);
  }
}

/**
 * The least that may arrive for a strict-send, truncated DOWN at 7dp. Rounding up would raise the
 * floor above what the market actually offered, which turns a fill into a failure.
 */
export function floorFor(quote: Pick<SwapQuote, "destAmount">, slippageBps: number): string {
  assertBps(slippageBps);
  return fromStroops((toStroops(quote.destAmount) * BigInt(10_000 - slippageBps)) / 10_000n);
}

/**
 * The most that may be spent for a strict-receive, rounded UP at 7dp for the mirror reason: a
 * ceiling quietly lowered below the real cost refuses a conversion the person can afford.
 */
export function ceilingFor(quote: Pick<SwapQuote, "sendAmount">, slippageBps: number): string {
  assertBps(slippageBps);
  const scaled = toStroops(quote.sendAmount) * BigInt(10_000 + slippageBps);
  return fromStroops(scaled / 10_000n + (scaled % 10_000n === 0n ? 0n : 1n));
}

/** Has this price been on screen long enough that it should be read again before anything is signed? */
export function isStale(quote: Pick<SwapQuote, "quotedAt">, now: number, ttlMs = QUOTE_TTL_MS): boolean {
  return now - quote.quotedAt >= ttlMs;
}

/**
 * The re-quote decision. A silent refresh is fine while the numbers hold; once the bound has moved
 * further than the tolerance, the person is looking at a price that is no longer on offer, so the
 * screen re-renders and waits for a second tap rather than submitting something they did not see.
 */
export function repriceDecision(shownBound: string, freshBound: string, toleranceBps = REPRICE_TOLERANCE_BPS): "submit" | "reprice" {
  assertBps(toleranceBps);
  const shown = toStroops(shownBound);
  const fresh = toStroops(freshBound);
  if (shown <= 0n) return "reprice";
  const drift = fresh > shown ? fresh - shown : shown - fresh;
  return drift * 10_000n > shown * BigInt(toleranceBps) ? "reprice" : "submit";
}

/** The ledger facts a reserve calculation needs (lib/horizon.ts::loadXlmBalance reads them). */
export interface XlmHolding {
  xlm: string;
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
}

/**
 * What this account can actually spend, from the reserves the LEDGER holds against it.
 *
 * A flat buffer is wrong here, and wrong in the direction that fails on the last and most visible
 * tap. A fully sponsored Lumenia account owes nothing (its account entry and its USDC trustline are
 * both paid for by the sponsor: 2 + 1 + 0 - 3 = 0 entries of its own, verified on testnet), while
 * an account funded from an outside wallet owes 1.5 XLM for the same two things. A flat 1.0 floor
 * would offer the second account a conversion it cannot pay for, and `op_underfunded` is the
 * answer after it has been signed.
 *
 * min balance = (2 + subentries + sponsoring - sponsored) * base reserve, then half a lumen more of
 * headroom for the fee. Always a 7dp string, "0.0000000" when there is nothing to spend.
 */
export function spendableXlm(holding: XlmHolding): string {
  const entries = 2 + holding.subentryCount + holding.numSponsoring - holding.numSponsored;
  const owed = (entries > 0 ? BigInt(entries) : 0n) * BASE_RESERVE_STROOPS;
  const spendable = toStroops(holding.xlm) - owed - FEE_HEADROOM_STROOPS;
  return fromStroops(spendable > 0n ? spendable : 0n);
}

/** Is there enough here to be worth one transaction? */
export function shouldOfferConversion(spendable: string): boolean {
  return toStroops(spendable) >= toStroops(MIN_CONVERT_XLM);
}

/**
 * May a second attempt be offered yet?
 *
 * Only once the first one can no longer be included. A conversion whose answer never arrived is
 * not a conversion that did not happen, and the 45 second timebound is the only thing that turns
 * the ledger's silence into proof. Offering "Try again" inside that window is offering to convert
 * twice.
 */
export function retryAllowed(retrySafeAfter: number, now: number): boolean {
  return now > retrySafeAfter;
}

/**
 * How long to keep watching the balance after an answer that decided nothing: past the moment the
 * signed transaction dies, plus a few seconds for the ledger to close, and never less than fifty
 * seconds so a short timebound does not end the watch before anything could have landed.
 */
export function watchUntil(retrySafeAfter: number, now: number): number {
  return Math.max(retrySafeAfter + 5_000, now + 50_000);
}

/* ---------------------------------------------------------------------------------------------
 * Quotes. Two read-only Horizon endpoints, no key, no signature, nothing moved.
 * ------------------------------------------------------------------------------------------ */

interface PathAssetRecord {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

interface PathRecord extends PathAssetRecord {
  source_asset_type?: string;
  source_amount?: string;
  destination_asset_type?: string;
  destination_asset_code?: string;
  destination_asset_issuer?: string;
  destination_amount?: string;
  path?: PathAssetRecord[];
}

function toAsset(record: PathAssetRecord): Asset {
  if (record.asset_type === "native") return Asset.native();
  if (!record.asset_code || !record.asset_issuer) throw new Error("that price names an asset this app cannot read");
  return new Asset(record.asset_code, record.asset_issuer);
}

/**
 * Turn one Horizon path record into a quote, or reject it.
 *
 * The asset is checked against the issuer THIS BUILD pins, not against whatever the record names.
 * A path endpoint that answered with a look-alike USDC would otherwise pick which token the
 * account ends up holding, and the rail that has to settle it would then refuse the lot.
 */
function readRecord(record: PathRecord, net: NetworkConfig, now: number): SwapQuote | null {
  const pinned = USDC_ISSUER[net.id];
  if (record.source_asset_type !== "native") return null;
  if (record.destination_asset_code !== "USDC" || record.destination_asset_issuer !== pinned) return null;
  if (!record.source_amount || !record.destination_amount) return null;
  try {
    return {
      engine: "sdex",
      sendAsset: Asset.native(),
      sendAmount: record.source_amount,
      destAsset: new Asset("USDC", pinned),
      destAmount: record.destination_amount,
      // Order is the route. A reordered path is a different trade, so the records map one by one.
      path: (record.path ?? []).map(toAsset),
      quotedAt: now,
    };
  } catch {
    return null;
  }
}

async function readPaths(url: string, fetchImpl: typeof fetch): Promise<PathRecord[]> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`could not read a price right now (${res.status})`);
  const body = (await res.json()) as { _embedded?: { records?: PathRecord[] } };
  return body._embedded?.records ?? [];
}

export interface QuoteOptions {
  now?: number;
  fetchImpl?: typeof fetch;
}

/**
 * "Convert what I have": spend an exact amount of XLM, take whatever dollars it buys, never fewer
 * than the floor. The best record is the one that returns the most dollars for the same lumens.
 * `null` means the order book has nothing to offer, which is an honest empty, not an error.
 */
export async function quoteStrictSend(net: NetworkConfig, sendXlm: string, opts: QuoteOptions = {}): Promise<SwapQuote | null> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url =
    `${net.horizonUrl.replace(/\/$/, "")}/paths/strict-send` +
    `?source_asset_type=native&source_amount=${encodeURIComponent(sendXlm)}` +
    `&destination_assets=${encodeURIComponent(`USDC:${USDC_ISSUER[net.id]}`)}`;
  const quotes = (await readPaths(url, fetchImpl))
    .map((r) => readRecord(r, net, now))
    .filter((q): q is SwapQuote => q !== null);
  return quotes.reduce<SwapQuote | null>(
    (best, q) => (best === null || toStroops(q.destAmount) > toStroops(best.destAmount) ? q : best),
    null,
  );
}

/**
 * "Reach exactly this many dollars": the rail needs a figure, so the dollars are fixed and the
 * lumens are what varies, capped by the ceiling. The best record is the one that costs the least.
 */
export async function quoteStrictReceive(net: NetworkConfig, destUsd: string, opts: QuoteOptions = {}): Promise<SwapQuote | null> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url =
    `${net.horizonUrl.replace(/\/$/, "")}/paths/strict-receive` +
    `?destination_asset_type=credit_alphanum4&destination_asset_code=USDC` +
    `&destination_asset_issuer=${encodeURIComponent(USDC_ISSUER[net.id])}` +
    `&destination_amount=${encodeURIComponent(destUsd)}&source_assets=native`;
  const quotes = (await readPaths(url, fetchImpl))
    .map((r) => readRecord(r, net, now))
    .filter((q): q is SwapQuote => q !== null);
  return quotes.reduce<SwapQuote | null>(
    (best, q) => (best === null || toStroops(q.sendAmount) < toStroops(best.sendAmount) ? q : best),
    null,
  );
}

/* ---------------------------------------------------------------------------------------------
 * Building, and the guard on what comes back signed.
 * ------------------------------------------------------------------------------------------ */

export interface SwapBuildInput {
  net: NetworkConfig;
  /** The loaded source account. Its own key signs and its own XLM pays the fee. */
  source: TransactionSource;
  /** Where the dollars land. It is the same account, always -- a conversion is not a transfer. */
  destination: string;
  quote: SwapQuote;
  kind: SwapKind;
  /** `destMin` for a strict-send, `sendMax` for a strict-receive. Never optional in practice. */
  bound?: string;
  /** Strict-receive only: the exact dollars asked for. Defaults to the quoted figure. */
  destAmount?: string;
}

export interface SwapBuild {
  tx: Transaction;
  /** The bound as the operation carries it -- what the submit-time guard compares against. */
  bound: string;
  /**
   * Unix ms after which this signed conversion can no longer be included, so the ledger's silence
   * stops meaning "not yet" and starts meaning "never". Same doctrine as lib/payout.ts: until this
   * moment passes, a second attempt could be a second conversion.
   */
  retrySafeAfter: number;
}

/** One conversion, one operation, one bound. */
export function buildSwapTx(input: SwapBuildInput): SwapBuild {
  const { net, source, destination, quote, kind } = input;
  const self = source.accountId();

  // A conversion pays the account it spends from. If a future edit ever plumbs a destination
  // through the UI, it fails here rather than shipping a transfer dressed as a conversion.
  if (destination !== self) throw new Error("a conversion pays the same account it spends from");

  const bound = input.bound;
  const boundName = kind === "strict-send" ? "destMin" : "sendMax";
  // The one rule that cannot be regressed: no conversion is ever built without a bound. The 7dp
  // shape is part of it, because the submit-time guard compares the bound byte for byte against
  // what the XDR carries, and only a 7dp string survives that round trip unchanged.
  if (!bound || !SEVEN_DP.test(bound)) {
    throw new Error(`a conversion is never built without a ${boundName} bound at 7 decimal places`);
  }

  // The dollars are this build's, never the quote's word for them.
  const pinned = pinnedUsdcIssuer(net.id);
  if (!quote.sendAsset.isNative()) throw new Error("this conversion spends XLM and nothing else");
  if (quote.destAsset.getCode() !== "USDC" || quote.destAsset.getIssuer() !== pinned) {
    throw new Error("that price is for a different dollar than this app moves");
  }

  const op =
    kind === "strict-send"
      ? Operation.pathPaymentStrictSend({
          sendAsset: quote.sendAsset,
          sendAmount: quote.sendAmount,
          destination: self,
          destAsset: quote.destAsset,
          destMin: bound,
          path: quote.path,
          source: self,
        })
      : Operation.pathPaymentStrictReceive({
          sendAsset: quote.sendAsset,
          sendMax: bound,
          destination: self,
          destAsset: quote.destAsset,
          destAmount: input.destAmount ?? quote.destAmount,
          path: quote.path,
          source: self,
        });

  const tx = new TransactionBuilder(source, { fee: SWAP_FEE_STROOPS, networkPassphrase: net.passphrase })
    .addOperation(op)
    .setTimeout(SWAP_TIMEOUT_SECONDS)
    .build();

  const retrySafeAfter = Number(tx.timeBounds?.maxTime ?? 0) * 1000 || Number.POSITIVE_INFINITY;
  return { tx, bound, retrySafeAfter };
}

const REFUSED = "That isn't the conversion this screen built, so nothing was submitted.";

/**
 * What this device is willing to submit, checked on the transaction that came BACK from the signer.
 *
 * This is not paranoia about our own code. `Signer.sign` returns the transaction, and an
 * external-wallet signer signs a COPY -- XDR in, XDR out -- so asserting the destination only on
 * the operation we built leaves a blind signature on whatever the wallet chose to hand back. This
 * is the one path in the feature where money could reach a third party rather than merely fail, so
 * it is the one path with a guard, modelled on lib/tx-guard.ts.
 */
export function assertIsOwnConversion(
  tx: Transaction,
  expect: { self: string; net: NetworkId; bound: string; kind: SwapKind },
): void {
  if (tx.source !== expect.self) throw new Error(REFUSED);
  if (tx.operations.length !== 1) throw new Error(REFUSED);
  // Exactly the account's own signature. Anything extra is a transaction somebody else has also
  // had an opinion about, and this one moves money.
  if (tx.signatures.length !== 1) throw new Error(REFUSED);
  // A memo is meaningless on a conversion to self and is how an exchange-bound payment would be
  // dressed up as one. There is nothing to say to ourselves.
  if (tx.memo?.type !== "none") throw new Error(REFUSED);
  if (!tx.timeBounds?.maxTime) throw new Error(REFUSED);

  const op = tx.operations[0] as Record<string, unknown> & { type: string; source?: string };
  const wanted = expect.kind === "strict-send" ? "pathPaymentStrictSend" : "pathPaymentStrictReceive";
  if (op.type !== wanted) throw new Error(REFUSED);
  if ((op.source ?? tx.source) !== expect.self) throw new Error(REFUSED);
  if (op.destination !== expect.self) throw new Error(REFUSED);

  const sendAsset = op.sendAsset as Asset | undefined;
  const destAsset = op.destAsset as Asset | undefined;
  if (!sendAsset || !sendAsset.isNative()) throw new Error(REFUSED);
  // Compile-time constant, never a value off the wire -- the same rule lib/tx-guard.ts enforces.
  if (!destAsset || destAsset.getCode() !== "USDC" || destAsset.getIssuer() !== pinnedUsdcIssuer(expect.net)) {
    throw new Error(REFUSED);
  }

  const carried = expect.kind === "strict-send" ? op.destMin : op.sendMax;
  if (carried !== expect.bound) throw new Error(REFUSED);
}

/* ---------------------------------------------------------------------------------------------
 * Failures, named.
 * ------------------------------------------------------------------------------------------ */

export type SwapFailureKind =
  /** The book moved between the quote and the ledger. The bound did its job; nothing settled. */
  | "price-moved"
  /** Nothing to trade against right now. */
  | "no-market"
  /** The account is not on the ledger. */
  | "no-destination"
  /** Not enough XLM left for the amount plus the fee. */
  | "not-enough-xlm"
  /** The signature was not accepted -- unlock and sign again. */
  | "needs-unlock"
  /** The signed transaction outlived its 45 second window. Nothing moved. */
  | "expired"
  /** No dollar trustline on this account. One sponsored repair fixes it. */
  | "no-trustline"
  /** The dollars would overflow the trustline's limit. */
  | "line-full"
  /** The conversion would have crossed the account's own offer. */
  | "crossed-self"
  /**
   * The ledger did not rule, so neither do we. This is the only kind a screen answers by LOOKING
   * (watch the balance) rather than by saying; never reported as either success or failure.
   */
  | "undecided"
  /** A result code we do not know. Terminal, and never rendered as success. */
  | "unknown";

export interface SwapFailure {
  kind: SwapFailureKind;
  /** Whether tapping again could plausibly end differently. */
  terminal: boolean;
  /** One sentence, safe to display. */
  message: string;
  /** What the screen can offer, when anything can be offered. */
  action?: "repair-trustline" | "unlock" | "check-balance";
}

/**
 * Flatten whatever was thrown into one string, the way lib/claim-error.ts does. The SDK hangs
 * Horizon's `extras.result_codes` off the error's `response.data`, and the shape has moved between
 * releases, so reading one path would go quiet on the next bump.
 */
function flatten(err: unknown): string {
  const parts: string[] = [];
  const push = (s: string) => {
    if (s && !parts.includes(s)) parts.push(s);
  };
  try {
    if (err instanceof Error) push(err.message);
    const any = err as { message?: string; response?: { status?: number; data?: unknown } };
    if (typeof any?.message === "string") push(any.message);
    if (any?.response?.status) push(`status:${any.response.status}`);
    if (any?.response?.data !== undefined) push(JSON.stringify(any.response.data));
    if (parts.length === 0) push(String(err));
  } catch {
    /* a value that resists both String() and JSON -- use whatever was collected */
  }
  return parts.join(" ").slice(0, 2000);
}

/**
 * Why a conversion failed, in words a person can act on.
 *
 * Two spellings are accepted for the price bounds on purpose: the protocol names them
 * UNDER_DESTMIN and OVER_SENDMAX while Horizon publishes them as `op_under_dest_min` and
 * `op_over_source_max`. A code that matched neither would fall through to `unknown`, which is safe
 * but silent, and "the price moved, nothing was spent" is the one failure here that has a good
 * next step.
 */
export function classifySwapFailure(err: unknown): SwapFailure {
  const blob = flatten(err);

  if (/tx_bad_auth/i.test(blob)) {
    return { kind: "needs-unlock", terminal: true, message: "This phone couldn't sign that. Unlock and try again.", action: "unlock" };
  }
  if (/op_under_dest_?min|op_over_(source|send)_?max/i.test(blob)) {
    return {
      kind: "price-moved",
      terminal: false,
      message: "The price moved while you were tapping. Nothing moved and nothing was spent beyond the network fee. Try again.",
    };
  }
  if (/op_too_few_offers/i.test(blob)) {
    return { kind: "no-market", terminal: true, message: "There is no market for this right now. Nothing moved." };
  }
  if (/op_no_destination/i.test(blob)) {
    return { kind: "no-destination", terminal: true, message: "This account isn't on the ledger yet, so nothing could land in it." };
  }
  if (/op_src_no_trust|op_no_trust/i.test(blob)) {
    return {
      kind: "no-trustline",
      terminal: true,
      message: "This account can't hold dollars yet. Open the dollar line first, then convert.",
      action: "repair-trustline",
    };
  }
  if (/op_line_full/i.test(blob)) {
    return { kind: "line-full", terminal: true, message: "This account can't hold that many dollars. Nothing moved." };
  }
  if (/op_cross_self/i.test(blob)) {
    return { kind: "crossed-self", terminal: false, message: "That would have traded against your own offer. Nothing moved." };
  }
  if (/op_underfunded|tx_insufficient_balance/i.test(blob)) {
    return { kind: "not-enough-xlm", terminal: true, message: "Not enough XLM left to cover the amount and the network fee." };
  }
  if (/tx_too_late/i.test(blob)) {
    return { kind: "expired", terminal: false, message: "That took too long and expired. Nothing moved. Try again." };
  }
  // No result code at all means no verdict: a dropped request, a dead edge, a timeout. The
  // transaction may still be landing, so this is answered by watching the balance, never by a
  // sentence that says where the money is.
  if (!/result_codes|op_[a-z_]+|tx_[a-z_]+/i.test(blob)) {
    return {
      kind: "undecided",
      terminal: false,
      message: "We lost the connection while that was going through. Checking what landed.",
      action: "check-balance",
    };
  }
  return { kind: "unknown", terminal: true, message: "That didn't go through, and nothing moved." };
}

/* ---------------------------------------------------------------------------------------------
 * The one path that submits.
 * ------------------------------------------------------------------------------------------ */

export interface ConversionOutcome {
  hash: string;
  retrySafeAfter: number;
}

export interface ConversionInput {
  net: NetworkConfig;
  signer: Signer;
  quote: SwapQuote;
  kind: SwapKind;
  bound: string;
  /** Strict-receive only: the exact dollars asked for. */
  destAmount?: string;
  /**
   * Called with the conversion's identity the moment it exists and BEFORE it is submitted, so a
   * caller that writes it down can ask the ledger what became of it after a reload or a lost
   * connection, instead of assuming nothing happened. Same reasoning as lib/payout.ts.
   */
  onHandedOver?: (c: ConversionOutcome) => void;
}

/**
 * Build, sign, check what came back, submit. The guard lives HERE rather than in the screen: this
 * is the only function that submits, so a caller cannot forget it.
 */
export async function runConversion(input: ConversionInput): Promise<ConversionOutcome> {
  const { net, signer, quote, kind, bound } = input;
  const self = signer.publicKey();
  const server = new Horizon.Server(net.horizonUrl);
  const source = await server.loadAccount(self);

  const built = buildSwapTx({ net, source, destination: self, quote, kind, bound, destAmount: input.destAmount });
  // The transaction the signer hands back is the one that gets submitted -- an external wallet
  // signs a copy, so the one we built is not necessarily the one that would go.
  const signed = await signer.sign(built.tx);
  assertIsOwnConversion(signed, { self, net: net.id, bound, kind });

  const outcome = { hash: signed.hash().toString("hex"), retrySafeAfter: built.retrySafeAfter };
  input.onHandedOver?.(outcome);

  const res = await server.submitTransaction(signed);
  return { hash: (res as { hash: string }).hash, retrySafeAfter: built.retrySafeAfter };
}
