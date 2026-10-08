/**
 * Client-side onward-send — the second turn of the loop (Stage 5). A recipient who
 * claimed holds a sponsored 0-XLM account with USDC; to send onward they create a
 * dual-predicate Claimable Balance. Since they hold 0 XLM, the sponsor sponsors the
 * reserve (begin/end sandwich) and fee-bumps — proven by Spike #5.
 *
 * The client builds + signs the send inner tx (create + end, sender-sourced; the
 * begin op is sponsor-sourced and gets the sponsor's signature server-side), POSTs
 * it to /send-link, and builds the claim link from the returned balanceId + a fresh
 * bearer key. No seed leaves the Signer.
 *
 * Request money (REQUEST_MONEY.md §10) adds `payToAddress`: the SAME sponsored-CB
 * shape, but the unconditional claimant is the ASKER'S ADDRESS instead of a fresh
 * bearer key — so there is no link and no secret; the asker collects it on /home
 * with her own account. The /send-link policy accepts this unchanged (Spike #6).
 */
import {
  Asset,
  BASE_FEE,
  Claimant,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { Signer } from "./signer";
import { activeNetwork } from "./network";
import { claimFragment } from "./link-fragment";
import { assertHealthMatchesPin, pinnedUsdcIssuer } from "./tx-guard";
import { UnconfirmedSubmitError, isUnconfirmedSubmit, signedFacts, throwIfUnconfirmed, type SignedFacts } from "./unconfirmed";

const RECLAIM_AFTER_SECONDS = (7 * 24 * 60 * 60).toString(); // money comes back after 7 days

export interface SendResult {
  link: string;
  balanceId: string;
  hash: string;
}

/**
 * A payment the sponsor accepted and never saw decided (its 202), or whose reply never came back.
 *
 * The send used to read the 202 as a success: its body carries no balance id, so the screen crashed
 * on it and said "Your money hasn't moved. Try again", and a person who did that could pay twice.
 * The claimable balance this payment creates has an id fixed by the transaction itself (its source
 * account, sequence number and operation index), so it is computed before the POST and travels on
 * the error: if the payment lands, the screen can still name it.
 */
export class SendUnconfirmedError extends UnconfirmedSubmitError {
  constructor(
    base: UnconfirmedSubmitError,
    /** the id of the claimable balance this payment creates, if it lands */
    readonly balanceId: string,
  ) {
    super(base.route, base.hash, base.signed);
    this.name = "SendUnconfirmedError";
  }
}

async function postJson(url: string, body: unknown, signed?: SignedFacts): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    /* A request carrying a signed payment that got no answer may still have been submitted: the
       connection can drop after the sponsor took it. Only the ledger can say which, so it is the
       same undecided outcome as a 202, settled by the same reads. */
    if (signed) throw new UnconfirmedSubmitError(new URL(url).pathname, "", signed);
    throw e;
  }
  const text = await res.text();
  throwIfUnconfirmed(res.status, text, new URL(url).pathname, signed ?? null);
  if (!res.ok) throw new Error(`${new URL(url).pathname} → ${res.status}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * The shared sponsored-CB submit: build the begin/create/end inner tx with
 * [claimantDestination: unconditional, sender: reclaim-7d], sign, POST /send-link.
 * Exactly the shape the sponsor's send policy pins (2 claimants, unconditional +
 * sender-reclaim) — for both the bearer-link send and the pay-to-address send.
 */
async function submitSponsoredCB(opts: {
  sponsorUrl: string;
  signer: Signer;
  amount: string;
  claimantDestination: string;
}): Promise<{ hash: string; balanceId: string; usdcIssuer: string }> {
  const net = activeNetwork();
  const { horizonUrl: HORIZON_URL, passphrase: NETWORK } = net;
  const base = opts.sponsorUrl.replace(/\/$/, "");
  // Pinned, not reported: the sender is signing away real dollars here, so the asset is a
  // compile-time constant and /health only gets to disagree loudly.
  const health = (await (await fetch(`${base}/health`)).json()) as {
    sponsorPublicKey: string;
    usdcIssuer: string;
    usdcCode: string;
  };
  assertHealthMatchesPin(health, net.id);
  const issuer = pinnedUsdcIssuer(net.id);
  const USDC = new Asset("USDC", issuer);
  const sender = opts.signer.publicKey();

  const server = new Horizon.Server(HORIZON_URL);
  const acc = await server.loadAccount(sender);
  const claimants = [
    new Claimant(opts.claimantDestination, Claimant.predicateUnconditional()),
    new Claimant(sender, Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(RECLAIM_AFTER_SECONDS))),
  ];
  const inner = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: sender, source: health.sponsorPublicKey }))
    .addOperation(Operation.createClaimableBalance({ asset: USDC, amount: opts.amount, claimants, source: sender }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: sender }))
    .setTimeout(180)
    .build();
  await opts.signer.sign(inner); // sender signs create + end

  // Fixed by the transaction itself, so it is known before the reply (see SendUnconfirmedError).
  // Index 1 is the createClaimableBalance op, the shape the sponsor's send policy pins.
  const expectedId = inner.getClaimableBalanceId(1);
  let res: { hash: string; balanceId: string };
  try {
    res = (await postJson(
      `${base}/send-link`,
      { xdr: inner.toXDR(), senderPublicKey: sender },
      signedFacts(inner),
    )) as { hash: string; balanceId: string };
  } catch (e) {
    if (isUnconfirmedSubmit(e)) throw new SendUnconfirmedError(e, expectedId);
    throw e;
  }

  return { hash: res.hash, balanceId: res.balanceId || expectedId, usdcIssuer: issuer };
}

export async function createSendLink(opts: {
  sponsorUrl: string;
  signer: Signer;
  /** amount of USDC to send (the sender's own balance) */
  amount: string;
  /** the sender's display name — shown as "<from> sent you money" on the claim page */
  from: string;
  /** origin to build the claim link against (e.g. window.location.origin) */
  webOrigin: string;
}): Promise<SendResult> {
  const bearer = Keypair.random();
  const res = await submitSponsoredCB({
    sponsorUrl: opts.sponsorUrl,
    signer: opts.signer,
    amount: opts.amount,
    claimantDestination: bearer.publicKey(),
  });

  const id = res.balanceId.slice(-8);
  // Private shape (D2): the claim page reads the amount from the ledger by `b`, so the URL carries
  // none, and the name rides behind the key in the fragment, which no request ever sends.
  const query = `b=${res.balanceId}&i=${res.usdcIssuer}`;
  const link = `${opts.webOrigin.replace(/\/$/, "")}/c/${id}?${query}#${claimFragment({ key: bearer.secret(), from: opts.from })}`;
  return { link, balanceId: res.balanceId, hash: res.hash };
}

export interface PayResult {
  balanceId: string;
  hash: string;
}

/**
 * Pay a returning asker's request straight to her ADDRESS. No bearer key, no link,
 * no secret — she collects it on /home. The payer keeps the same 7-day reclaim as
 * every send ("if it isn't collected, it comes back to you").
 */
export async function payToAddress(opts: {
  sponsorUrl: string;
  signer: Signer;
  amount: string;
  /** the asker's account address (the request link's `to` param, validated). */
  to: string;
}): Promise<PayResult> {
  const res = await submitSponsoredCB({
    sponsorUrl: opts.sponsorUrl,
    signer: opts.signer,
    amount: opts.amount,
    claimantDestination: opts.to,
  });
  return { balanceId: res.balanceId, hash: res.hash };
}
