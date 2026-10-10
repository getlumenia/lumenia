/**
 * The two storage areas, behind one small interface so the worker's logic can run against a fake in
 * the self-tests.
 *
 *   local   - plaintext on disk: settings, the account's PUBLIC key, link records (no secrets: a
 *             record carries the link id and the amount, never the link's fragment).
 *   session - memory only, cleared when the browser closes: the unlocked seed, the restore in
 *             progress, the cached pilot answer. Never exposed to content scripts (Chrome's default
 *             access level; the worker asserts it at start).
 */
import { ext } from "./browser";
import { DEFAULT_AUTOLOCK_MIN, AUTOLOCK_CHOICES } from "../config";
import type { BackupRecord, Settings } from "./types";

export interface Area {
  get<T = unknown>(key: string): Promise<T | undefined>;
  getAll(): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

function wrap(area: chrome.storage.StorageArea): Area {
  return {
    async get<T>(key: string) {
      const got = await area.get(key);
      return got[key] as T | undefined;
    },
    async getAll() {
      return (await area.get(null)) as Record<string, unknown>;
    },
    async set(items) {
      await area.set(items);
    },
    async remove(keys) {
      await area.remove(keys);
    },
    async clear() {
      await area.clear();
    },
  };
}

let localArea: Area | null = null;
let sessionArea: Area | null = null;

/** The persistent area (storage.local). Tests swap it with useAreas(). */
export function local(): Area {
  return (localArea ??= wrap(ext.storage.local));
}

/** The in-memory area (storage.session). */
export function session(): Area {
  return (sessionArea ??= wrap(ext.storage.session));
}

/** Self-tests only: replace both areas with fakes. */
export function useAreas(l: Area, s: Area): void {
  localArea = l;
  sessionArea = s;
}

/* ------------------------------------ keys ------------------------------------ */

export const K = {
  settings: "settings",
  account: "account",
  /** an account made HERE that is not backed up yet: its password copy, ciphertext only */
  pendingBackup: "pendingBackup",
  /** what this browser knows of each account's email backup: { G...: BackupRecord } */
  backups: "backups",
  /**
   * 0.1.3 and earlier: `{at}` when the one account held was backed up or restored. Read as that
   * account's record with its email and binding unknown, and folded into `backups` on the next write.
   */
  backedUp: "backedUp",
  // session
  seed: "seed",
  unlockedPubkey: "unlockedPubkey",
  lockAt: "lockAt",
  restore: "restore",
  /** a backup in progress: the email the code was sent to */
  backup: "backup",
  /** after the code, the email turned out to back up another account: { email, box, unbound, ticket?, other? } */
  backupConflict: "backupConflict",
  /** a new backup copy of an account that is already backed up (Change backup email), ciphertext only */
  rebackup: "rebackup",
  sending: "sending",
  pendingInsert: "pendingInsert",
  pilot: (pubkey: string) => `pilot:${pubkey}`,
} as const;

export const DEFAULT_SETTINGS: Settings = {
  net: "testnet",
  autolockMin: DEFAULT_AUTOLOCK_MIN,
  mainnetAck: false,
  consentAt: null,
};

/** Settings as stored, repaired field by field so a damaged or older record never breaks the popup. */
export async function readSettings(): Promise<Settings> {
  const raw = (await local().get<Partial<Settings>>(K.settings)) ?? {};
  return {
    net: raw.net === "public" ? "public" : "testnet",
    autolockMin: (AUTOLOCK_CHOICES as readonly number[]).includes(raw.autolockMin as number)
      ? (raw.autolockMin as Settings["autolockMin"])
      : DEFAULT_AUTOLOCK_MIN,
    mainnetAck: raw.mainnetAck === true,
    consentAt: typeof raw.consentAt === "number" ? raw.consentAt : null,
  };
}

/** Writes the known fields only, so a field an older version kept is dropped on the next write. */
export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings()), ...patch };
  await local().set({ [K.settings]: next });
  return next;
}

/**
 * Version 0.1.2 and earlier kept the last "from" name as the next link's default. A link now carries
 * a name only when the sender types one for it, so that name is never read; this removes it from
 * disk once (the worker runs it on every start, and it writes only when the old field is there).
 */
export async function dropLegacyDefaultName(): Promise<boolean> {
  const raw = await local().get<Record<string, unknown>>(K.settings);
  if (!raw || typeof raw !== "object" || !("from" in raw)) return false;
  await writeSettings({});
  return true;
}

/* ------------------------------------ backup records ------------------------------------ */

function asBackupRecord(v: unknown): BackupRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  return {
    email: typeof r.email === "string" && r.email.includes("@") ? r.email : null,
    at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0,
    bound: typeof r.bound === "boolean" ? r.bound : null,
  };
}

/** Every account's record, repaired field by field (a damaged entry reads as one with nothing known). */
export async function readBackups(): Promise<Record<string, BackupRecord>> {
  const raw = await local().get<Record<string, unknown>>(K.backups);
  const out: Record<string, BackupRecord> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [pubkey, v] of Object.entries(raw)) {
    const rec = asBackupRecord(v);
    if (rec && /^G[A-Z2-7]{55}$/.test(pubkey)) out[pubkey] = rec;
  }
  return out;
}

async function heldMirror(): Promise<string | null> {
  const a = await local().get<{ pubkey?: unknown }>(K.account);
  return a && typeof a.pubkey === "string" ? a.pubkey : null;
}

/**
 * What this browser knows about `pubkey`'s backup, or null when it knows of none. The 0.1.3 marker
 * (`backedUp`) belongs to the account held when it was written, so it is read for that account only.
 */
export async function backupRecordFor(pubkey: string): Promise<BackupRecord | null> {
  const all = await readBackups();
  if (all[pubkey]) return all[pubkey]!;
  const legacy = await local().get<{ at?: unknown }>(K.backedUp);
  if (legacy && typeof legacy === "object" && (await heldMirror()) === pubkey) {
    return { email: null, at: typeof legacy.at === "number" ? legacy.at : 0, bound: null };
  }
  return null;
}

/**
 * Fold the 0.1.3 marker into `backups` under the account it was written for, and drop it. Run before
 * the account held here changes, so the marker can never be read as the next account's.
 */
export async function migrateLegacyBackup(): Promise<void> {
  const legacy = await local().get<{ at?: unknown }>(K.backedUp);
  if (legacy === undefined) return;
  const held = await heldMirror();
  const all = await readBackups();
  if (held && !all[held]) all[held] = { email: null, at: legacy && typeof legacy.at === "number" ? legacy.at : 0, bound: null };
  await local().set({ [K.backups]: all });
  await local().remove(K.backedUp);
}

/** Keep `rec` as `pubkey`'s record. */
export async function writeBackupRecord(pubkey: string, rec: BackupRecord): Promise<void> {
  await migrateLegacyBackup();
  const all = await readBackups();
  await local().set({ [K.backups]: { ...all, [pubkey]: rec } });
}

/** Forget `pubkey`'s record (its key left this browser). */
export async function dropBackupRecord(pubkey: string): Promise<void> {
  await migrateLegacyBackup();
  const all = await readBackups();
  if (!(pubkey in all)) return;
  delete all[pubkey];
  await local().set({ [K.backups]: all });
}
