/**
 * Keeping the key of the account a v2 claim pays into, and refusing the claim when it cannot be kept.
 *
 * The claim mints a sponsored account, hands its key to this device, and only then relays the money
 * into it (lib/lumendrop.ts claimV2ToSponsoredAccount, `onAccountReady`). The old callback swallowed
 * a failed save, zeroed the seed, and let the relay run: in a browser that blocks storage (a private
 * window on some browsers, a locked-down webview) the money landed in an account nobody held a key
 * for, and the latch then resumed every later tap into the same keyless account (review P0-7). A
 * save that fails is a reason to STOP, before anything is relayed: an empty sponsored account is
 * harmless, money in a keyless one is lost.
 *
 * Pure apart from its two injected steps, so the refusal is held by test:claimhome.
 */
import type { AccountKind } from "./keystore";

export const STORAGE_BLOCKED =
  "This browser blocks saving, so the key to this money could not be kept. Nothing was moved.";

/** Thrown by keepClaimKey when the key could not be stored. The claim screen names it by class, never by wording. */
export class StorageBlockedError extends Error {
  constructor(cause?: unknown) {
    super(STORAGE_BLOCKED, { cause });
    this.name = "StorageBlockedError";
  }
}

export function isStorageBlocked(e: unknown): e is StorageBlockedError {
  return e instanceof StorageBlockedError || (e as { name?: unknown } | null)?.name === "StorageBlockedError";
}

export interface KeepKeyDeps {
  /** Keep an account's key on this device (lib/keystore.ts savePhase1). */
  save(pubkey: string, seed: Uint8Array, kind?: AccountKind): Promise<void>;
  /** Whether this device already has a home account (lib/keystore.ts getHome). */
  hasHome(): Promise<boolean>;
}

/**
 * Keep the claim account's key, or throw StorageBlockedError. The seed is zeroed on every path.
 *
 * With no home on this device the claim's account becomes it, and is the person's own account from
 * here on: kept as "user", it can never later read as a sweepable throwaway (a kindless record is
 * "user" only while it is the active one, lib/keystore.ts kindOf). With a home it stays kindless, and
 * the throwaway /home gathers in, as before. A home lookup that fails is the same storage failing,
 * and refuses the same way.
 */
export async function keepClaimKey(publicKey: string, seed: Uint8Array, deps: KeepKeyDeps): Promise<void> {
  try {
    const kind: AccountKind | undefined = (await deps.hasHome()) ? undefined : "user";
    await deps.save(publicKey, seed, kind);
  } catch (e) {
    throw new StorageBlockedError(e);
  } finally {
    seed.fill(0);
  }
}
