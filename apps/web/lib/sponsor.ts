/**
 * Client-side claim flow — the browser equivalent of the sponsor CLI.
 *
 * Runs entirely on the recipient's device: the bearer key (from the link's
 * #fragment) signs; the sponsor service only sponsors the account and fee-bumps.
 * The recipient holds 0 XLM throughout. Mirrors apps/sponsor/src/cli/claim.ts so
 * the same proven endpoint calls run in a real browser.
 */
import {
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { activeNetwork } from "./network";
import type { Signer } from "./signer";
import { assertSponsoredOnboarding, assertSponsoredTrustline } from "./tx-guard";

export interface ClaimParams {
  sponsorUrl: string;
  /** S... bearer key from the link's #fragment (never leaves the client). */
  bearerSecret: string;
  balanceId: string;
}

export interface ClaimOutcome {
  hash: string;
  publicKey: string;
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

export async function runClaim({ sponsorUrl, bearerSecret, balanceId }: ClaimParams): Promise<ClaimOutcome> {
  const net = activeNetwork();
  const { horizonUrl: HORIZON_URL, passphrase: NETWORK } = net;
  const server = new Horizon.Server(HORIZON_URL);
  const claimKey = Keypair.fromSecret(bearerSecret);
  const pub = claimKey.publicKey();
  const base = sponsorUrl.replace(/\/$/, "");

  // 1. Sponsor creates the 0-XLM account + USDC trustline; the bearer key co-signs.
  const created = (await postJson(`${base}/create-account`, { recipientPublicKey: pub })) as { xdr: string };
  const sandwich = TransactionBuilder.fromXDR(created.xdr, NETWORK) as Transaction;
  assertSponsoredOnboarding(sandwich, pub, net.id);
  sandwich.sign(claimKey);
  await server.submitTransaction(sandwich);

  // 2. Build + sign the claim; the sponsor anti-drain-validates + fee-bumps it.
  const acc = await server.loadAccount(pub);
  const inner = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(180)
    .build();
  inner.sign(claimKey);
  const feebump = (await postJson(`${base}/feebump`, {
    xdr: inner.toXDR(),
    recipientPublicKey: pub,
    balanceId,
  })) as { hash: string };

  return { hash: feebump.hash, publicKey: pub };
}

/**
 * Prepare an existing wallet's account to hold real dollars — the create-account half of runClaim,
 * on its own. The sponsor opens a 0-XLM account with a USDC trustline (its own reserve), the
 * account's OWN key co-signs the trustline op, and it submits. This lets an approved mainnet user
 * bring dollars in from an outside wallet — which needs the trustline to already exist — without
 * first having to receive a Lumenia link. The account holds 0 XLM; the sponsor covers reserve + fee.
 */
export async function prepareAccount({
  sponsorUrl,
  signer,
}: {
  sponsorUrl: string;
  signer: Signer;
}): Promise<{ hash: string }> {
  const net = activeNetwork();
  const { horizonUrl: HORIZON_URL, passphrase: NETWORK } = net;
  const server = new Horizon.Server(HORIZON_URL);
  const base = sponsorUrl.replace(/\/$/, "");
  const created = (await postJson(`${base}/create-account`, {
    recipientPublicKey: signer.publicKey(),
  })) as { xdr: string };
  const sandwich = TransactionBuilder.fromXDR(created.xdr, NETWORK) as Transaction;
  /* This key holds the user's real balance — never sign a server-built tx unexamined.
   *
   * TWO legitimate shapes here, and the op count tells them apart without trusting a field the
   * server chose: four ops when the account has to be created, three when it already exists and
   * only needs the trustline (an account funded from outside, or one that lost its line). Each is
   * checked in full by its own assertion — this is a choice of WHICH contract to enforce, never a
   * relaxation of either. `prepareAccount` is the only caller that may accept the shorter one; the
   * claim paths keep demanding the four-op sandwich, because a claim's account is always new. */
  if (sandwich.operations.length === 3) {
    assertSponsoredTrustline(sandwich, signer.publicKey(), net.id);
  } else {
    assertSponsoredOnboarding(sandwich, signer.publicKey(), net.id);
  }
  await signer.sign(sandwich);
  const res = await server.submitTransaction(sandwich);
  return { hash: (res as { hash: string }).hash };
}
