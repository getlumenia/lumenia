/**
 * What this browser knows about each account's backup (LUMENIA ACCOUNT CONTRACT v1, section 6).
 *
 * localStorage "lumenia.backups" = {"<G...>": {"email": string|null, "at": number, "bound": true|false|null}}.
 *
 *   email  the address the account was backed up with, so every surface can say WHICH email opens
 *          WHICH account ("GCFIRY...XVYOJR, backed up with f***@example.com"). null when not known:
 *          a record carried over from the old list below, or one made before this existed.
 *   bound  true only after the server said so: a 200 {"bound":true} from a signed write or a ticket
 *          bind, or /recovery-check {"mine":true}. false when the server said the row is NOT tied to
 *          this account. null when nobody has asked yet, or an older server could not say.
 *
 * WHY "bound" AND NOT JUST "backed up". The old marker (the "lumenia.backedup" list, still read here)
 * meant "a box was stored once from this browser". It could not tell a backup that only this account
 * can replace from one any holder of the inbox code can paint over, nor notice that the email has
 * since moved on to another account. The one-tap removal and the extension's account switch are
 * promises that the account comes back, so they need the stronger answer (isConfirmedBackup).
 *
 * Local-only and deliberately conservative: it can be wrong in the safe direction (a restore made
 * elsewhere reads "not backed up" and is merely asked again), never in the dangerous one. Every read
 * and write survives blocked storage, and nothing here touches localStorage when the module loads.
 */

export interface BackupRecord {
  email: string | null;
  /** When the record was written, ms since the epoch (0 for a record carried over from the old list). */
  at: number;
  bound: boolean | null;
}

const KEY = "lumenia.backups";
/** The old marker: a plain list of addresses, read as {email: null, bound: null}. */
const LEGACY_KEY = "lumenia.backedup";
/** Older emails that may still open an account after its backup email changed (W14). */
const ALSO_KEY = "lumenia.backups.also";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is BackupRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    (r.email === null || typeof r.email === "string") &&
    typeof r.at === "number" &&
    (r.bound === null || r.bound === true || r.bound === false)
  );
}

/** Every account's record, the legacy list included. Blocked or broken storage reads as empty. */
export function backupRecords(): Record<string, BackupRecord> {
  const ls = storage();
  if (!ls) return {};
  const out: Record<string, BackupRecord> = {};
  try {
    const legacy = JSON.parse(ls.getItem(LEGACY_KEY) ?? "[]") as unknown;
    if (Array.isArray(legacy)) {
      for (const pk of legacy) if (typeof pk === "string") out[pk] = { email: null, at: 0, bound: null };
    }
  } catch {
    /* an unreadable old list is the same as none */
  }
  try {
    const current = JSON.parse(ls.getItem(KEY) ?? "{}") as unknown;
    if (current && typeof current === "object" && !Array.isArray(current)) {
      for (const [pk, rec] of Object.entries(current as Record<string, unknown>)) if (isRecord(rec)) out[pk] = rec;
    }
  } catch {
    /* unreadable: nothing recorded */
  }
  return out;
}

/** This account's record, or null when this browser never saw it backed up. */
export function backupRecord(pubkey: string | undefined | null): BackupRecord | null {
  if (!pubkey) return null;
  return backupRecords()[pubkey] ?? null;
}

/**
 * Record a backup. `bound` is what the server said (see the header); a later answer of null (an
 * older server) for the SAME email keeps an earlier true or false, because "I can't say" is not news.
 */
export function markBackedUp(pubkey: string, email: string | null, bound: boolean | null, now: number = Date.now()): void {
  const ls = storage();
  if (!ls) return;
  try {
    const all = backupRecords();
    const before = all[pubkey];
    const normalized = email === null ? null : email.trim().toLowerCase();
    const keepEmail = normalized ?? before?.email ?? null;
    const keepBound = bound === null && before && before.email === keepEmail ? before.bound : bound;
    // The legacy list is folded in on every write, so it can stop being read one day.
    const next = { ...all, [pubkey]: { email: keepEmail, at: now, bound: keepBound } };
    ls.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: hasBackup() stays false, which is the safe answer */
  }
}

/** Forget what this browser knew about one account's backup (it was removed from this browser). */
export function forgetBackupRecord(pubkey: string): void {
  const ls = storage();
  if (!ls) return;
  try {
    const all = backupRecords();
    delete all[pubkey];
    ls.setItem(KEY, JSON.stringify(all));
    const legacy = JSON.parse(ls.getItem(LEGACY_KEY) ?? "[]") as unknown;
    if (Array.isArray(legacy) && legacy.includes(pubkey)) {
      ls.setItem(LEGACY_KEY, JSON.stringify(legacy.filter((x) => x !== pubkey)));
    }
  } catch {
    /* storage blocked */
  }
  setAlsoOpens(pubkey, []);
}

/**
 * Forget every account's record: the browser is being left (DisconnectButton). The email each
 * account was backed up with is personal data, kept only to show it and to ask with it, so it goes
 * with the accounts it describes.
 */
export function forgetAllBackupRecords(): void {
  const ls = storage();
  if (!ls) return;
  try {
    ls.removeItem(KEY);
    ls.removeItem(LEGACY_KEY);
    ls.removeItem(ALSO_KEY);
  } catch {
    /* storage blocked */
  }
}

/** Older emails that may still open an account after its backup email changed (W14). */

/** The emails besides the recorded one that may still open this account. */
export function alsoOpens(pubkey: string): string[] {
  const ls = storage();
  if (!ls) return [];
  try {
    const all = JSON.parse(ls.getItem(ALSO_KEY) ?? "{}") as Record<string, unknown>;
    const list = all[pubkey];
    return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

function setAlsoOpens(pubkey: string, emails: string[]): void {
  const ls = storage();
  if (!ls) return;
  try {
    const all = JSON.parse(ls.getItem(ALSO_KEY) ?? "{}") as Record<string, string[]>;
    if (emails.length) all[pubkey] = emails;
    else delete all[pubkey];
    ls.setItem(ALSO_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: nothing listed */
  }
}

/**
 * The record after "Change backup email" (W14): the new email is the account's backup email. The old
 * one is dropped when the server released it, and otherwise kept listed as "also opens this account":
 * a 409 not-yours (the old row is tied to no account, so it may still hold this account's box) or no
 * answer at all (an older server) leaves that row where it was.
 */
export function recordEmailChange(
  pubkey: string,
  change: { oldEmail: string; newEmail: string; bound: boolean | null; release: "released" | "not-yours" | "unknown" },
  now: number = Date.now(),
): void {
  const oldNorm = change.oldEmail.trim().toLowerCase();
  const newNorm = change.newEmail.trim().toLowerCase();
  // Written whole, not through markBackedUp: the bound answer belongs to the NEW email, and must
  // never inherit the old email's.
  const ls = storage();
  if (ls) {
    try {
      const all = backupRecords();
      all[pubkey] = { email: newNorm, at: now, bound: change.bound };
      ls.setItem(KEY, JSON.stringify(all));
    } catch {
      /* storage blocked */
    }
  }
  const also = alsoOpens(pubkey).filter((e) => e !== newNorm && e !== oldNorm);
  if (change.release !== "released" && oldNorm !== newNorm) also.push(oldNorm);
  setAlsoOpens(pubkey, also);
}

/**
 * Was a backup stored for this account from this browser? The weaker answer: what the pilot's
 * "locked and backed up" precondition reads, as the old marker did.
 */
export function hasBackup(pubkey: string | undefined | null): boolean {
  return backupRecord(pubkey) !== null;
}

/** Did the server confirm the backup is tied to this account? The answer one-tap removal needs. */
export function isConfirmedBackup(pubkey: string | undefined | null): boolean {
  return backupRecord(pubkey)?.bound === true;
}
