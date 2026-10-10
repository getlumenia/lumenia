/**
 * Leaving this device, and removing one account from it, decided in one pure place (W5).
 *
 * "Leave this device" wipes EVERY account on this browser (lib/keystore.ts clearKeystore), but its
 * confirmation used to look at the active account alone: a second deliberate account that was never
 * backed up, or a claimed link's money still on its way into the active account, went with it after
 * a single tap. And "backed up" meant "a box was stored from here once", which stays true after the
 * email's row has gone on to back up another account.
 *
 * So the one-tap tier is for exactly one case: EVERY deliberate account here has a backup the
 * server confirmed is tied to it (lib/backup-record.ts isConfirmedBackup), no account is known to
 * be untied by a fresh check, and no claim account still holds money. Anything else is typed.
 */
import type { BackupRecord } from "./backup-record";

export type DisconnectTier = "one-tap" | "typed";

export function disconnectTier(opts: {
  /** The deliberate accounts on this device, the active one included. */
  userAccounts: readonly string[];
  records: Readonly<Record<string, BackupRecord | undefined>>;
  /** A claim account still holds money, or that could not be read (unknown counts as yes). */
  throwawayWithMoney: boolean;
  /** Accounts a fresh /recovery-check answered "not mine" for. */
  notMine?: readonly string[];
}): DisconnectTier {
  if (opts.throwawayWithMoney) return "typed";
  for (const a of opts.userAccounts) {
    if (opts.records[a]?.bound !== true) return "typed";
    if (opts.notMine?.includes(a)) return "typed";
  }
  return "one-tap";
}

/** The accounts the typed tier names, as "{short}: no confirmed backup". */
export function unconfirmedAccounts(opts: {
  userAccounts: readonly string[];
  records: Readonly<Record<string, BackupRecord | undefined>>;
  notMine?: readonly string[];
}): string[] {
  return opts.userAccounts.filter((a) => opts.records[a]?.bound !== true || opts.notMine?.includes(a));
}
