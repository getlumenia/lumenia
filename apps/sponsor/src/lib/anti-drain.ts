/**
 * Anti-drain validator — the sponsor's server-side gate, run BEFORE it fee-bumps
 * a client-supplied tx. It lives inside apps/sponsor (not packages/shared) because
 * it is a SPONSOR concern — the web builds the inner tx, only the sponsor validates
 * it — and because the deployed function must bundle it from within its own dir.
 *
 * Not a denylist but an ALLOWLIST: a single unknown op — or an allowed op with an
 * unexpected parameter — = REJECT. This is the sponsor's only defense against
 * draining its reserve + fee. Stellar isolates the *fee* (via fee-bump); we isolate
 * the *reserve* and any value movement. Op-type allowlisting alone is NOT enough:
 * `createAccount(startingBalance > 0)`, `changeTrust` sourced by the sponsor, or a
 * `payment` to an arbitrary destination all drain the sponsor while passing a
 * type-only check. So we validate every op's SOURCE and its sensitive PARAMETERS.
 *
 * Covered by the full test-antidrain.ts suite — the same file that tests the deployed gate.
 * Includes an exact op-SEQUENCE matcher (defense-in-depth) + a GOLDEN-policy snapshot
 * that fails CI if any allowlist silently widens.
 */
import { StrKey } from "@stellar/stellar-sdk";
import type { Asset, Transaction } from "@stellar/stellar-sdk";

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

/**
 * The tight op allowlist for the /send path (a 0-XLM sender creates a dual-predicate
 * Claimable Balance; the sponsor sponsors the reserve + fee-bumps). Kept SEPARATE
 * from the claim allowlist so /feebump can NEVER accept a createClaimableBalance —
 * the send has its own endpoint + policy. `createClaimableBalance` is deliberately
 * NOT in SPONSOR_SOURCEABLE_OPS, so the generic source check forces it to be
 * sender-sourced (a sponsor-sourced CB would spend the sponsor's own USDC).
 */
export const ALLOWED_SEND_OP_TYPES = new Set<string>([
  "beginSponsoringFutureReserves",
  "createClaimableBalance",
  "endSponsoringFutureReserves",
]);

export interface InnerTxPolicy {
  /** Expected tx source (the recipient account). */
  expectedSource: string;
  /** Sponsor account — pays the fee and may ONLY source begin/createAccount. */
  sponsor: string;
  /**
   * The exact asset `changeTrust` is allowed to add (e.g. USDC).
   * STRICT DEFAULT: if a `changeTrust` op is present and this is omitted, the tx
   * is REJECTED (a forgotten field must fail closed, not silently allow any asset).
   * To intentionally accept any asset, set `allowUncheckedAsset: true`.
   */
  expectedAsset?: Asset;
  /**
   * The exact Claimable Balance id that may be claimed.
   * STRICT DEFAULT: if a `claimClaimableBalance` op is present and this is omitted,
   * the tx is REJECTED. To intentionally accept any balanceId, set
   * `allowUncheckedBalanceId: true`.
   */
  expectedBalanceId?: string;
  /** Escape hatch: allow a `changeTrust` with no `expectedAsset` set (default false). */
  allowUncheckedAsset?: boolean;
  /** Escape hatch: allow a `claimClaimableBalance` with no `expectedBalanceId` set (default false). */
  allowUncheckedBalanceId?: boolean;
  /** Allowed `payment` destinations. If a payment appears and this is omitted/empty, the payment is REJECTED. */
  allowedPaymentDestinations?: Set<string>;
  /** Max `createAccount` startingBalance (default "0" — sponsor funds zero XLM). */
  maxStartingBalance?: string;
  /** Maximum number of ops accepted in a single tx. */
  maxOps?: number;
  /**
   * Override the allowed op-type set (defaults to the claim ALLOWED_INNER_OP_TYPES).
   * The /send path passes ALLOWED_SEND_OP_TYPES so the claim allowlist is never widened.
   */
  allowedOpTypes?: Set<string>;
  /**
   * For `createClaimableBalance`: the EXACT number of claimants allowed. This BOUNDS
   * the sponsor's reserve lock (reserve = baseReserve × numClaimants, otherwise
   * attacker-controlled). STRICT: if a createClaimableBalance is present and this is
   * omitted, the tx is REJECTED.
   */
  expectedClaimantCount?: number;
  /**
   * The EXACT ordered op-type sequence the tx must match (defense-in-depth, ON TOP of
   * the per-op allowlist). Pins the tx to its known shape so a reordered set of
   * individually-allowed ops — e.g. a send with `createClaimableBalance` BEFORE its
   * `beginSponsoring` wrapper — is rejected even though every op passes on its own.
   * Omit to skip the ordered check (the per-op allowlist still applies). The live claim
   * policy pins `["claimClaimableBalance"]`; the send policy pins
   * `[begin, createClaimableBalance, end]`.
   */
  expectedOpSequence?: readonly string[];
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** op.source if set, otherwise the tx source (Stellar's default op source). */
function opSource(op: { source?: string }, txSource: string): string {
  return op.source ?? txSource;
}

/**
 * Every source and destination check in this file is a string `===` against a `G…` account. A
 * MUXED address (`M…`, SEP-23) wraps the same underlying ed25519 key in a different string, so
 * `M…(sponsor) === policy.sponsor` is false and the "sponsor may not source this op" check —
 * the drain check — would simply not fire.
 *
 * That is not exploitable today, for reasons that are luck rather than design: the two policies
 * that could carry it never get the sponsor's signature on the inner transaction, and the one that
 * does (`/send-link`) is saved because `beginSponsoringFutureReserves.sponsoredId` is an XDR
 * `AccountID`, which cannot hold a muxed address at all. Relying on an accident is how a later
 * refactor turns a non-issue into a drain, so this rejects the ambiguity outright: this validator
 * only reasons about plain ed25519 accounts, and anything else is refused before comparison.
 */
function assertPlainAccount(label: string, value: string): ValidationResult | null {
  if (StrKey.isValidEd25519PublicKey(value)) return null;
  return { ok: false, reason: `${label} must be a plain G… account, got ${value.slice(0, 12)}…` };
}

export function validateInnerTransaction(
  tx: Transaction,
  policy: InnerTxPolicy,
): ValidationResult {
  const maxOps = policy.maxOps ?? 6;
  const maxStarting = Number.parseFloat(policy.maxStartingBalance ?? "0");
  const allowedTypes = policy.allowedOpTypes ?? ALLOWED_INNER_OP_TYPES;

  if (tx.operations.length === 0) {
    return { ok: false, reason: "no operations" };
  }
  if (tx.operations.length > maxOps) {
    return { ok: false, reason: `too many ops (${tx.operations.length} > ${maxOps})` };
  }
  if (tx.source !== policy.expectedSource) {
    return { ok: false, reason: `unexpected tx source ${tx.source}` };
  }

  // Refuse muxed/non-ed25519 addresses before any === comparison happens (see assertPlainAccount).
  for (const [label, value] of [
    ["tx source", tx.source],
    ["expectedSource", policy.expectedSource],
    ["sponsor", policy.sponsor],
  ] as const) {
    const bad = assertPlainAccount(label, value);
    if (bad) return bad;
  }

  // Exact op-sequence match (when pinned): the tx must be its known ORDERED shape, not
  // just a bag of individually-allowed ops. Defense-in-depth on top of the per-op checks
  // below — catches a reordering of otherwise-valid ops.
  if (policy.expectedOpSequence) {
    const actual = tx.operations.map((o) => o.type);
    const expected = policy.expectedOpSequence;
    if (actual.length !== expected.length || actual.some((t, i) => t !== expected[i])) {
      return { ok: false, reason: `op sequence [${actual.join(", ")}] != expected [${expected.join(", ")}]` };
    }
  }

  for (const op of tx.operations) {
    if (!allowedTypes.has(op.type)) {
      return { ok: false, reason: `disallowed op type: ${op.type}` };
    }

    const src = opSource(op as { source?: string }, tx.source);
    const badSrc = assertPlainAccount(`op '${op.type}' source`, src);
    if (badSrc) return badSrc;

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
        } else if (!policy.allowUncheckedAsset) {
          // Strict default: an unconstrained changeTrust fails closed (a forgotten
          // expectedAsset must not silently sponsor a trustline for any/LP asset).
          return { ok: false, reason: "changeTrust present but no expectedAsset set (strict mode)" };
        }
        break;
      }
      case "claimClaimableBalance": {
        const o = op as { balanceId?: string };
        if (policy.expectedBalanceId) {
          if (o.balanceId !== policy.expectedBalanceId) {
            return { ok: false, reason: `claim balanceId ${o.balanceId} != expected` };
          }
        } else if (!policy.allowUncheckedBalanceId) {
          // Strict default: an unconstrained claim fails closed (a forgotten
          // expectedBalanceId must not let any claimable balance be claimed).
          return { ok: false, reason: "claim present but no expectedBalanceId set (strict mode)" };
        }
        break;
      }
      case "createClaimableBalance": {
        // The /send shape: a sender-sourced CB whose reserve the sponsor sponsors.
        // The sponsor never loses value (the USDC is the sender's) — the only new
        // surface is the RESERVE LOCK, controlled by claimant count + predicates.
        const o = op as {
          asset?: Asset;
          claimants?: Array<{ destination?: string; predicate?: { switch(): { name: string } } }>;
        };
        // asset must be the expected one (strict fail-closed, like changeTrust)
        if (policy.expectedAsset) {
          const asset = o.asset;
          if (!asset || typeof (asset as Asset).equals !== "function" || !policy.expectedAsset.equals(asset as Asset)) {
            return { ok: false, reason: "createClaimableBalance asset is not the expected asset" };
          }
        } else if (!policy.allowUncheckedAsset) {
          return { ok: false, reason: "createClaimableBalance present but no expectedAsset set (strict mode)" };
        }
        const claimants = o.claimants ?? [];
        // EXACT claimant count — bounds the sponsor's reserve lock (baseReserve ×
        // numClaimants). Strict: a forgotten count must fail closed.
        if (policy.expectedClaimantCount === undefined) {
          return { ok: false, reason: "createClaimableBalance present but no expectedClaimantCount set (strict mode)" };
        }
        if (claimants.length !== policy.expectedClaimantCount) {
          return {
            ok: false,
            reason: `createClaimableBalance has ${claimants.length} claimants, expected ${policy.expectedClaimantCount}`,
          };
        }
        // At least one UNCONDITIONAL claimant → the CB is always claimable → the
        // sponsored reserve is always releasable (closes "locked forever" griefing).
        const hasUnconditional = claimants.some(
          (c) => c.predicate?.switch?.().name === "claimPredicateUnconditional",
        );
        if (!hasUnconditional) {
          return { ok: false, reason: "createClaimableBalance has no unconditional claimant (reserve could lock forever)" };
        }
        // The sender must be a claimant (the reclaim path — money returns to them).
        if (!claimants.some((c) => c.destination === policy.expectedSource)) {
          return { ok: false, reason: "createClaimableBalance missing the sender as a reclaim claimant" };
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

/* ============================================================================
 * PAYOUT policy — the user sends their OWN USDC straight out to an address they
 * name (an exchange deposit address, a friend's account). A SEPARATE, tight
 * allowlist: the claim, send and sweep policies above are never touched.
 *
 * Why this can't reuse the /send-link shape: a Claimable Balance is not a
 * payment. Exchanges credit a deposit when a `payment` operation with the right
 * MEMO lands on their address; a Claimable Balance addressed to them just sits
 * there unclaimed. So a payout has to be a real payment op, which is its own
 * policy — and the memo has to survive the sponsor's fee-bump untouched (a
 * fee-bump wraps the inner transaction whole, memo included; asserted in
 * test-antidrain.ts).
 *
 * What the sponsor risks here is the FEE and nothing else: the USDC is the
 * user's own, the sponsor sources no op, and the asset is pinned to the one
 * configured USDC. It never enforces the memo — the network doesn't either
 * (SEP-29 memo-required is a client-side convention), which is exactly why the
 * web flow makes the memo mandatory and checks the destination for the flag.
 * ============================================================================ */

export const ALLOWED_PAYOUT_OP_TYPES = new Set<string>(["payment"]);

export interface PayoutPolicy {
  /** The user's account: the tx source AND the payment's op source. */
  sender: string;
  /** Sponsor account — sources NOTHING here (it only fee-bumps). */
  sponsor: string;
  /** The one asset a payout may move (the configured USDC). */
  usdc: Asset;
  /** The destination the client declared — a G… account or a muxed M… address. */
  expectedDestination: string;
  /** The exact amount the client declared. */
  expectedAmount: string;
}

/**
 * Validate a payout inner tx before the sponsor fee-bumps it: exactly one
 * sender-sourced `payment`, in the configured USDC, to the declared destination,
 * for the declared amount. Anything else = REJECT.
 */
export function validatePayoutTransaction(tx: Transaction, policy: PayoutPolicy): ValidationResult {
  const ops = tx.operations;
  if (ops.length !== 1) {
    return { ok: false, reason: `payout must be exactly one payment op, got ${ops.length}` };
  }
  const op = ops[0]!;
  if (!ALLOWED_PAYOUT_OP_TYPES.has(op.type)) {
    return { ok: false, reason: `disallowed op type: ${op.type}` };
  }
  if (tx.source !== policy.sender) {
    return { ok: false, reason: `unexpected tx source ${tx.source}` };
  }
  const src = opSource(op as { source?: string }, tx.source);
  if (src === policy.sponsor) {
    return { ok: false, reason: "payout payment sourced from sponsor (drain attempt)" };
  }
  if (src !== policy.sender) {
    return { ok: false, reason: `payout payment must be sourced by the sender, got ${src}` };
  }

  const pay = op as { destination?: string; asset?: Asset; amount?: string };
  if (!pay.destination || pay.destination !== policy.expectedDestination) {
    return { ok: false, reason: `payout destination ${pay.destination} != declared destination` };
  }
  if (!pay.asset || typeof (pay.asset as Asset).equals !== "function" || !policy.usdc.equals(pay.asset as Asset)) {
    return { ok: false, reason: "payout asset is not the expected USDC" };
  }
  const amount = Number.parseFloat(pay.amount ?? "0");
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: `payout amount ${pay.amount} must be greater than zero` };
  }
  if (amount !== Number.parseFloat(policy.expectedAmount)) {
    return { ok: false, reason: `payout amount ${pay.amount} != declared ${policy.expectedAmount}` };
  }

  return { ok: true };
}

/* ============================================================================
 * SWEEP policy — consolidate an incoming per-link account into the user's ONE
 * persistent "home" account (see docs/RECOVERY_ARCHITECTURE.md). This is a
 * SEPARATE, tight allowlist: the claim (ALLOWED_INNER_OP_TYPES) and send
 * (ALLOWED_SEND_OP_TYPES) policies above are NEVER touched or widened.
 *
 * The per-link THROWAWAY account sources ALL ops; the sponsor sources NONE and
 * only fee-bumps. The sponsor can never lose value — funds move only between the
 * user's OWN accounts (throwaway → home) — and it RECLAIMS the throwaway's
 * sponsored reserves on the accountMerge (net positive; also relieves the
 * reserve-lock risk). Proven end-to-end on testnet by Spike #7.
 * ============================================================================ */

export const ALLOWED_SWEEP_OP_TYPES = new Set<string>([
  "claimClaimableBalance",
  "payment",
  "changeTrust",
  "accountMerge",
]);

/**
 * The sweep TAIL — always required, in this exact order. An OPTIONAL
 * claimClaimableBalance may precede it:
 *   - 3 ops [payment, changeTrust, accountMerge]  → the throwaway already holds
 *     plain USDC (the current frozen /c/[id] route CLAIMS the CB at claim time,
 *     so by the time we consolidate there is no open CB left). This is the
 *     PRODUCTION shape today.
 *   - 4 ops [claimClaimableBalance, payment, changeTrust, accountMerge] → the
 *     throwaway still holds an unclaimed CB (a future deferred-claim flow, or the
 *     "claim failed but the account exists" symptom). Requires expectedBalanceId.
 */
const SWEEP_TAIL = ["payment", "changeTrust", "accountMerge"] as const;

export interface SweepPolicy {
  /** The per-link throwaway account: the tx source AND the source of every op. */
  throwaway: string;
  /** Sponsor account — must source NOTHING here (it only fee-bumps). */
  sponsor: string;
  /** The user's persistent home account: the payment + accountMerge destination. */
  home: string;
  /** The one USDC asset (the payment asset + the trustline being removed). */
  usdc: Asset;
  /** The exact amount being swept (must equal the throwaway's balance / claimed amount). */
  expectedAmount: string;
  /**
   * The incoming Claimable Balance the sweep may claim. Provide ONLY for the
   * 4-op (unclaimed-CB) shape. If a claim op is present and this is omitted, the
   * tx is REJECTED (strict fail-closed). For the 3-op already-claimed shape, omit it.
   */
  expectedBalanceId?: string;
}

/**
 * Validate a sweep inner tx before the sponsor fee-bumps it. Strict + order-pinned.
 * Accepts the 3-op (already-claimed) or 4-op (with claim) shape; all ops sourced by
 * the throwaway; the sponsor sources nothing. Anything else = REJECT.
 */
export function validateSweepTransaction(tx: Transaction, policy: SweepPolicy): ValidationResult {
  const ops = tx.operations;
  const hasClaim = ops.length === 4 && ops[0]!.type === "claimClaimableBalance";
  const seq = hasClaim ? (["claimClaimableBalance", ...SWEEP_TAIL] as const) : SWEEP_TAIL;
  if (ops.length !== seq.length) {
    return {
      ok: false,
      reason: `sweep must be [payment,changeTrust,accountMerge] (optionally led by a claim), got ${ops.length} ops`,
    };
  }
  if (tx.source !== policy.throwaway) {
    return { ok: false, reason: `unexpected tx source ${tx.source}` };
  }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.type !== seq[i]) {
      return { ok: false, reason: `sweep op ${i} must be ${seq[i]}, got ${op.type}` };
    }
    // Every op MUST be sourced by the throwaway; the sponsor sources nothing here.
    const src = (op as { source?: string }).source ?? tx.source;
    if (src === policy.sponsor) {
      return { ok: false, reason: `sweep op '${op.type}' sourced from sponsor (not allowed)` };
    }
    if (src !== policy.throwaway) {
      return { ok: false, reason: `sweep op '${op.type}' must be sourced by the throwaway account, got ${src}` };
    }
  }

  const off = hasClaim ? 1 : 0;

  if (hasClaim) {
    const claim = ops[0] as { balanceId?: string };
    if (policy.expectedBalanceId === undefined) {
      return { ok: false, reason: "sweep has a claim op but no expectedBalanceId set (strict mode)" };
    }
    if (claim.balanceId !== policy.expectedBalanceId) {
      return { ok: false, reason: `sweep claim balanceId ${claim.balanceId} != expected` };
    }
  }

  const pay = ops[off] as { destination?: string; asset?: Asset; amount?: string };
  if (pay.destination !== policy.home) {
    return { ok: false, reason: `sweep payment destination ${pay.destination} != home` };
  }
  if (!pay.asset || typeof (pay.asset as Asset).equals !== "function" || !policy.usdc.equals(pay.asset as Asset)) {
    return { ok: false, reason: "sweep payment asset is not the expected USDC" };
  }
  if (Number.parseFloat(pay.amount ?? "0") !== Number.parseFloat(policy.expectedAmount)) {
    return { ok: false, reason: `sweep payment amount ${pay.amount} != expected ${policy.expectedAmount}` };
  }

  const ct = ops[off + 1] as { line?: Asset; limit?: string };
  if (!ct.line || typeof (ct.line as Asset).equals !== "function" || !policy.usdc.equals(ct.line as Asset)) {
    return { ok: false, reason: "sweep changeTrust asset is not the expected USDC" };
  }
  // limit MUST be 0 — the sweep only REMOVES the throwaway's trustline, never adds trust.
  if (Number.parseFloat(ct.limit ?? "-1") !== 0) {
    return { ok: false, reason: `sweep changeTrust must remove the trustline (limit 0), got ${ct.limit}` };
  }

  const merge = ops[off + 2] as { destination?: string };
  if (merge.destination !== policy.home) {
    return { ok: false, reason: `sweep accountMerge destination ${merge.destination} != home` };
  }

  return { ok: true };
}
