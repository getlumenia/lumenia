"use client";

/**
 * Creating a brand-new account — the one path into Lumenia that does not start with somebody
 * sending you money (docs/IDENTITY_AND_ACCOUNTS.md §4.4).
 *
 * Mechanically it is the sponsored onboarding sandwich with no claim attached: a keypair is
 * generated on this device, the sponsor opens the account with a USDC trustline and covers both
 * reserves, and the account's own key co-signs. The account holds 0 XLM and is ready to receive.
 *
 * ORDER IS THE SAFETY PROPERTY. The key is written to the keystore BEFORE anything is spent on
 * chain. If the network call fails after the account exists, the worst case is a record for an
 * account that is fine; the reverse order's worst case is an account funded with reserves whose
 * key nobody has. That has cost real money on this project before, and it is why the write comes
 * first here even though it makes the failure path slightly noisier.
 *
 * The new account lands at Phase 1 (device key, no password), exactly like a Face-ID restore, and
 * the caller is expected to offer the password step immediately. Real money cannot be sent from a
 * Phase-1 account at all — getSigner() refuses on mainnet — so the prompt is not cosmetic.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { savePhase1, setActive, listAccounts } from "./keystore";
import { localSignerFromSeed } from "./signer";
import { prepareAccount } from "./sponsor";

/** A device holds at most this many deliberate accounts. A bound against a stuck loop, not a target. */
export const MAX_USER_ACCOUNTS = 8;

export interface CreateAccountResult {
  address: string;
  /** The on-chain transaction that opened it, when the sponsor completed the sandwich. */
  hash?: string;
}

export async function createUserAccount({
  sponsorUrl,
  makeActive = true,
}: {
  sponsorUrl: string;
  makeActive?: boolean;
}): Promise<CreateAccountResult> {
  const existing = (await listAccounts()).filter((a) => a.kind === "user");
  if (existing.length >= MAX_USER_ACCOUNTS) {
    throw new Error(`You already have ${MAX_USER_ACCOUNTS} accounts on this phone.`);
  }

  const kp = Keypair.random();
  const address = kp.publicKey();
  /**
   * An EXPLICIT copy. `Keypair.rawSecretKey()` hands back the live buffer rather than a copy, so
   * zeroing what it returns destroys the keypair itself — every later signature would be made by a
   * key of zeros, for an account nobody owns. Copy once, hand the copy around, wipe the copy.
   */
  const seed = Uint8Array.from(kp.rawSecretKey());
  // The signer takes its own copy of the bytes (localSignerFromSeed → Buffer.from), so it survives
  // the wipe below. Built before anything is spent, and used only after the key is stored.
  const signer = localSignerFromSeed(seed);

  // WRITE FIRST — see the note at the top of this file.
  try {
    await savePhase1(address, seed, "user");
  } finally {
    seed.fill(0);
  }

  // The keystore is the source of truth for "this account is mine", so a failure here leaves a
  // recoverable state: the key is safe, and the account simply does not exist on chain yet.
  const { hash } = await prepareAccount({ sponsorUrl, signer });

  if (makeActive) await setActive(address);
  return { address, hash };
}
