/**
 * Client-side consolidation — the "one wallet" sweep (RECOVERY_ARCHITECTURE §3.2;
 * proven on-chain by Spike #7). Each claim link carries its OWN bearer key, so a
 * returning claim lands the money in a fresh per-link THROWAWAY account. This sweeps
 * that throwaway into the user's ONE persistent home account and closes it, in a
 * single transaction the throwaway sources itself and the sponsor fee-bumps.
 *
 * The throwaway holds 0 XLM throughout; the sponsor sources NOTHING, moves no value
 * of its own (funds go only throwaway → home, both the user's own accounts), and
 * RECLAIMS the throwaway's reserves on the merge. The separate, tight SWEEP
 * anti-drain policy (§5) pins the exact op sequence. Mirrors lib/send.ts / lib/claim.ts
 * so the same proven endpoint shape runs in a real browser.
 *
 * The seed reaches this module only to derive the throwaway keypair + sign; it is
 * never persisted, logged, or sent anywhere, and is zeroed after signing.
 */
import { Buffer } from "buffer";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { ACTIVE } from "./network";

const HORIZON_URL = ACTIVE.horizonUrl;
const NETWORK = ACTIVE.passphrase;

export interface SweepOptions {
  sponsorUrl: string;
  /** 32-byte raw Ed25519 seed of the per-link throwaway account (never leaves the client). */
  throwawaySeed: Uint8Array;
  /** The user's persistent home account — the payment + accountMerge destination. */
  homePublicKey: string;
  /**
   * The incoming Claimable Balance to claim FIRST — only when the throwaway still has
   * an OPEN CB (e.g. a claim that failed after account-creation). OMIT it for the
   * production case: the frozen `/c/[id]` route already claimed the CB, so the money
   * sits as plain USDC and there is nothing left to claim (claim-less 3-op sweep).
   */
  balanceId?: string;
  /** The exact USDC amount to move home, as a decimal string (the throwaway's balance / CB amount). */
  amount: string;
}

/**
 * Sweep a throwaway account's money into the home account. Returns the fee-bump
 * transaction hash. On success the caller drops the throwaway record (removeAccount).
 *
 * Two shapes, both proven on testnet (Spike #7, 8/8) and both accepted by the sponsor
 * SWEEP policy:
 *   - claim-less (production, `balanceId` omitted): payment(→home) → changeTrust(0) → accountMerge(→home)
 *   - with-claim (`balanceId` present):  claim → payment(→home) → changeTrust(0) → accountMerge(→home)
 */
export async function sweepIntoHome(opts: SweepOptions): Promise<{ hash: string }> {
  const base = opts.sponsorUrl.replace(/\/$/, "");
  const health = (await (await fetch(`${base}/health`)).json()) as {
    usdcCode: string;
    usdcIssuer: string;
  };
  const USDC = new Asset(health.usdcCode, health.usdcIssuer);

  const throwaway = Keypair.fromRawEd25519Seed(Buffer.from(opts.throwawaySeed));
  const source = throwaway.publicKey();

  const server = new Horizon.Server(HORIZON_URL);
  const acc = await server.loadAccount(source);

  // ONE inner tx, all ops throwaway-sourced, in the order the SWEEP policy pins.
  // The leading claim op is present ONLY when there is still an open CB to claim.
  const builder = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK });
  if (opts.balanceId) {
    builder.addOperation(Operation.claimClaimableBalance({ balanceId: opts.balanceId, source }));
  }
  const inner = builder
    .addOperation(
      Operation.payment({ destination: opts.homePublicKey, asset: USDC, amount: opts.amount, source }),
    )
    .addOperation(Operation.changeTrust({ asset: USDC, limit: "0", source }))
    .addOperation(Operation.accountMerge({ destination: opts.homePublicKey, source }))
    .setTimeout(180)
    .build();
  inner.sign(throwaway);

  const res = await fetch(`${base}/sweep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      xdr: inner.toXDR(),
      throwawayPublicKey: source,
      homePublicKey: opts.homePublicKey,
      amount: opts.amount,
      // Only sent when we actually claimed a CB; the server no longer requires it.
      ...(opts.balanceId ? { balanceId: opts.balanceId } : {}),
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`/sweep → ${res.status}: ${text}`);
  const { hash } = JSON.parse(text) as { hash: string };

  // Best-effort wipe of the seed handed to us — the account it controlled is now
  // merged away, so the material is dead weight; don't leave it lingering.
  opts.throwawaySeed.fill(0);

  return { hash };
}
