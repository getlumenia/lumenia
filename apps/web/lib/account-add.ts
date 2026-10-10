"use client";

/**
 * Bringing another account to this device WITHOUT wiping the one in use, and never letting the one
 * in use be demoted (W4).
 *
 * Two holes this closes:
 *
 *   1. The only way to restore on the website was the no-account screen, so a person who already had
 *      an account here, and wanted a second one they backed up elsewhere (the extension's, say), had
 *      to remove the first. addRestoredAccount stores the restored key BESIDE it, as a deliberate
 *      ("user") account, and moves nothing: not the active pointer, not the session.
 *
 *   2. A record written with no kind (a v2 claim's account on a fresh device, every record older
 *      than kinds) is a "user" account only while it is the active one (lib/keystore.ts kindOf). The
 *      moment anything else became active (a new account, a switch, a restore) it read as a
 *      throwaway, and /home's sweep moved its money out and CLOSED it on the ledger. pinActiveAsUser
 *      writes "user" onto the active record before any of those, and once when the app starts.
 *
 * Kept out of lib/wallet.tsx so it runs under the self-test (test:claimhome, with a fake IndexedDB).
 */
import { getActive, listAccounts, pinKindIfMissing, savePhase2, setAccountKind } from "./keystore";
import { findCopy, unwrapWithPassword, type RecoveryBox } from "./recovery";
import { localSignerFromSeed, type Signer } from "./signer";
import { MAX_USER_ACCOUNTS } from "./new-account";
import { DEFAULT_ARGON, type ArgonParams } from "./argon";

/** Pin the active account as deliberate when its record carries no kind. Returns whether it wrote. */
export async function pinActiveAsUser(): Promise<boolean> {
  const active = await getActive();
  if (!active) return false;
  return pinKindIfMissing(active.pubkey, "user");
}

/**
 * The account `password` opens `box` to, or null when it does not open (a wrong password, or a box
 * with no password copy). The seed is wiped before this returns.
 */
export async function boxOpensTo(box: RecoveryBox, password: string): Promise<string | null> {
  const copy = findCopy(box, "password");
  if (!copy || !password) return null;
  let seed: Uint8Array;
  try {
    seed = await unwrapWithPassword(copy, password);
  } catch {
    return null;
  }
  try {
    return localSignerFromSeed(seed).publicKey();
  } finally {
    seed.fill(0);
  }
}

/** The sentence a wrong password on somebody's own backup shows (contract 5.4). */
export const WRONG_BACKUP_PASSWORD = "That password doesn't open this backup.";

/**
 * Store the account `box` opens with `password` on this device, locked with that same password, as a
 * "user" account. It refuses at the per-device limit, never moves the active pointer, never sets the
 * session, and wipes the seed. An account that is already here is left as it is (marked "user" if
 * it was not), so its local password does not change behind the person's back.
 *
 * `afterSave` runs with the restored account's signer while the seed is still open: the caller uses
 * it to tie the backup row to this account, or to ask whether it already is (lib/recovery-client.ts).
 */
export async function addRestoredAccount(
  box: RecoveryBox,
  password: string,
  afterSave?: (signer: Signer) => Promise<void>,
  argon: ArgonParams = DEFAULT_ARGON,
): Promise<{ address: string; alreadyHere: boolean }> {
  const copy = findCopy(box, "password");
  if (!copy) throw new Error("This backup can only be opened with Face ID.");
  let seed: Uint8Array;
  try {
    seed = await unwrapWithPassword(copy, password);
  } catch {
    throw new Error(WRONG_BACKUP_PASSWORD);
  }
  try {
    const signer = localSignerFromSeed(seed);
    const address = signer.publicKey();
    const all = await listAccounts();
    const here = all.find((a) => a.pubkey === address);
    if (!here) {
      if (all.filter((a) => a.kind === "user").length >= MAX_USER_ACCOUNTS) {
        throw new Error(`You already have ${MAX_USER_ACCOUNTS} accounts on this phone.`);
      }
      // Before anything else exists beside it: the active one stays a deliberate account.
      await pinActiveAsUser();
      // "user" adopts the home pointer only when there is none (lib/keystore.ts adoptHomeIfUnset).
      await savePhase2(address, seed, password, argon, "user");
    } else if (here.kind !== "user") {
      await setAccountKind(address, "user");
    }
    await afterSave?.(signer);
    return { address, alreadyHere: Boolean(here) };
  } finally {
    seed.fill(0);
  }
}
