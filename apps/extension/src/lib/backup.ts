/**
 * Back up an account that was made in this extension: email -> one-time code, and the account's
 * password copy (made when the account was, ciphertext only) is stored on Lumenia's server, where
 * a restore on any device finds it. The same route and the same box format as the website's
 * "Back up your money" card, so the website can restore it too.
 *
 * Nothing new is decrypted here: the box was wrapped with the account password when the account
 * was created (background/account.ts createAccount). The signature that binds the stored row to
 * this account comes from the unlocked key, so a backup needs an unlocked extension.
 */
import type { RecoveryBox, Signer } from "../core";
import { ExtError, fail } from "./errors";
import { networkFailure, normalizeCode, validEmail } from "./restore";

export interface BackupDeps {
  requestOtp(email: string): Promise<void>;
  store(email: string, code: string, box: RecoveryBox, signer: Signer | undefined): Promise<void>;
}

/** Step 1: mail a code to `email`. */
export async function startBackup(deps: BackupDeps, email: string): Promise<void> {
  if (!validEmail(email)) throw fail("bad-email");
  try {
    await deps.requestOtp(email.trim());
  } catch (e) {
    throw networkFailure(e, "We couldn't send the code. Try again.");
  }
}

/**
 * The sponsor's own refusals of a write it will not take, in its words (apps/sponsor/src/lib/
 * recovery-store.ts, PublicRefusal): an address that already holds another account's backup, or a
 * bound row that needs that account's signature. Nothing was stored.
 */
const REFUSED = /already holds a backup for a different account|needs a signature from the account/i;

/** Step 2: trade the code for a stored backup. */
export async function finishBackup(deps: BackupDeps, email: string, code: string, box: RecoveryBox, signer: Signer | undefined): Promise<void> {
  const c = normalizeCode(code);
  if (!/^\d{6}$/.test(c)) throw fail("bad-code");
  try {
    await deps.store(email.trim(), c, box, signer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/wrong or has expired/i.test(msg)) throw fail("bad-code");
    if (REFUSED.test(msg)) throw new ExtError("backup-refused", msg.trim().replace(/\.?$/, "."));
    throw networkFailure(e, "We couldn't store your backup. Try again.");
  }
}
