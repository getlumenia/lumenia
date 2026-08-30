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
import { activeNetwork, type NetworkConfig } from "./network";
import type { Signer } from "./signer";
import { assertSponsoredOnboarding, assertSponsoredTrustline, pinnedUsdcIssuer } from "./tx-guard";

export interface ClaimParams {
  sponsorUrl: string;
  /** S... bearer key from the link's #fragment (never leaves the client). */
  bearerSecret: string;
  balanceId: string;
  /**
   * The chain the LINK lives on — passed in, never read off the device. A claim link is minted on
   * one network and is claimable only there, so a device switched to another one must still build
   * this claim against the ledger holding the money.
   */
  network: NetworkConfig;
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

/**
 * The account as the LEDGER has it, or null when Horizon says it is not there. Anything other than
 * a 404 is rethrown: "we could not ask" must never be read as "it does not exist".
 */
async function loadIfPresent(
  server: Horizon.Server,
  pub: string,
): Promise<Awaited<ReturnType<Horizon.Server["loadAccount"]>> | null> {
  try {
    return await server.loadAccount(pub);
  } catch (e) {
    if ((e as { response?: { status?: number } })?.response?.status === 404) return null;
    throw e;
  }
}

/** Does this account already trust the dollar this build escrows? */
function trustsPinnedUsdc(balances: unknown[], issuer: string): boolean {
  return balances.some((entry) => {
    const line = entry as { asset_code?: string; asset_issuer?: string };
    return line.asset_code === "USDC" && line.asset_issuer === issuer;
  });
}

/* Worded so lib/claim-error.ts classifies it with the tx-guard refusals — terminal, no retry. */
const NOT_ON_LEDGER = "The server described an account that is not on the ledger, so nothing was signed.";

export async function runClaim({
  sponsorUrl,
  bearerSecret,
  balanceId,
  network: net,
}: ClaimParams): Promise<ClaimOutcome> {
  const { horizonUrl: HORIZON_URL, passphrase: NETWORK } = net;
  const server = new Horizon.Server(HORIZON_URL);
  const claimKey = Keypair.fromSecret(bearerSecret);
  const pub = claimKey.publicKey();
  const base = sponsorUrl.replace(/\/$/, "");

  // 1. Sponsor creates the 0-XLM account + USDC trustline; the bearer key co-signs.
  const created = (await postJson(`${base}/create-account`, { recipientPublicKey: pub })) as { xdr: string };
  const sandwich = TransactionBuilder.fromXDR(created.xdr, NETWORK) as Transaction;
  /* TWO legitimate shapes, because the sponsor asks the ledger whether this account is already
   * there: four ops to create it, three when it exists and only needs the trustline. A claim
   * reaches the three-op case whenever a first tap onboarded the account and step 2 then failed —
   * demanding four ops on that retry refuses forever and the link can never be claimed.
   *
   * The shorter shape is accepted only when its precondition holds, and that is confirmed against
   * the ledger rather than against the server that chose it; each shape is then asserted in full by
   * its own guard. This is a choice of WHICH contract to enforce, never a relaxation of either. */
  let onboardingNeeded = true;
  if (sandwich.operations.length === 3) {
    const existing = await loadIfPresent(server, pub);
    if (!existing) throw new Error(NOT_ON_LEDGER);
    if (trustsPinnedUsdc(existing.balances, pinnedUsdcIssuer(net.id))) onboardingNeeded = false;
    else assertSponsoredTrustline(sandwich, pub, net.id);
  } else {
    assertSponsoredOnboarding(sandwich, pub, net.id);
  }
  if (onboardingNeeded) {
    sandwich.sign(claimKey);
    await server.submitTransaction(sandwich);
  }

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
   * relaxation of either. */
  if (sandwich.operations.length === 3) {
    assertSponsoredTrustline(sandwich, signer.publicKey(), net.id);
  } else {
    assertSponsoredOnboarding(sandwich, signer.publicKey(), net.id);
  }
  await signer.sign(sandwich);
  const res = await server.submitTransaction(sandwich);
  return { hash: (res as { hash: string }).hash };
}
