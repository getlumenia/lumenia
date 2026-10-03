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
import type { Settings } from "./types";

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
  /** when this account's backup was stored (made here and backed up, or restored from one) */
  backedUp: "backedUp",
  // session
  seed: "seed",
  unlockedPubkey: "unlockedPubkey",
  lockAt: "lockAt",
  restore: "restore",
  /** a backup in progress: the email the code was sent to */
  backup: "backup",
  sending: "sending",
  pendingInsert: "pendingInsert",
  pilot: (pubkey: string) => `pilot:${pubkey}`,
} as const;

export const DEFAULT_SETTINGS: Settings = {
  net: "testnet",
  autolockMin: DEFAULT_AUTOLOCK_MIN,
  from: "",
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
    from: typeof raw.from === "string" ? raw.from.slice(0, 40) : "",
    mainnetAck: raw.mainnetAck === true,
    consentAt: typeof raw.consentAt === "number" ? raw.consentAt : null,
  };
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings()), ...patch };
  await local().set({ [K.settings]: next });
  return next;
}
