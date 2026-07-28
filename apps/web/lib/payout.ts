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
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { Signer } from "./signer";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK = Networks.TESTNET;

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
 * Send dollars out: one sender-signed `payment` with the memo attached, fee-bumped by
 * the sponsor so a 0-XLM user can still move their own money. The sponsor's /payout
 * policy re-checks the destination and amount against what we declare here, so a
 * mismatch between the signed bytes and the request is rejected rather than submitted.
 */
export async function sendOut(opts: PayoutInput): Promise<PayoutResult> {
  const base = opts.sponsorUrl.replace(/\/$/, "");
  const health = (await (await fetch(`${base}/health`)).json()) as {
    usdcIssuer: string;
    usdcCode: string;
  };
  const USDC = new Asset(health.usdcCode, health.usdcIssuer);
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

  const res = await fetch(`${base}/payout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      xdr: inner.toXDR(),
      senderPublicKey: sender,
      destination: opts.destination,
      amount: opts.amount,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`/payout → ${res.status}: ${text}`);
  return JSON.parse(text) as PayoutResult;
}
