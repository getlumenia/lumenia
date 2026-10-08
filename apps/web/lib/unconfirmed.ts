/**
 * A submission the sponsor accepted and never saw decided: its 202.
 *
 * Every sponsor route that submits a transaction answers 202 when the network took it and the
 * sponsor stopped watching before the ledger ruled on it (apps/sponsor/src/worker.ts). The Horizon
 * routes (/feebump, /send-link, /sweep, /payout, /faucet, /demo-link) say so with
 * `{"error":"submit unconfirmed","hash":"<64 hex>"}`. A 202 is a 2xx, so `res.ok` is true for it,
 * and every consumer that read "ok" as "done" turned it into a success: a claim screen that said
 * "Your money" for a claim that might never land, a direct payment whose missing balance id crashed
 * the screen into "your money hasn't moved, try again" (and a second payment), a sweep that deleted
 * the only key to an account the money was still sitting in.
 *
 * This is the one typed error all of them throw instead. It carries what the ledger can be asked
 * later: the hash the sponsor submitted (its fee-bump, when the reply named it) and the facts of the
 * transaction THIS device signed, because a reply that never fully arrived is exactly when the
 * sponsor's hash can be missing, and our own hash, source and sequence never are.
 *
 * Dependency-free on purpose: lib/claim-error.ts reads it from inside a catch block, and both lib/
 * and app/ files import it.
 */

/** What this device signed, so the ledger can be asked about it with or without the sponsor's hash. */
export interface SignedFacts {
  /** the hash of the transaction this device signed (the inner one, under the sponsor's fee-bump) */
  innerHash: string;
  /** its source account */
  source: string;
  /** its sequence number, as a decimal string */
  sequence: string;
  /** unix seconds after which no ledger can include it; 0 when it has no upper bound */
  maxTime: number;
}

/** The facts of a built transaction, read once. Takes anything shaped like a stellar-sdk Transaction. */
export function signedFacts(tx: {
  hash(): { toString(encoding: "hex"): string };
  source: string;
  sequence: string;
  timeBounds?: { maxTime: string | number };
}): SignedFacts {
  return {
    innerHash: tx.hash().toString("hex"),
    source: tx.source,
    sequence: tx.sequence,
    maxTime: Number(tx.timeBounds?.maxTime ?? 0) || 0,
  };
}

export class UnconfirmedSubmitError extends Error {
  /** The brand isUnconfirmedSubmit reads: an `instanceof` does not survive two bundles. */
  readonly submitUnconfirmed = true;

  constructor(
    /** the sponsor route that answered, e.g. "/send-link" */
    readonly route: string,
    /** what the sponsor submitted, when its reply named it; "" otherwise */
    readonly hash: string,
    /** what this device signed; null when nothing of ours went out (the /try page's mint) */
    readonly signed: SignedFacts | null,
  ) {
    super(`${route}: submit unconfirmed${hash ? ` (tx ${hash})` : ""}`);
    this.name = "UnconfirmedSubmitError";
  }
}

/** True for the error above, by brand or by name, and never throws (it runs inside catch blocks). */
export function isUnconfirmedSubmit(e: unknown): e is UnconfirmedSubmitError {
  if (e instanceof UnconfirmedSubmitError) return true;
  try {
    const candidate = e as { submitUnconfirmed?: unknown; name?: unknown } | null | undefined;
    return candidate?.submitUnconfirmed === true || candidate?.name === "UnconfirmedSubmitError";
  } catch {
    return false;
  }
}

const HEX64 = /^[0-9a-f]{64}$/i;

/** Every hash the ledger may know this submission by: the sponsor's first, then our own. */
export function submitHashes(e: Pick<UnconfirmedSubmitError, "hash" | "signed">): string[] {
  const all = [e.hash, e.signed?.innerHash ?? ""].filter((h) => HEX64.test(h)).map((h) => h.toLowerCase());
  return [...new Set(all)];
}

/**
 * Throw the typed error when a sponsor reply says "accepted, undecided": a 202, or a body whose
 * `error` says "submit unconfirmed". Anything else returns, so each caller's own handling of a
 * refusal and of a 200 stays exactly what it was.
 */
export function throwIfUnconfirmed(status: number, text: string, route: string, signed: SignedFacts | null): void {
  let body: { error?: unknown; hash?: unknown } | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as { error?: unknown; hash?: unknown };
  } catch {
    /* not JSON: only the status can say it */
  }
  const said = typeof body?.error === "string" && /submit unconfirmed/i.test(body.error);
  if (status !== 202 && !said) return;
  const hash = typeof body?.hash === "string" && HEX64.test(body.hash) ? body.hash.toLowerCase() : "";
  throw new UnconfirmedSubmitError(route, hash, signed);
}
