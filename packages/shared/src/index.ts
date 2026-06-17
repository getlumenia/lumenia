/**
 * @lumenia/shared — primitives shared by the web + sponsor service.
 * (tx-build, claim-secret, anti-drain validation, types)
 *
 * CRITICAL: the claim tx is seen by both web (builds the inner tx) and sponsor
 * (re-validate + fee-bump); both must import from here so they run byte-for-byte identical logic.
 */
import { createHash, randomBytes } from "node:crypto";
import { Asset, Transaction } from "@stellar/stellar-sdk";

/* ------------------------------------------------------------------ */
/* Asset & network configuration                                      */
/* ------------------------------------------------------------------ */

/** native Circle USDC (mainnet). On testnet use your own test issuer. */
export const USDC_MAINNET_ISSUER =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

export function usdc(issuer: string): Asset {
  return new Asset("USDC", issuer);
}

/* ------------------------------------------------------------------ */
/* Claim secret (bearer token in the link)                            */
/* ------------------------------------------------------------------ */

/** High-entropy secret (≥128-bit) to be placed in the link's fragment. */
export function generateClaimSecret(): string {
  return randomBytes(16).toString("base64url");
}

/** ONLY its hash is stored on the server — the plaintext secret is never written to the DB. */
export function hashClaimSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Anti-drain validation (sponsor calls this BEFORE fee-bump)          */
/* ------------------------------------------------------------------ */

/**
 * The inner tx the sponsor will sign/fee-bump must contain only the expected
 * ops with the expected PARAMETERS. Not a denylist but an ALLOWLIST: a single
 * unknown op — or an allowed op with an unexpected parameter — = REJECT.
 *
 * This is the sponsor's only defense against draining its reserve + fee. The
 * Stellar protocol isolates the *fee* (via fee-bump); we must isolate the
 * *reserve* and any value movement ourselves. Op-type allowlisting alone is
 * NOT enough (a code-review finding): `createAccount(startingBalance > 0)`,
 * `changeTrust` sourced by the sponsor, or a `payment` to an arbitrary
 * destination all drain the sponsor while passing a type-only check. So we
 * validate every op's source AND its sensitive parameters.
 */
export const ALLOWED_INNER_OP_TYPES = new Set<string>([
  "beginSponsoringFutureReserves",
  "createAccount",
  "changeTrust",
  "endSponsoringFutureReserves",
  "claimClaimableBalance",
  "payment", // only to allow-listed destinations, never sourced by the sponsor
]);

/** Ops the sponsor account is allowed to be the op-source of. Any other
 *  sponsor-sourced op is a drain attempt. */
const SPONSOR_SOURCEABLE_OPS = new Set<string>([
  "beginSponsoringFutureReserves",
  "createAccount",
]);

export interface InnerTxPolicy {
  /** Expected tx source (the recipient account). */
  expectedSource: string;
  /** Sponsor account — pays the fee and may ONLY source begin/createAccount. */
  sponsor: string;
  /** The exact asset `changeTrust` is allowed to add (e.g. USDC). If omitted, any changeTrust asset passes. */
  expectedAsset?: Asset;
  /** The exact Claimable Balance id that may be claimed. If omitted, any balanceId passes. */
  expectedBalanceId?: string;
  /** Allowed `payment` destinations. If a payment appears and this is omitted/empty, the payment is REJECTED. */
  allowedPaymentDestinations?: Set<string>;
  /** Max `createAccount` startingBalance (default "0" — sponsor funds zero XLM). */
  maxStartingBalance?: string;
  /** Maximum number of ops accepted in a single tx. */
  maxOps?: number;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** op.source if set, otherwise the tx source (Stellar's default op source). */
function opSource(op: { source?: string }, txSource: string): string {
  return op.source ?? txSource;
}

export function validateInnerTransaction(
  tx: Transaction,
  policy: InnerTxPolicy,
): ValidationResult {
  const maxOps = policy.maxOps ?? 6;
  const maxStarting = Number.parseFloat(policy.maxStartingBalance ?? "0");

  if (tx.operations.length === 0) {
    return { ok: false, reason: "no operations" };
  }
  if (tx.operations.length > maxOps) {
    return { ok: false, reason: `too many ops (${tx.operations.length} > ${maxOps})` };
  }
  if (tx.source !== policy.expectedSource) {
    return { ok: false, reason: `unexpected tx source ${tx.source}` };
  }

  for (const op of tx.operations) {
    if (!ALLOWED_INNER_OP_TYPES.has(op.type)) {
      return { ok: false, reason: `disallowed op type: ${op.type}` };
    }

    const src = opSource(op as { source?: string }, tx.source);

    // Sponsor may only be the source of begin/createAccount. Any other
    // sponsor-sourced op (payment, changeTrust, ...) drains the sponsor.
    if (src === policy.sponsor && !SPONSOR_SOURCEABLE_OPS.has(op.type)) {
      return { ok: false, reason: `op '${op.type}' sourced from sponsor (drain attempt)` };
    }
    // Conversely, begin/createAccount must be sourced by the sponsor; every
    // other op must be sourced by the recipient (expectedSource).
    if (SPONSOR_SOURCEABLE_OPS.has(op.type)) {
      if (src !== policy.sponsor) {
        return { ok: false, reason: `op '${op.type}' must be sourced by the sponsor, got ${src}` };
      }
    } else if (src !== policy.expectedSource) {
      return { ok: false, reason: `op '${op.type}' must be sourced by the recipient, got ${src}` };
    }

    switch (op.type) {
      case "createAccount": {
        const o = op as { destination?: string; startingBalance?: string };
        if (o.destination !== policy.expectedSource) {
          return { ok: false, reason: `createAccount destination ${o.destination} != recipient` };
        }
        if (Number.parseFloat(o.startingBalance ?? "0") > maxStarting) {
          return {
            ok: false,
            reason: `createAccount startingBalance ${o.startingBalance} > max ${maxStarting} (drain attempt)`,
          };
        }
        break;
      }
      case "beginSponsoringFutureReserves": {
        const o = op as { sponsoredId?: string };
        if (o.sponsoredId !== policy.expectedSource) {
          return { ok: false, reason: `beginSponsoring sponsoredId ${o.sponsoredId} != recipient` };
        }
        break;
      }
      case "changeTrust": {
        const o = op as { line?: Asset; limit?: string };
        // Reject liquidity-pool trustlines and any asset other than the expected one.
        if (policy.expectedAsset) {
          const line = o.line;
          if (!line || typeof (line as Asset).equals !== "function" || !policy.expectedAsset.equals(line as Asset)) {
            return { ok: false, reason: "changeTrust asset is not the expected asset" };
          }
        }
        break;
      }
      case "claimClaimableBalance": {
        const o = op as { balanceId?: string };
        if (policy.expectedBalanceId && o.balanceId !== policy.expectedBalanceId) {
          return { ok: false, reason: `claim balanceId ${o.balanceId} != expected` };
        }
        break;
      }
      case "payment": {
        const o = op as { destination?: string };
        // A payment is only allowed to an explicitly allow-listed destination.
        // No allowlist provided → no payment allowed.
        if (
          !policy.allowedPaymentDestinations ||
          policy.allowedPaymentDestinations.size === 0 ||
          !o.destination ||
          !policy.allowedPaymentDestinations.has(o.destination)
        ) {
          return { ok: false, reason: `payment to non-allowlisted destination ${o.destination}` };
        }
        break;
      }
      // endSponsoringFutureReserves: no extra params to check (source already enforced).
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type StellarNetwork = "testnet" | "mainnet";

export interface ClaimLink {
  /** hash(claimSecret) — the plaintext secret is never stored. */
  secretHash: string;
  /** Claimable Balance id (on the Stellar ledger). */
  balanceId: string;
  senderAddress: string;
  asset: "USDC";
  amount: string;
  status: "pending" | "claimed" | "reclaimed" | "expired";
  expiresAt: string;
}
