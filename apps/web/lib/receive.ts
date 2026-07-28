/**
 * Receiving money INTO your account — the inbound twin of lib/payout.ts, and the exact inverse of
 * everything that file teaches.
 *
 * The correction this module exists to encode: an exchange needs a MEMO because thousands of its
 * customers share ONE deposit account, and the memo is the only thing that says which of them a
 * transfer belongs to. Lumenia does not work that way. Every user gets their own Stellar account,
 * created and funded for them (apps/sponsor/src/lib/create-account.ts). Nobody has to say which
 * one is yours, because nobody else is in it. So money coming IN needs no memo at all, and a
 * screen asking for one should be left blank.
 *
 * That is stated as a reason rather than a rule, because a reason stays true when the product
 * changes and a rule quietly rots.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { USDC_ISSUER } from "./network";

export interface ReceiveUriOpts {
  address: string;
  assetCode: string;
  assetIssuer: string;
  /** optional: pre-fill an amount in a scanning wallet */
  amount?: string;
  /** optional: a short human note the sender's wallet may show */
  msg?: string;
}

/**
 * The SEP-7 `web+stellar:pay` URI naming THIS account and THIS exact dollar asset.
 *
 * Why a URI and not just the address in the QR: a bare address says where, not what. A wallet
 * scanning it can send XLM, or a look-alike token that merely calls itself USDC, to a perfectly
 * correct address — and the money is then somewhere the app cannot show. Pinning the code AND the
 * issuer removes that whole class of mistake for anyone scanning with a real wallet.
 *
 * A memo is NEVER set here. That absence is the invariant of this entire screen, and
 * receive.selftest.ts asserts it rather than trusting anyone to remember.
 */
export function buildReceiveUri(opts: ReceiveUriOpts): string {
  const q = new URLSearchParams();
  q.set("destination", opts.address);
  q.set("asset_code", opts.assetCode);
  q.set("asset_issuer", opts.assetIssuer);
  if (opts.amount) q.set("amount", opts.amount);
  if (opts.msg) q.set("msg", opts.msg);
  return `web+stellar:pay?${q.toString()}`;
}

/**
 * Are the dollars we hold Circle's real USDC, or our own practice asset?
 *
 * Derived from the issuer the sponsor reports at /health, compared against the known mainnet
 * issuer — NOT from a build flag. That matters: the day the sponsor is repointed at mainnet this
 * screen starts telling the truth on its own, with no code change and no chance of a stale flag
 * claiming real money that isn't there. An unrecognised issuer resolves to "test", because the
 * failure that costs someone money is claiming real when it isn't.
 */
export function moneyOrigin(usdcIssuer: string | null | undefined): "real" | "test" {
  return usdcIssuer && usdcIssuer === USDC_ISSUER.public ? "real" : "test";
}

/**
 * The network in the words an exchange's own dropdown uses. Naming it is the same deliberate
 * vocabulary exception /send-out makes: the rule is there to keep jargon out of money screens, and
 * it does not survive contact with a case where getting the name wrong destroys the transfer.
 */
export const NETWORK_LABEL: Record<"real" | "test", string> = {
  real: "Stellar (XLM)",
  test: "Stellar test network",
};

/** Shared with /send's faucet button so the two call sites cannot drift apart. */
export async function getTestMoney(sponsorUrl: string, address: string): Promise<void> {
  const res = await fetch(`${sponsorUrl.replace(/\/$/, "")}/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipientPublicKey: address }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? "Couldn't get test money right now.");
  }
}

/** A short, readable form of an address for confirmation lines. Never the thing you copy. */
export function shortAddress(address: string): string {
  return StrKey.isValidEd25519PublicKey(address)
    ? `${address.slice(0, 6)}…${address.slice(-6)}`
    : address;
}
