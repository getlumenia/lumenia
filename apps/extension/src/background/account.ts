/**
 * The one account this extension holds: restored from the user's own backup, kept as a Phase-2
 * record (Argon2id + AES-GCM under their password) in this extension's IndexedDB, unlocked into
 * storage.session for a limited time.
 *
 * Every signature goes through `signerFor`, which refuses unless the session is unexpired AND
 * belongs to the account being signed for, decodes the seed, builds the signer and zeroes the bytes
 * it decoded. The key never reaches the popup.
 */
import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";
import {
  clearKeystore,
  DEFAULT_ARGON,
  fetchRecoveryBox,
  findCopy,
  getActive,
  localSignerFromSeed,
  requestRecoveryOtp,
  savePhase2,
  unlockPhase2,
  unwrapWithPassword,
  type RecoveryBox,
  type Signer,
} from "../core";
import { ext } from "../lib/browser";
import { ExtError, fail } from "../lib/errors";
import { openBox, startRestore, submitCode, type RestoreDeps } from "../lib/restore";
import { canSign, isUnlocked, LOCKED, reduce, type SessionView } from "../lib/session";
import { forgetSealed, linksKeyFromSeed } from "../lib/sealed";
import { K, local, readSettings, session } from "../lib/storage";

export const AUTOLOCK_ALARM = "autolock";

interface RestoreState {
  step: "code" | "password";
  email: string;
  codeSentAt: number;
  box?: RecoveryBox;
}

const restoreDeps: RestoreDeps = {
  requestOtp: requestRecoveryOtp,
  fetchBox: fetchRecoveryBox,
  findPasswordCopy: (box) => findCopy(box, "password"),
  unwrap: unwrapWithPassword,
  publicKeyOf: (seed) => Keypair.fromRawEd25519Seed(Buffer.from(seed)).publicKey(),
  save: async (pubkey, seed, password) => {
    await savePhase2(pubkey, seed, password, DEFAULT_ARGON, "user");
  },
};

/** The account held here, from the keystore (the truth), or null. */
export async function currentAccount(): Promise<{ pubkey: string; phase: 1 | 2 } | null> {
  try {
    const a = await getActive();
    return a ? { pubkey: a.pubkey, phase: a.phase } : null;
  } catch {
    return null;
  }
}

async function requireConsent(): Promise<void> {
  if (!(await readSettings()).consentAt) throw fail("needs-consent");
}

/* --------------------------------- restore --------------------------------- */

export async function restoreState(): Promise<{ step: "code" | "password"; email: string; codeSentAt: number } | null> {
  const r = await session().get<RestoreState>(K.restore);
  return r ? { step: r.step, email: r.email, codeSentAt: r.codeSentAt } : null;
}

export async function restoreRequestCode(email: string): Promise<{ codeSentAt: number }> {
  await requireConsent();
  if (await currentAccount()) throw new ExtError("internal", "An account is already connected here. Forget it in Settings first.");
  await startRestore(restoreDeps, email);
  const codeSentAt = Date.now();
  await session().set({ [K.restore]: { step: "code", email: email.trim(), codeSentAt } satisfies RestoreState });
  return { codeSentAt };
}

export async function restoreSubmitCode(code: string): Promise<{ step: "password" }> {
  await requireConsent();
  const r = await session().get<RestoreState>(K.restore);
  if (!r) throw new ExtError("internal", "Start again: enter your email.");
  const box = await submitCode(restoreDeps, r.email, code);
  await session().set({ [K.restore]: { ...r, step: "password", box } satisfies RestoreState });
  return { step: "password" };
}

export async function restoreSubmitPassword(password: string): Promise<{ pubkey: string }> {
  await requireConsent();
  const r = await session().get<RestoreState>(K.restore);
  if (!r?.box) throw new ExtError("internal", "Start again: enter your email.");
  // Checked BEFORE the box is opened, because opening it also writes the key record: one account
  // per extension, and a second one must never be written next to the first.
  if (await currentAccount()) throw new ExtError("internal", "An account is already connected here. Forget it in Settings first.");
  const { pubkey, seed } = await openBox(restoreDeps, r.box, password);
  try {
    await startSession(pubkey, seed);
  } finally {
    seed.fill(0);
  }
  await local().set({ [K.account]: { pubkey, restoredAt: Date.now() } });
  await session().remove(K.restore);
  return { pubkey };
}

export async function restoreCancel(): Promise<null> {
  await session().remove(K.restore);
  return null;
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
