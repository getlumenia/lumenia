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
import { ACTIVE } from "./network";

const HORIZON_URL = ACTIVE.horizonUrl;
const NETWORK = ACTIVE.passphrase;

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
  const server = new Horizon.Server(HORIZON_URL);
  const claimKey = Keypair.fromSecret(bearerSecret);
  const pub = claimKey.publicKey();
  const base = sponsorUrl.replace(/\/$/, "");

  // 1. Sponsor creates the 0-XLM account + USDC trustline; the bearer key co-signs.
  const created = (await postJson(`${base}/create-account`, { recipientPublicKey: pub })) as { xdr: string };
  const sandwich = TransactionBuilder.fromXDR(created.xdr, NETWORK) as Transaction;
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
