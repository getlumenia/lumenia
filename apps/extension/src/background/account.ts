/**
 * The one account this extension holds: made here, or restored from the user's own backup, kept as
 * a Phase-2 record (Argon2id + AES-GCM under their password) in this extension's IndexedDB,
 * unlocked into storage.session for a limited time. An account made here exists only in this
 * browser until it is backed up with an email (backupRequestCode / backupSubmitCode).
 *
 * Every signature goes through `signerFor`, which refuses unless the session is unexpired AND
 * belongs to the account being signed for, decodes the seed, builds the signer and zeroes the bytes
 * it decoded. The key never reaches the popup.
 *
 * One email backs up one account (LUMENIA ACCOUNT CONTRACT v1). This browser records, per account,
 * the email it is backed up with and whether the server confirmed that backup as the account's own
 * (`bound`); a backup or a restore that meets an email already backing up ANOTHER account never
 * overwrites it and never forks it silently: the person brings that account here, uses another
 * email, or (only for a backup tied to no account yet) replaces it on purpose.
 */
import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";
import {
  clearKeystore,
  DEFAULT_ARGON,
  emptyBox,
  findCopy,
  getActive,
  localSignerFromSeed,
  passwordStrength,
  putCopy,
  requestRecoveryOtp,
  savePhase2,
  unlockPhase2,
  unwrapWithPassword,
  wrapWithPassword,
  type RecoveryBox,
  type Signer,
} from "../core";
import { finishBackup, startBackup, type BackupDeps } from "../lib/backup";
import { ext } from "../lib/browser";
import { ExtError, MESSAGES, UNCONFIRMED_LOSS, fail, openLinksMessage } from "../lib/errors";
import { sameEmail } from "../lib/identity";
import { asRecord, isLinkKey } from "../lib/links";
import { BackupConflict, checkMine, fetchBox, releaseEmail, storeBox } from "../lib/recovery-client";
import { openBox, startRestore, submitCode, validEmail, type RestoreDeps } from "../lib/restore";
import { canSign, isUnlocked, LOCKED, reduce, type SessionView } from "../lib/session";
import { forgetSealed, forgetSealedIds, linksKeyFromSeed } from "../lib/sealed";
import {
  K,
  backupRecordFor,
  dropBackupRecord,
  local,
  migrateLegacyBackup,
  readSettings,
  session,
  writeBackupRecord,
  writeSettings,
} from "../lib/storage";
import type { BackupRecord, BackupView, LinkRecord } from "../lib/types";

export const AUTOLOCK_ALARM = "autolock";

interface RestoreState {
  step: "code" | "password";
  email: string;
  codeSentAt: number;
  box?: RecoveryBox;
  /** what the host said of the backup: tied to an account (true), not yet (false), or nothing (null: an older host) */
  bound?: boolean | null;
  /** only for a backup tied to no account yet: lets the restored key bind it once, without a second code */
  ticket?: string;
  /** "Use another account": the account it opens replaces the one held here, whose backup is confirmed */
  switching?: boolean;
}

const publicKeyOf = (seed: Uint8Array): string => Keypair.fromRawEd25519Seed(Buffer.from(seed)).publicKey();

const restoreDeps: RestoreDeps = {
  requestOtp: requestRecoveryOtp,
  fetchBox,
  findPasswordCopy: (box) => findCopy(box, "password"),
  unwrap: unwrapWithPassword,
  publicKeyOf,
  save: async (pubkey, seed, password) => {
    await savePhase2(pubkey, seed, password, DEFAULT_ARGON, "user");
  },
};

const backupDeps: BackupDeps = {
  requestOtp: requestRecoveryOtp,
  store: (email, code, box, signer) => storeBox({ email, code, box, signer }),
};

/**
 * The account held here, from the keystore (the truth), or null. The storage.local mirror that
 * scopes the link records (records.ts) follows it: a mirror lost to a write that never finished
 * (the keystore is written first) is put back here, so the account's records are never hidden.
 */
export async function currentAccount(): Promise<{ pubkey: string; phase: 1 | 2 } | null> {
  try {
    const a = await getActive();
    if (!a) return null;
    const mirror = await local().get<{ pubkey?: string }>(K.account);
    if (mirror?.pubkey !== a.pubkey) await local().set({ [K.account]: { pubkey: a.pubkey, restoredAt: Date.now() } });
    return { pubkey: a.pubkey, phase: a.phase };
  } catch {
    return null;
  }
}

async function requireConsent(): Promise<void> {
  if (!(await readSettings()).consentAt) throw fail("needs-consent");
}

/** The account held here with the email it is backed up with, for the popup (WorkerState.account). */
export async function accountView(): Promise<{ pubkey: string; email: string | null; bound: boolean | null } | null> {
  const acct = await currentAccount();
  if (!acct) return null;
  const rec = await backupRecordFor(acct.pubkey);
  return { pubkey: acct.pubkey, email: rec?.email ?? null, bound: rec?.bound ?? null };
}

/* --------------------------------- restore --------------------------------- */

export async function restoreState(): Promise<{ step: "code" | "password"; email: string; codeSentAt: number; switching: boolean } | null> {
  const r = await session().get<RestoreState>(K.restore);
  return r ? { step: r.step, email: r.email, codeSentAt: r.codeSentAt, switching: r.switching === true } : null;
}

/**
 * The held account may leave this browser for another one only when its backup is confirmed as its
 * own (bound): it can then be brought back with its email and password, links and all. A backup
 * the server never confirmed is checked once more here when the extension is unlocked.
 */
async function requireConfirmedBackup(pubkey: string): Promise<void> {
  const rec = await backupRecordFor(pubkey);
  if (rec?.bound === true) return;
  if (rec && rec.email === null) throw new ExtError("needs-backup", "Add your backup email first.");
  if (rec?.email && (await isUnlockedNow()).unlocked) {
    const signer = await signerFor(pubkey).catch(() => null);
    if (signer && (await checkMine(rec.email, signer)).answer === "mine") {
      await writeBackupRecord(pubkey, { ...rec, bound: true });
      return;
    }
  }
  throw new ExtError("needs-backup", "Back this account up first. It lives only in this browser.");
}

/**
 * Restore, step 1: mail a code to `email`. With no account held, this brings one here. `switching`
 * ("Use another account" in Settings) brings another account in place of the one held, which must
 * be confirmed backed up first; the router also refuses it while a link is being made or taken back.
 */
export async function restoreRequestCode(email: string, opts: { switching?: boolean } = {}): Promise<{ codeSentAt: number }> {
  await requireConsent();
  const held = await currentAccount();
  if (opts.switching && held) await requireConfirmedBackup(held.pubkey);
  else if (held) throw new ExtError("internal", "An account is already connected here. Forget it in Settings first.");
  await startRestore(restoreDeps, email);
  const codeSentAt = Date.now();
  await session().set({
    [K.restore]: { step: "code", email: email.trim(), codeSentAt, ...(opts.switching && held ? { switching: true } : {}) } satisfies RestoreState,
  });
  return { codeSentAt };
}

export async function restoreSubmitCode(code: string): Promise<{ step: "password" }> {
  await requireConsent();
  const r = await session().get<RestoreState>(K.restore);
  if (!r) throw new ExtError("internal", "Start again: enter your email.");
  const got = await submitCode(restoreDeps, r.email, code);
  await session().set({
    [K.restore]: { ...r, step: "password", box: got.box, bound: got.bound, ...(got.ticket ? { ticket: got.ticket } : {}) } satisfies RestoreState,
  });
  return { step: "password" };
}

/**
 * After a restore: tie the backup to the restored key when it is tied to no account yet (the same
 * box, the ticket, `replace`, the restored key's signature), or ask whether a tied one is this
 * account's own. Never fails the restore: the account is here either way; the answer is recorded.
 */
async function settleRestoredBackup(r: RestoreState, signer: Signer): Promise<boolean | null> {
  if (r.bound === false && r.ticket && r.box) {
    try {
      const { bound } = await storeBox({ email: r.email, box: r.box, ticket: r.ticket, signer, replace: true });
      return bound === true ? true : bound === false ? false : null;
    } catch {
      return false; // the host said it is tied to no account, and the bind did not go through
    }
  }
  if (r.bound === false) return false;
  const { answer } = await checkMine(r.email, signer);
  return answer === "mine" ? true : answer === "not-mine" ? false : null;
}

/**
 * Restore, step 3: open the backup with its password and keep the account here. In switching mode
 * the account held is replaced (its link records and kept links stay, scoped to it, and show again
 * when it is brought back); the same account opened again changes nothing.
 */
export async function restoreSubmitPassword(password: string): Promise<{ pubkey: string; email: string; bound: boolean | null; same: boolean }> {
  await requireConsent();
  const r = await session().get<RestoreState>(K.restore);
  if (!r?.box) throw new ExtError("internal", "Start again: enter your email.");
  const held = await currentAccount();
  const switchFrom = r.switching && held ? held.pubkey : null;
  // Checked BEFORE the box is opened, because opening it also writes the key record: one account
  // per extension, and a second one must never be written next to the first.
  if (held && !switchFrom) throw new ExtError("internal", "An account is already connected here. Forget it in Settings first.");
  if (switchFrom) await requireConfirmedBackup(switchFrom);
  const deps: RestoreDeps = switchFrom
    ? {
        ...restoreDeps,
        save: async (pubkey, seed, pw) => {
          if (pubkey === switchFrom) return; // the account held here: nothing to change
          await replaceHeldAccount(switchFrom, pubkey, seed, pw);
        },
      }
    : restoreDeps;
  const { pubkey, seed } = await openBox(deps, r.box, password);
  const same = pubkey === switchFrom;
  let bound: boolean | null;
  try {
    if (!same) {
      await startSession(pubkey, seed);
      // Restored from a backup: nothing is owed for this account (a copy left by an interrupted
      // create of another key is not this account's).
      await local().set({ [K.account]: { pubkey, restoredAt: Date.now() } });
      await local().remove(K.pendingBackup);
    }
    bound = await settleRestoredBackup(r, localSignerFromSeed(seed));
  } finally {
    seed.fill(0);
  }
  // A host that could not say keeps what this browser already knew, but only about the same email.
  const before = await backupRecordFor(pubkey);
  const kept = same && before?.email && sameEmail(before.email, r.email) ? before.bound : null;
  await writeBackupRecord(pubkey, { email: r.email, at: Date.now(), bound: bound ?? kept });
  await session().remove(K.restore);
  return { pubkey, email: r.email, bound, same };
}

/**
 * The account held here leaves this browser for another one. Its key record goes. Its link records
 * and kept links stay in storage, scoped to it (records.ts), so they show again when it is brought
 * back, unless `dropLinks`: an account that was never backed up can never be brought back, and its
 * kept links only its key opens go with it. Settings and consent stay; real money goes back to
 * practice money, because the incoming account's standing is its own.
 */
async function leaveHeldAccount(pubkey: string, opts: { dropLinks: boolean }): Promise<void> {
  await migrateLegacyBackup();
  await lock();
  await clearKeystore();
  if (opts.dropLinks) {
    const all = await local().getAll();
    const keys: string[] = [];
    const ids: string[] = [];
    for (const [k, v] of Object.entries(all)) {
      if (!isLinkKey(k)) continue;
      const r = asRecord(v);
      if (r && r.sender === pubkey) {
        keys.push(k);
        ids.push(r.linkHex);
      }
    }
    if (keys.length > 0) await local().remove(keys);
    await forgetSealedIds(ids);
    await dropBackupRecord(pubkey);
  }
  await local().remove(K.pendingBackup);
  await session().remove([K.pilot(pubkey), K.backup, K.backupConflict, K.rebackup]);
  await writeSettings({ net: "testnet" });
}

/** Switching: `oldPubkey` leaves (its links stay, scoped to it) and `pubkey` is kept here in its place. */
async function replaceHeldAccount(oldPubkey: string, pubkey: string, seed: Uint8Array, password: string): Promise<void> {
  await leaveHeldAccount(oldPubkey, { dropLinks: false });
  await savePhase2(pubkey, seed, password, DEFAULT_ARGON, "user");
  await local().set({ [K.account]: { pubkey, restoredAt: Date.now() } });
}

export async function restoreCancel(): Promise<null> {
  await session().remove(K.restore);
  return null;
}

/* --------------------------------- a new account, made here --------------------------------- */

/**
 * Make a new account in this extension, locked with `password` (the website's own Phase-2 record:
 * Argon2id + AES-GCM). The same password wraps the account's backup copy, kept here as ciphertext
 * until the person backs it up with an email; until then the account exists only in this browser,
 * and the popup says so. The password has to pass the website's own floor (password-strength.ts):
 * once backed up, its copy sits on a server where it can be attacked offline.
 *
 * The backup copy and the mirror are written BEFORE the key record. A worker that dies in between
 * leaves no account (the keystore is the truth) rather than an account that reads as backed up; one
 * that dies after it leaves an account whose backup is still owed, which backupView says (no record
 * of a backup) and unlock repairs (it wraps the copy again from the typed password).
 */
export async function createAccount(password: string): Promise<{ pubkey: string }> {
  await requireConsent();
  if (await currentAccount()) throw new ExtError("internal", "An account is already connected here. Forget it in Settings first.");
  const strength = passwordStrength(password);
  if (!strength.ok) throw new ExtError("weak-password", strength.reason ?? "Pick a stronger password.");
  const kp = Keypair.random();
  const pubkey = kp.publicKey();
  const seed = new Uint8Array(kp.rawSecretKey());
  try {
    const box = putCopy(emptyBox(), await wrapWithPassword(seed, password));
    await local().set({ [K.account]: { pubkey, restoredAt: Date.now() }, [K.pendingBackup]: box });
    await savePhase2(pubkey, seed, password, DEFAULT_ARGON, "user");
    await startSession(pubkey, seed);
  } finally {
    seed.fill(0);
  }
  return { pubkey };
}

/* --------------------------------- backup --------------------------------- */

interface BackupState {
  email: string;
  codeSentAt: number;
}

/** After the code: the email already backs up another account (LUMENIA ACCOUNT CONTRACT v1, 5.4). */
interface ConflictState {
  email: string;
  /** that account's backup, as the server returned it (ciphertext) */
  box: RecoveryBox;
  /** it is tied to no account yet */
  unbound: boolean;
  /** single use, 600 s: binds or replaces an untied row without a second code */
  ticket?: string;
  /** the account the box opened to, once a password opened it */
  other?: string;
}

export async function backupView(): Promise<BackupView> {
  const [pending, b, c, again, acct] = await Promise.all([
    local().get<RecoveryBox>(K.pendingBackup),
    session().get<BackupState>(K.backup),
    session().get<ConflictState>(K.backupConflict),
    session().get<RecoveryBox>(K.rebackup),
    currentAccount(),
  ]);
  // Backed up only when something positive says so: a record for this account (a backup or a
  // restore), or the marker 0.1.3 kept. A key record with neither may exist only here.
  const noRecord = acct ? (await backupRecordFor(acct.pubkey)) === null : false;
  return {
    needed: Boolean(pending) || noRecord,
    step: b ? "code" : null,
    email: b?.email ?? "",
    codeSentAt: b?.codeSentAt ?? null,
    conflict: c ? { email: c.email, unbound: c.unbound, ticket: Boolean(c.ticket), other: c.other ?? null } : null,
    again: Boolean(again),
  };
}

/** The copy a backup stores: a new one for a changed email (backup.again), or the one made with the account. */
async function backingUpBox(): Promise<RecoveryBox> {
  const again = await session().get<RecoveryBox>(K.rebackup);
  if (again) return again;
  const box = await local().get<RecoveryBox>(K.pendingBackup);
  if (!box) throw new ExtError("internal", "This account is already backed up.");
  return box;
}

/** Back up, step 1: mail a code to `email`. */
export async function backupRequestCode(email: string): Promise<{ codeSentAt: number }> {
  await requireConsent();
  if (!(await currentAccount())) throw fail("no-account");
  await backingUpBox();
  await startBackup(backupDeps, email);
  const codeSentAt = Date.now();
  await session().set({ [K.backup]: { email: email.trim(), codeSentAt } satisfies BackupState });
  await session().remove(K.backupConflict);
  return { codeSentAt };
}

/**
 * A backup was stored for `pubkey` under `email`: record it, drop the copies that waited for it,
 * and, when it replaced a backup under ANOTHER email, let that email stop opening this account.
 */
async function backedUp(pubkey: string, email: string, bound: boolean | null, signer: Signer): Promise<number> {
  const before = await backupRecordFor(pubkey);
  const at = Date.now();
  await writeBackupRecord(pubkey, { email, at, bound });
  await local().remove(K.pendingBackup);
  await session().remove([K.backup, K.backupConflict, K.rebackup]);
  if (before?.email && !sameEmail(before.email, email)) await releaseEmail(before.email, signer);
  return at;
}

/**
 * Back up, step 2: the code stores the box. The unlocked key signs the row to this account, so a
 * later write by whoever reads the mailbox is refused; a locked extension is refused here first.
 * An email that already backs up another account stores nothing: the conflict is kept (with that
 * account's backup and, when it is tied to no account yet, a ticket) for the person to choose.
 */
export async function backupSubmitCode(code: string): Promise<{ backedUpAt: number; bound: boolean | null }> {
  await requireConsent();
  const acct = await currentAccount();
  if (!acct) throw fail("no-account");
  const b = await session().get<BackupState>(K.backup);
  if (!b) throw new ExtError("internal", "Start again: enter your email.");
  const box = await backingUpBox();
  const signer = await signerFor(acct.pubkey);
  let bound: boolean | null;
  try {
    ({ bound } = await finishBackup(backupDeps, b.email, code, box, signer));
  } catch (e) {
    if (e instanceof BackupConflict) {
      await session().set({
        [K.backupConflict]: { email: b.email, box: e.box, unbound: e.unbound, ...(e.ticket ? { ticket: e.ticket } : {}) } satisfies ConflictState,
      });
      throw new ExtError("email-taken", MESSAGES["email-taken"]);
    }
    throw e;
  }
  return { backedUpAt: await backedUp(acct.pubkey, b.email, bound, signer), bound };
}

/**
 * "Use another email" (and "Use a different email"): back to the email step. `end` also drops a new
 * copy made for Change backup email, which ends that flow.
 */
export async function backupCancel(opts: { end?: boolean } = {}): Promise<null> {
  await session().remove(opts.end ? [K.backup, K.backupConflict, K.rebackup] : [K.backup, K.backupConflict]);
  return null;
}

/**
 * Change backup email, or Back it up again: the password opens this account's key, and a new
 * backup copy is wrapped from it for the email the person gives next. The account's key never leaves
 * the worker; the copy is ciphertext and lives in the session until it is stored.
 */
export async function backupAgain(password: string): Promise<null> {
  await requireConsent();
  const acct = await currentAccount();
  if (!acct) throw fail("no-account");
  if (acct.phase !== 2) throw fail("needs-password");
  let seed: Uint8Array;
  try {
    ({ seed } = await unlockPhase2(password, acct.pubkey));
  } catch {
    throw new ExtError("bad-password", "That password doesn't unlock this account.");
  }
  try {
    if (publicKeyOf(seed) !== acct.pubkey) throw new ExtError("internal", "The unlocked key does not match this account.");
    const box = putCopy(emptyBox(), await wrapWithPassword(seed, password));
    await session().set({ [K.rebackup]: box });
    await session().remove([K.backup, K.backupConflict]);
  } finally {
    seed.fill(0);
  }
  return null;
}

/**
 * The email backs up a backup tied to no account yet, and the person chose to replace it (typed
 * REPLACE in the popup): this account's copy is stored in its place and tied to this account, with
 * the ticket the conflict handed back (no second code). A tied backup is never replaced.
 */
export async function backupReplace(): Promise<{ backedUpAt: number; bound: boolean | null }> {
  await requireConsent();
  const acct = await currentAccount();
  if (!acct) throw fail("no-account");
  const c = await session().get<ConflictState>(K.backupConflict);
  if (!c) throw new ExtError("internal", "Start again: enter your email.");
  if (!c.unbound || !c.ticket) throw new ExtError("email-taken", "Only a backup that isn't tied to any account can be replaced. Use another email for this one.");
  const signer = await signerFor(acct.pubkey);
  const box = await backingUpBox();
  const { bound } = await storeBox({ email: c.email, box, ticket: c.ticket, signer, replace: true });
  return { backedUpAt: await backedUp(acct.pubkey, c.email, bound, signer), bound };
}

/**
 * "Bring that account here": the password the person typed opens the backup the email holds.
 *
 *   - It opens to THIS account (its own older backup, tied to no account yet): that row is tied to
 *     this account with the ticket and this account's copy is stored (no second code).
 *   - It opens to ANOTHER account: this browser's account was never backed up, so the switch deletes
 *     it here for good. Refused unless the person said so (`loseAccount`), and while its links are
 *     still open unless they said so too (`leaveOpenLinks`). Then only this account's key, records
 *     and kept links go (settings and consent stay), and the other account comes in through the
 *     restore path: kept here, unlocked, its email recorded, its backup tied to it or checked.
 */
export async function backupUseExisting(
  password: string,
  opts: { loseAccount?: boolean; leaveOpenLinks?: boolean; open: LinkRecord[] },
): Promise<{ pubkey: string; same: boolean; bound: boolean | null }> {
  await requireConsent();
  const acct = await currentAccount();
  if (!acct) throw fail("no-account");
  const c = await session().get<ConflictState>(K.backupConflict);
  if (!c) throw new ExtError("internal", "Start again: enter your email.");
  const copy = findCopy(c.box, "password");
  if (!copy) throw fail("no-password-copy");
  let seed: Uint8Array;
  try {
    seed = await unwrapWithPassword(copy, password);
  } catch (e) {
    if (/settings this app doesn't support/i.test(e instanceof Error ? e.message : "")) throw fail("unsupported-backup");
    throw fail("bad-password");
  }
  try {
    if (seed.length !== 32) throw fail("unsupported-backup");
    const other = publicKeyOf(seed);
    const signer = localSignerFromSeed(seed);
    if (other === acct.pubkey) {
      if (!c.unbound || !c.ticket) throw new ExtError("internal", "That backup is already this account's. Send a new code and try again.");
      const { bound } = await storeBox({ email: c.email, box: await backingUpBox(), ticket: c.ticket, signer, replace: true });
      await backedUp(acct.pubkey, c.email, bound, signer);
      return { pubkey: acct.pubkey, same: true, bound };
    }
    await session().set({ [K.backupConflict]: { ...c, other } satisfies ConflictState });
    // Leaving this browser costs nothing only for an account whose backup is confirmed as its own;
    // one with no backup at all (or none confirmed) may be lost for good, and so may its open links.
    const rec = await backupRecordFor(acct.pubkey);
    const lost = (await backupView()).needed;
    const confirmed = rec?.bound === true && !lost;
    if (!confirmed && !opts.loseAccount) throw new ExtError("not-backed-up", lost ? MESSAGES["not-backed-up"] : UNCONFIRMED_LOSS);
    if (!confirmed && opts.open.length > 0 && !opts.leaveOpenLinks) throw new ExtError("open-links", openLinksMessage(opts.open));
    await leaveHeldAccount(acct.pubkey, { dropLinks: lost });
    await savePhase2(other, seed, password, DEFAULT_ARGON, "user");
    await local().set({ [K.account]: { pubkey: other, restoredAt: Date.now() } });
    await startSession(other, seed);
    const bound = await settleRestoredBackup(
      { step: "password", email: c.email, codeSentAt: 0, box: c.box, bound: c.unbound ? false : true, ...(c.ticket ? { ticket: c.ticket } : {}) },
      signer,
    );
    await writeBackupRecord(other, { email: c.email, at: Date.now(), bound });
    await session().remove(K.backupConflict);
    return { pubkey: other, same: false, bound };
  } finally {
    seed.fill(0);
  }
}

/**
 * Add your backup email (a record from 0.1.3 or earlier, which never kept it): a signed question to
 * the recovery host, which needs no code and answers only "is this email this account's own backup".
 */
export async function checkBackupEmail(email: string): Promise<BackupRecord> {
  await requireConsent();
  const acct = await currentAccount();
  if (!acct) throw fail("no-account");
  if (!validEmail(email)) throw fail("bad-email");
  const signer = await signerFor(acct.pubkey);
  const { answer, reason } = await checkMine(email.trim(), signer);
  if (answer === "not-mine") throw fail("backup-not-mine");
  if (answer !== "mine") throw new ExtError("internal", reason && /clock/i.test(reason) ? reason : "We couldn't check that just now. Try again later.");
  const rec: BackupRecord = { email: email.trim(), at: Date.now(), bound: true };
  await writeBackupRecord(acct.pubkey, rec);
  return rec;
}

/* --------------------------------- session --------------------------------- */

export async function sessionView(): Promise<SessionView> {
  const got = await session().get<string>(K.unlockedPubkey);
  const lockAt = await session().get<number>(K.lockAt);
  return got && typeof lockAt === "number" ? { pubkey: got, lockAt } : LOCKED;
}

async function scheduleAutolock(lockAt: number): Promise<void> {
  try {
    await ext.alarms.create(AUTOLOCK_ALARM, { when: lockAt });
  } catch {
    /* the lockAt check in signerFor still holds without the alarm */
  }
}

async function startSession(pubkey: string, seed: Uint8Array): Promise<number> {
  const { autolockMin } = await readSettings();
  const view = reduce(LOCKED, { type: "unlock", pubkey, now: Date.now(), autolockMin });
  await session().set({
    [K.seed]: Buffer.from(seed).toString("base64"),
    [K.unlockedPubkey]: pubkey,
    [K.lockAt]: view.lockAt,
  });
  await scheduleAutolock(view.lockAt!);
  return view.lockAt!;
}

export async function unlock(password: string): Promise<{ lockAt: number }> {
  const acct = await currentAccount();
  if (!acct) throw fail("no-account");
  if (acct.phase !== 2) throw fail("needs-password");
  let seed: Uint8Array;
  try {
    ({ seed } = await unlockPhase2(password, acct.pubkey));
  } catch {
    throw new ExtError("bad-password", "That password doesn't unlock this account.");
  }
  try {
    if (Keypair.fromRawEd25519Seed(Buffer.from(seed)).publicKey() !== acct.pubkey) {
      throw new ExtError("internal", "The unlocked key does not match this account.");
    }
    // An account with no backup this browser knows of, and no copy waiting to be backed up (a create
    // the worker did not live to finish): the typed password wraps that copy again, so "Back it up"
    // has something to store.
    if ((await backupView()).needed && !(await local().get(K.pendingBackup))) {
      await local().set({ [K.pendingBackup]: putCopy(emptyBox(), await wrapWithPassword(seed, password)) });
    }
    return { lockAt: await startSession(acct.pubkey, seed) };
  } finally {
    seed.fill(0);
  }
}

export async function lock(): Promise<null> {
  await session().remove([K.seed, K.unlockedPubkey, K.lockAt]);
  try {
    await ext.alarms.clear(AUTOLOCK_ALARM);
  } catch {
    /* no alarm to clear */
  }
  return null;
}

/** Activity: push the auto-lock back to a full idle period from now. An expired session locks. */
export async function touch(): Promise<void> {
  const view = await sessionView();
  if (!view.pubkey) return;
  const { autolockMin } = await readSettings();
  const next = reduce(view, { type: "touch", now: Date.now(), autolockMin });
  if (!next.pubkey) {
    await lock();
    return;
  }
  await session().set({ [K.lockAt]: next.lockAt });
  await scheduleAutolock(next.lockAt!);
}

export async function isUnlockedNow(): Promise<{ unlocked: boolean; lockAt: number | null }> {
  const view = await sessionView();
  const now = Date.now();
  if (!isUnlocked(view, now)) {
    // An expired session, or a seed left without a valid deadline: either way it must not linger.
    if (view.pubkey || (await session().get<string>(K.seed))) await lock();
    return { unlocked: false, lockAt: null };
  }
  return { unlocked: true, lockAt: view.lockAt };
}

/**
 * The signer for `pubkey`, or a refusal. Checks the deadline itself rather than trusting the alarm,
 * and zeroes the seed bytes it decoded once the signer holds its own copy.
 */
export async function signerFor(pubkey: string): Promise<Signer> {
  const view = await sessionView();
  if (!canSign(view, Date.now(), pubkey)) {
    // Whatever made the session unusable (expired, no valid deadline, another account), the seed goes.
    await lock();
    throw fail("locked");
  }
  const b64 = await session().get<string>(K.seed);
  if (!b64) {
    await lock();
    throw fail("locked");
  }
  const seed = new Uint8Array(Buffer.from(b64, "base64"));
  try {
    const signer = localSignerFromSeed(seed);
    if (signer.publicKey() !== pubkey) throw new ExtError("internal", "The unlocked key does not match this account.");
    return signer;
  } finally {
    seed.fill(0);
  }
}

/**
 * The key that opens the kept links (src/lib/sealed.ts), derived from the unlocked seed. Refused
 * while locked: a locked extension cannot read a kept link back, so it cannot hand one out.
 */
export async function linksKeyForSession(): Promise<CryptoKey> {
  const view = await sessionView();
  if (!view.pubkey || !canSign(view, Date.now(), view.pubkey)) {
    await lock();
    throw fail("locked");
  }
  const b64 = await session().get<string>(K.seed);
  if (!b64) {
    await lock();
    throw fail("locked");
  }
  const seed = new Uint8Array(Buffer.from(b64, "base64"));
  try {
    if (Keypair.fromRawEd25519Seed(Buffer.from(seed)).publicKey() !== view.pubkey) {
      throw new ExtError("internal", "The unlocked key does not match this account.");
    }
    return await linksKeyFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}

/**
 * Forget everything this extension holds for the account: the key record, the kept links, the link
 * list, the settings and the session. The money is untouched: it sits in the account on the ledger
 * and in the escrow, and the backup on getlumenia.com can restore the account again.
 */
export async function forget(): Promise<null> {
  await lock();
  await clearKeystore();
  await forgetSealed();
  await local().clear();
  await session().clear();
  try {
    await ext.alarms.clearAll();
    await ext.action.setBadgeText({ text: "" });
  } catch {
    /* nothing scheduled */
  }
  return null;
}
