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
import { assertHealthMatchesPin, pinnedUsdcIssuer } from "./tx-guard";

const RECLAIM_AFTER_SECONDS = (7 * 24 * 60 * 60).toString(); // money comes back after 7 days

export interface SendResult {
  link: string;
  balanceId: string;
  hash: string;
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
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

  const res = (await postJson(`${base}/send-link`, {
    xdr: inner.toXDR(),
    senderPublicKey: sender,
  })) as { hash: string; balanceId: string };

  return { hash: res.hash, balanceId: res.balanceId, usdcIssuer: issuer };
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
  const query = `a=${encodeURIComponent(opts.amount)}&s=${encodeURIComponent(opts.from)}&b=${res.balanceId}&i=${res.usdcIssuer}`;
  const link = `${opts.webOrigin.replace(/\/$/, "")}/c/${id}?${query}#${bearer.secret()}`;
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
