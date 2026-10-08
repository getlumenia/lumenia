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
import { activeNetwork, type NetworkConfig } from "./network";
import { assertHealthMatchesPin, pinnedUsdcIssuer } from "./tx-guard";
import { isUnconfirmedSubmit, signedFacts, submitHashes, throwIfUnconfirmed, type UnconfirmedSubmitError } from "./unconfirmed";
import { loadSubmitOutcome, type SubmitOutcome } from "./horizon";
import { netKey } from "./scoped-store";

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
 * A 202 from /sweep is NOT a success: the sponsor bids a fixed fee, under surge Horizon answers 504,
 * and the sweep can expire unincluded while the money stays in the throwaway. It used to be read as
 * done, and both callers then deleted the throwaway's key: the only key to an account the money was
 * still in. It now throws lib/unconfirmed.ts's typed error and REMEMBERS the sweep on this device
 * (pendingSweep below), so the caller keeps the key and a later /home settles it against the ledger.
 *
 * Two shapes, both proven on testnet (Spike #7, 8/8) and both accepted by the sponsor
 * SWEEP policy:
 *   - claim-less (production, `balanceId` omitted): payment(→home) → changeTrust(0) → accountMerge(→home)
 *   - with-claim (`balanceId` present):  claim → payment(→home) → changeTrust(0) → accountMerge(→home)
 */
export async function sweepIntoHome(opts: SweepOptions): Promise<{ hash: string }> {
  const net = activeNetwork();
  const { horizonUrl: HORIZON_URL, passphrase: NETWORK } = net;
  const base = opts.sponsorUrl.replace(/\/$/, "");
  // Pinned: a wrong issuer here makes changeTrust(0) target the wrong line, the accountMerge then
  // fails, and the sweep strands the user's money in a throwaway account.
  const health = (await (await fetch(`${base}/health`)).json()) as {
    usdcCode: string;
    usdcIssuer: string;
  };
  assertHealthMatchesPin(health, net.id);
  const USDC = new Asset("USDC", pinnedUsdcIssuer(net.id));

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
  try {
    throwIfUnconfirmed(res.status, text, "/sweep", signedFacts(inner));
  } catch (e) {
    if (isUnconfirmedSubmit(e)) rememberPendingSweep(source, e);
    throw e;
  }
  if (!res.ok) throw new Error(`/sweep → ${res.status}: ${text}`);
  const { hash } = JSON.parse(text) as { hash: string };

  // Best-effort wipe of the seed handed to us — the account it controlled is now
  // merged away, so the material is dead weight; don't leave it lingering.
  opts.throwawaySeed.fill(0);

  return { hash };
}

/* ------------------------------ a sweep nobody saw decided ------------------------------ */

/** What a later /home needs to settle a sweep the sponsor answered 202 for. No key, no amount. */
export interface PendingSweep {
  hashes: string[];
  sequence: string;
  /** unix seconds after which no ledger can include it */
  maxTime: number;
  /** unix ms it was submitted */
  at: number;
}

/* Per network, like every other money record on this device: a throwaway is an account on ONE chain. */
const PENDING_KEY = "lumenia.sweep.pending";

function readPending(): Record<string, PendingSweep> {
  try {
    const all = JSON.parse(localStorage.getItem(netKey(PENDING_KEY)) ?? "{}") as unknown;
    return all && typeof all === "object" ? (all as Record<string, PendingSweep>) : {};
  } catch {
    return {};
  }
}

function writePending(all: Record<string, PendingSweep>): void {
  try {
    localStorage.setItem(netKey(PENDING_KEY), JSON.stringify(all));
  } catch {
    /* blocked storage: the key record is still kept, and the next sweep simply runs again (its
       sequence number is the same one, so at most one of the two can land) */
  }
}

/** Remember an undecided sweep of `throwaway`. Never throws: it runs on the way out of a catch. */
export function rememberPendingSweep(throwaway: string, e: UnconfirmedSubmitError): void {
  if (!e.signed) return;
  const all = readPending();
  all[throwaway] = { hashes: submitHashes(e), sequence: e.signed.sequence, maxTime: e.signed.maxTime, at: Date.now() };
  writePending(all);
}

/** The undecided sweep of `throwaway` this device remembers, or null. */
export function pendingSweep(throwaway: string): PendingSweep | null {
  const p = readPending()[throwaway];
  return p && typeof p.sequence === "string" && Array.isArray(p.hashes) ? p : null;
}

export function forgetPendingSweep(throwaway: string): void {
  const all = readPending();
  if (!(throwaway in all)) return;
  delete all[throwaway];
  writePending(all);
}

/**
 * Settle a remembered sweep against the ledger (lib/horizon.ts loadSubmitOutcome): "landed" when the
 * merge happened (the throwaway is gone) or the hash succeeded, the only two answers on which its key
 * record may be removed; "failed" when it can no longer land, so the money is still in the throwaway
 * and an ordinary sweep may run again; "pending" or "unknown" to leave everything as it is.
 */
export async function settlePendingSweep(
  throwaway: string,
  p: PendingSweep,
  opts: { net?: Pick<NetworkConfig, "horizonUrl">; fetchImpl?: typeof fetch } = {},
): Promise<SubmitOutcome> {
  return loadSubmitOutcome(
    { hashes: p.hashes, source: throwaway, sequence: p.sequence, maxTime: p.maxTime, closesSource: true },
    opts.net ?? activeNetwork(),
    { fetchImpl: opts.fetchImpl },
  );
}
