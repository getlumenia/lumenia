/**
 * How every surface names an account (LUMENIA ACCOUNT CONTRACT v1, sections 0.3 and 5.3).
 *
 * One person may keep several Lumenia accounts, each backed up with its own email, and the website
 * and the extension may be holding different ones. The fix for "which email belongs to which
 * account?" is to say it, the same way, everywhere: the account's short address and the email that
 * backs it up. The extension carries the same three helpers in its own package (contract 0.5).
 *
 * Plain ASCII on purpose: the ellipsis is three full stops, so an address reads the same in a toast,
 * an email and a log line. Pure; loads with no window or localStorage.
 */
import type { BackupRecord } from "./backup-record";

/** short(G): the first 6 characters, "...", the last 6. */
export function shortAddress(address: string): string {
  return address.length <= 15 ? address : `${address.slice(0, 6)}...${address.slice(-6)}`;
}

/**
 * masked(email): the first character of the part before the LAST "@", then "***@", then the domain,
 * all lowercase. Enough to recognise your own address, not enough to read someone else's.
 */
export function maskEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e ? `${e[0]}***` : "";
  return `${e[0]}***@${e.slice(at + 1)}`;
}

/** The account line (contract 5.3), and the one action it may carry. */
export interface AccountLine {
  text: string;
  action: "add-email" | "back-up-again" | null;
}

/**
 *   no record                      "{short}, not backed up yet"
 *   the server said NOT tied       "{short}, backup not tied to this account yet"  + Back it up again
 *   an email is known              "{short}, backed up with {masked}"
 *   backed up, email not known     "{short}, backed up"                            + Add your backup email
 */
export function accountLine(address: string, record: BackupRecord | null): AccountLine {
  const short = shortAddress(address);
  if (!record) return { text: `${short}, not backed up yet`, action: null };
  if (record.bound === false) return { text: `${short}, backup not tied to this account yet`, action: "back-up-again" };
  if (record.email) return { text: `${short}, backed up with ${maskEmail(record.email)}`, action: null };
  return { text: `${short}, backed up`, action: "add-email" };
}

/** The label of each account-line action. */
export const ACCOUNT_LINE_ACTION: Record<NonNullable<AccountLine["action"]>, string> = {
  "add-email": "Add your backup email",
  "back-up-again": "Back it up again",
};

/** When an email added under "Add your backup email" does not check out. */
export const NOT_THIS_ACCOUNTS_EMAIL = "That email doesn't back up this account.";
