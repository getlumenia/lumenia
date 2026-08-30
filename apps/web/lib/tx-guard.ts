/**
 * What this device is willing to put its signature on.
 *
 * The sponsor hands back a transaction it built and the account's own key co-signs it. That is a
 * blind signature unless somebody checks the bytes, and "the sponsor is honest" is not a security
 * property — the whole point of non-custodial is that a compromised sponsor, a hijacked DNS record
 * for NEXT_PUBLIC_SPONSOR_URL, or a MITM on the response cannot move the user's money. Without this
 * guard the sponsor could return `setOptions(masterWeight=0, signer=attacker)`, `accountMerge`, or a
 * `payment` of the whole balance and the user's own key would authorize it.
 *
 * The check that actually matters is narrow: on Stellar each operation is authorized by ITS OWN
 * source account, so this signature only ever grants authority over operations sourced by US.
 * Everything sourced by the sponsor is the sponsor's business and its own signature's problem. So
 * the rule is — every op whose effective source is this account must be one of the two we asked
 * for, and nothing else in the transaction may quietly spend our sequence number or our fee.
 */
import type { Asset, Transaction } from "@stellar/stellar-sdk";
import { USDC_ISSUER, type NetworkId } from "./network";

/** The asset this build escrows on `net` — a compile-time constant, never a value off the wire. */
export function pinnedUsdcIssuer(net: NetworkId): string {
  const issuer = USDC_ISSUER[net];
  if (!issuer) throw new Error(`no USDC issuer pinned for ${net}`);
  return issuer;
}

/**
 * Cross-check an advisory `/health` payload against the pinned constants. The sponsor reports which
 * asset it operates so a mismatch is visible; it is a CANARY, not an input. Callers build with the
 * pinned issuer regardless — this exists so a swapped sponsor fails loudly instead of silently
 * moving the user onto an attacker's token.
 */
export function assertHealthMatchesPin(
  health: { usdcCode?: unknown; usdcIssuer?: unknown },
  net: NetworkId,
): void {
  const issuer = pinnedUsdcIssuer(net);
  if (health.usdcIssuer !== issuer || health.usdcCode !== "USDC") {
    throw new Error(
      "This sponsor reports a different dollar asset than this app is built for. Nothing was signed.",
    );
  }
}

const REFUSED = "The server sent back something this app did not ask for, so nothing was signed.";

function effectiveSource(op: { source?: string }, txSource: string): string {
  return op.source ?? txSource;
}

/**
 * Compare a Stellar amount by VALUE, never as a string.
 *
 * This is not a style preference — it is the bug this function exists to prevent. A transaction is
 * built with `startingBalance: "0"`, serialised to XDR as an integer number of stroops, and parsed
 * back as `"0.0000000"`. Any check written as `amount !== "0"` therefore compares two strings that
 * are never equal on the wire, and it does so INVISIBLY: written one way it refuses every honest
 * transaction, written the other way it silently permits the hostile one. Both spellings appeared
 * below, and both were wrong.
 */
function amount(raw: unknown): number {
  const n = Number.parseFloat(String(raw ?? ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

/** An `Asset` from a parsed changeTrust op — a credit asset exposes code + issuer. */
function isPinnedUsdc(line: unknown, issuer: string): boolean {
  const a = line as Partial<Asset> & { code?: string; issuer?: string };
  return a?.code === "USDC" && a?.issuer === issuer;
}

/**
 * Assert that `tx` is EXACTLY the sponsored-onboarding sandwich `/create-account` documents:
 *
 *   beginSponsoringFutureReserves(sponsoredId = me)      [source: sponsor]
 *   createAccount(destination = me, startingBalance = 0) [source: sponsor]
 *   changeTrust(USDC)                                    [source: me]   ← we authorize this
 *   endSponsoringFutureReserves()                        [source: me]   ← and this
 *
 * Throws if anything differs. Call it immediately before signing, on every path that signs a
 * server-built transaction with a key that holds money.
 */
/**
 * The 3-op sibling: a USDC trustline for an account that ALREADY EXISTS.
 *
 *   beginSponsoringFutureReserves(sponsoredId = me)  [source: sponsor]
 *   changeTrust(USDC)                                [source: me]   ← we authorize this
 *   endSponsoringFutureReserves()                    [source: me]   ← and this
 *
 * Same rule as its four-op sibling, one op shorter: our signature only ever authorizes the two ops
 * we source, and nothing may spend our sequence or our fee. It exists because an account that is
 * already on-ledger cannot be sent a `createAccount` op — Horizon answers `op_already_exists` —
 * so the only path to a trustline for such an account was a transaction guaranteed to fail.
 *
 * The two shapes stay separate assertions and must never become interchangeable: a caller picks
 * one by establishing its precondition, and gets that contract enforced whole.
 */
export function assertSponsoredTrustline(tx: Transaction, me: string, net: NetworkId): void {
  const issuer = pinnedUsdcIssuer(net);
  const txSource = tx.source;
  if (txSource === me) throw new Error(REFUSED);

  const ops = tx.operations;
  if (ops.length !== 3) throw new Error(REFUSED);
  const [begin, trust, end] = ops as Array<Record<string, unknown> & { type: string; source?: string }>;

  if (
    begin.type !== "beginSponsoringFutureReserves" ||
    begin.sponsoredId !== me ||
    effectiveSource(begin, txSource) === me
  ) {
    throw new Error(REFUSED);
  }
  if (
    trust.type !== "changeTrust" ||
    !isPinnedUsdc(trust.line, issuer) ||
    effectiveSource(trust, txSource) !== me ||
    !(amount(trust.limit) > 0)
  ) {
    throw new Error(REFUSED);
  }
  if (end.type !== "endSponsoringFutureReserves" || effectiveSource(end, txSource) !== me) {
    throw new Error(REFUSED);
  }
}

export function assertSponsoredOnboarding(tx: Transaction, me: string, net: NetworkId): void {
  const issuer = pinnedUsdcIssuer(net);
  const txSource = tx.source;

  // Our sequence number and our fee are ours to spend. The sponsor (or a leased channel account)
  // always sources this transaction; if it were sourced by us, a hostile server could burn our
  // sequence or drain our XLM in fees without any operation looking suspicious.
  if (txSource === me) throw new Error(REFUSED);

  const ops = tx.operations;
  if (ops.length !== 4) throw new Error(REFUSED);

  const [begin, create, trust, end] = ops as Array<Record<string, unknown> & { type: string; source?: string }>;

  if (
    begin.type !== "beginSponsoringFutureReserves" ||
    begin.sponsoredId !== me ||
    effectiveSource(begin, txSource) === me
  ) {
    throw new Error(REFUSED);
  }

  if (
    create.type !== "createAccount" ||
    create.destination !== me ||
    // The sponsor funds ZERO XLM: the recipient's reserves are sponsored, not gifted. Anything
    // above zero would be the sponsor's own money leaving, which is not what this call is for.
    !(amount(create.startingBalance) === 0) ||
    effectiveSource(create, txSource) === me
  ) {
    throw new Error(REFUSED);
  }

  // The two ops our signature actually authorizes.
  if (
    trust.type !== "changeTrust" ||
    !isPinnedUsdc(trust.line, issuer) ||
    effectiveSource(trust, txSource) !== me
  ) {
    throw new Error(REFUSED);
  }
  // A ZERO limit DELETES a trustline. Harmless on a brand-new account, but this same call prepares
  // an existing wallet that may already hold dollars — refuse rather than reason about which is
  // which. Written as `trust.limit === "0"` this check could never fire on a parsed transaction,
  // so the one hostile shape it names was the one shape it let through.
  if (!(amount(trust.limit) > 0)) throw new Error(REFUSED);

  if (end.type !== "endSponsoringFutureReserves" || effectiveSource(end, txSource) !== me) {
    throw new Error(REFUSED);
  }
}
