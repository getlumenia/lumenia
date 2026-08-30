/**
 * The one signing failure that is not a failure: the account is intact, it simply has no password
 * on it yet (Phase 1).
 *
 * Every money screen catches a signer error and sends the person to /unlock, and /unlock turns any
 * account without a password straight back to /home — so somebody who restored with Face ID, which
 * deliberately lands in Phase 1, can neither send nor open a trustline, and no screen ever names
 * the errand. Telling THIS cause apart from a locked-out or mismatched key is what lets a caller
 * route to setting a password instead.
 *
 * Deliberately dependency-free: lib/ and app/ files both import it, and it must not drag the wallet
 * provider (or React) in behind it.
 */
export class NeedsPasswordError extends Error {
  /** The brand isNeedsPassword reads; see the note there. */
  readonly needsPassword = true;

  constructor(message = "Set a password first — it's what keeps this account yours if this phone is lost.") {
    super(message);
    this.name = "NeedsPasswordError";
  }
}

/**
 * `instanceof` alone is not enough. A client bundle and a server bundle can each hold their own
 * copy of this module, and an error crossing that boundary is the same error while failing the
 * identity check; the brand and the name are what actually survive the trip.
 *
 * Every caller runs this inside a catch block, so — like the claim classifier — it must not throw,
 * whatever it is handed.
 */
export function isNeedsPassword(e: unknown): e is NeedsPasswordError {
  if (e instanceof NeedsPasswordError) return true;
  try {
    const candidate = e as { name?: unknown; needsPassword?: unknown } | null | undefined;
    return candidate?.needsPassword === true || candidate?.name === "NeedsPasswordError";
  } catch {
    return false;
  }
}
