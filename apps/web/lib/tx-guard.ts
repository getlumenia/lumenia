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
import { StrKey, extractBaseAddress, type Asset, type Transaction } from "@stellar/stellar-sdk";
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
 * Does `address` name OUR account, with a muxed form (`M...`) reduced to the account it multiplexes?
 *
 * The envelope and operation sources arrive as strings, and the parser prints a muxed source as an
 * M address. An envelope sourced by M(our key) is still sourced by our account: our sequence number
 * is burned and our XLM pays the envelope fee, up to the uint32 ceiling of about 429 XLM, and the
 * old check, `tx.source === me`, compared a G string with an M string and let exactly that through.
 * Only the "this must not be us" checks go through here. The two operations our signature
 * authorizes must name us exactly as we are known, so a muxed form THERE is a shape we did not ask
 * for and is refused by the plain comparison that follows.
 */
function isOurAccount(address: string, me: string): boolean {
  if (address === me) return true;
  if (!StrKey.isValidMed25519PublicKey(address)) return false;
  try {
    return extractBaseAddress(address) === me;
  } catch {
    return false;
  }
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

/**
 * The trust limit this app asks for: the sponsor's builder sets none, which the SDK encodes as the
 * largest amount the ledger can hold (int64 stroops, 922337203685.4775807 USDC; see
 * apps/sponsor/src/lib/create-account.ts). Anything smaller is a cap this app never asked for, and
 * "greater than zero", which both guards used to accept, is not harmless: a line full at a few
 * cents makes every later payment into this account fail with op_line_full while the claim screen
 * keeps resuming into it. Compared by value, like every amount here.
 */
const TRUST_LIMIT = amount("922337203685.4775807");

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
  if (isOurAccount(txSource, me)) throw new Error(REFUSED);

  const ops = tx.operations;
  if (ops.length !== 3) throw new Error(REFUSED);
  const [begin, trust, end] = ops as Array<Record<string, unknown> & { type: string; source?: string }>;

  if (
    begin.type !== "beginSponsoringFutureReserves" ||
    begin.sponsoredId !== me ||
    isOurAccount(effectiveSource(begin, txSource), me)
  ) {
    throw new Error(REFUSED);
  }
  if (
    trust.type !== "changeTrust" ||
    !isPinnedUsdc(trust.line, issuer) ||
    effectiveSource(trust, txSource) !== me ||
    // The limit we asked for, not merely "not a deletion" (see TRUST_LIMIT).
    !(amount(trust.limit) >= TRUST_LIMIT)
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
  // sequence or drain our XLM in fees without any operation looking suspicious. In either form:
  // a muxed source is still our account (isOurAccount).
  if (isOurAccount(txSource, me)) throw new Error(REFUSED);

  const ops = tx.operations;
  if (ops.length !== 4) throw new Error(REFUSED);

  const [begin, create, trust, end] = ops as Array<Record<string, unknown> & { type: string; source?: string }>;

  if (
    begin.type !== "beginSponsoringFutureReserves" ||
    begin.sponsoredId !== me ||
    isOurAccount(effectiveSource(begin, txSource), me)
  ) {
    throw new Error(REFUSED);
  }

  if (
    create.type !== "createAccount" ||
    create.destination !== me ||
    // The sponsor funds ZERO XLM: the recipient's reserves are sponsored, not gifted. Anything
    // above zero would be the sponsor's own money leaving, which is not what this call is for.
    !(amount(create.startingBalance) === 0) ||
    isOurAccount(effectiveSource(create, txSource), me)
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
  // an existing wallet that may already hold dollars: refuse rather than reason about which is
  // which. Written as `trust.limit === "0"` this check could never fire on a parsed transaction,
  // so the one hostile shape it names was the one shape it let through. And a limit that is merely
  // above zero is not enough either: it must be the one we asked for (TRUST_LIMIT).
  if (!(amount(trust.limit) >= TRUST_LIMIT)) throw new Error(REFUSED);

  if (end.type !== "endSponsoringFutureReserves" || effectiveSource(end, txSource) !== me) {
    throw new Error(REFUSED);
  }
}
