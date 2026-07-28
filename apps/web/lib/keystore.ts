/**
 * Browser keystore — where the account seed lives at rest (FRONTEND_PLAN §2).
 * The seed NEVER leaves this module + lib/signer.ts as plaintext; pages only ever
 * see a public key. A `formatVersion` field lets v2 (passkey/PRF/server-blob
 * recovery) slot in without touching pages.
 *
 *  - Phase 1 ("not locked"): seed wrapped by a NON-EXTRACTABLE WebCrypto AES-GCM key
 *    stored (as a CryptoKey object) in IndexedDB. Not password-grade — anyone with
 *    the device can decrypt. Honest label in the UI.
 *  - Phase 2 ("locked to you"): KEK = Argon2id(password, salt) → AES-256-GCM(seed).
 *    Only {ciphertext, iv, salt, argon params, pubkey} are stored — never the key.
 *
 * MULTI-ACCOUNT (RECOVERY_ARCHITECTURE §3.1/§4.1): a claim link carries its OWN
 * bearer key, so each claim creates a DISTINCT Stellar account. The old single
 * "primary" record OVERWROTE the previous account on every claim → the earlier
 * account (and its balance) became unreachable = fund loss (live-test bug).
 * We now store ONE record PER account, keyed by its pubkey, plus a separate
 * home-pointer record ("__home__") naming the ONE persistent home account.
 * savePhase1/2 APPEND (never overwrite a different account); /home sweeps every
 * non-home account into home and then removeAccount()s it. The first account seen
 * becomes home. Browser storage is a fast-path cache, never the source of truth.
 *
 * All crypto is WebCrypto (AES-GCM) + hash-wasm (Argon2id). No seed is ever logged
 * or sent anywhere.
 */
import type { ArgonParams } from "./argon";

// Argon2id (hash-wasm) is imported DYNAMICALLY inside the Phase-2 functions only,
// so the claim route (which uses Phase 1 = WebCrypto only) never bundles the WASM.
async function deriveKek(password: string, salt: Uint8Array, p: ArgonParams): Promise<Uint8Array> {
  const argon = await import("./argon");
  return argon.deriveKek(password, salt, p);
}

// WebCrypto's BufferSource type (lib.dom, TS 5.7+) is narrower than
// Uint8Array<ArrayBufferLike>; our arrays are always ArrayBuffer-backed at
// runtime, so coerce for the type-checker only.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

const DB_NAME = "lumenia";
const DB_VERSION = 2;
const STORE = "keys";
// Reserved id for the home-pointer record (a `G...` pubkey can never collide with it).
const HOME_ID = "__home__";
// Reserved id for the published-addresses record (see markPublished).
const PUBLISHED_ID = "__published__";
/** Reserved ids are NOT accounts. Anything added here must also stay out of listAccounts(). */
const RESERVED = new Set<string>([HOME_ID, PUBLISHED_ID]);
// The legacy single-account record id (pre-multi-account); migrated away in v2.
const LEGACY_ID = "primary";

export type Phase = 1 | 2;

export interface KeyRecord {
  /** For an account record this is the account pubkey (`G...`); one record per account. */
  id: string;
  formatVersion: 1;
  pubkey: string;
  phase: Phase;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  wrapKey?: CryptoKey; // phase 1 (non-extractable, structured-clone into IDB)
  salt?: Uint8Array; // phase 2
  argon?: ArgonParams; // phase 2
}

/** The single home-pointer record — names the ONE persistent home account. */
interface HomePointer {
  id: typeof HOME_ID;
  pubkey: string;
}

/** The addresses the user has handed to somebody else (see markPublished). */
interface PublishedRecord {
  id: typeof PUBLISHED_ID;
  pubkeys: string[];
}

type StoredRecord = KeyRecord | HomePointer | PublishedRecord;

function isAccountRecord(r: StoredRecord): r is KeyRecord {
  return !RESERVED.has(r.id);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      // MIGRATION (v1 → v2): re-key the legacy single "primary" record to id=<pubkey>
      // and point home at it. No data loss, no user action. Runs inside the
      // versionchange transaction. A fresh DB (no legacy record) is a no-op.
      const tx = req.transaction;
      if (!tx) return;
      const store = tx.objectStore(STORE);
      const getLegacy = store.get(LEGACY_ID);
      getLegacy.onsuccess = () => {
        const legacy = getLegacy.result as KeyRecord | undefined;
        if (legacy && legacy.pubkey) {
          store.delete(LEGACY_ID);
          store.put({ ...legacy, id: legacy.pubkey });
          store.put({ id: HOME_ID, pubkey: legacy.pubkey } satisfies HomePointer);
        }
      };
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(record: StoredRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet(id: string): Promise<StoredRecord | null> {
  const db = await openDb();
  const record = await new Promise<StoredRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve((req.result as StoredRecord) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return record;
}

async function idbGetAll(): Promise<StoredRecord[]> {
  const db = await openDb();
  const records = await new Promise<StoredRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as StoredRecord[]) ?? []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return records;
}

async function idbDelete(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** The home-pointer record, or null if no account has been adopted as home yet. */
async function getHomePointer(): Promise<HomePointer | null> {
  const r = await idbGet(HOME_ID);
  return r && r.id === HOME_ID ? (r as HomePointer) : null;
}

/** Read one account record by pubkey, or null. */
async function getAccountRecord(pubkey: string): Promise<KeyRecord | null> {
  const r = await idbGet(pubkey);
  return r && isAccountRecord(r) ? r : null;
}

export async function clearKeystore(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/* ----------------------------- Multi-account API ---------------------------- */

/** The HOME account's meta (the one persistent account), or null. */
export async function getHome(): Promise<{ pubkey: string; phase: Phase } | null> {
  const ptr = await getHomePointer();
  if (!ptr) return null;
  const rec = await getAccountRecord(ptr.pubkey);
  return rec ? { pubkey: rec.pubkey, phase: rec.phase } : null;
}

/** Every stored account (EXCLUDING the home pointer), home + any not-yet-swept throwaways. */
export async function listAccounts(): Promise<{ pubkey: string; phase: Phase }[]> {
  const all = await idbGetAll();
  return all.filter(isAccountRecord).map((r) => ({ pubkey: r.pubkey, phase: r.phase }));
}

/** Point home at an existing account. */
export async function setHome(pubkey: string): Promise<void> {
  await idbPut({ id: HOME_ID, pubkey } satisfies HomePointer);
}

/* ------------------------- Published addresses ------------------------------
 * An address becomes PUBLISHED the moment the user hands it to somebody else: pasted into an
 * exchange's withdrawal screen, shown as a QR, written down. That changes what the app is allowed
 * to do with it.
 *
 * Why this exists: /home consolidates every NON-home account into home, and that sweep ends in
 * `accountMerge` — it CLOSES the account on-chain. Restoring a backup repoints home. So a user who
 * published their address, then restored on a new phone, would have the published account merged
 * away underneath them, and the withdrawal they were waiting for would bounce off an account that
 * no longer exists. A published address is therefore never swept and never silently demoted.
 * ---------------------------------------------------------------------------- */

async function getPublishedRecord(): Promise<PublishedRecord | null> {
  const all = await idbGetAll();
  const rec = all.find((r) => r.id === PUBLISHED_ID);
  return (rec as PublishedRecord | undefined) ?? null;
}

/** Remember that this address has been handed to somebody. Idempotent. */
export async function markPublished(pubkey: string): Promise<void> {
  const rec = await getPublishedRecord();
  const pubkeys = new Set(rec?.pubkeys ?? []);
  if (pubkeys.has(pubkey)) return;
  pubkeys.add(pubkey);
  await idbPut({ id: PUBLISHED_ID, pubkeys: [...pubkeys] } satisfies PublishedRecord);
}

/** Has this address been handed to somebody? (Consulted before any sweep.) */
export async function isPublished(pubkey: string): Promise<boolean> {
  const rec = await getPublishedRecord();
  return (rec?.pubkeys ?? []).includes(pubkey);
}

/** Every address the user has handed out. */
export async function listPublished(): Promise<string[]> {
  return (await getPublishedRecord())?.pubkeys ?? [];
}

/**
 * Delete one account record — used AFTER a successful sweep merges it away.
 * Refuses (no-op) if `pubkey` is the home account, so home is never removable.
 */
export async function removeAccount(pubkey: string): Promise<void> {
  const ptr = await getHomePointer();
  if (ptr?.pubkey === pubkey) return; // never remove home
  await idbDelete(pubkey);
}

/**
 * Backward-compat: returns the HOME account's meta (the WalletProvider reads this).
 * Same shape as before the multi-account change; callers are unaffected.
 */
export async function getRecordMeta(): Promise<{ pubkey: string; phase: Phase } | null> {
  return getHome();
}

/** If no account is home yet, adopt `pubkey` (first-seen = home). */
async function adoptHomeIfUnset(pubkey: string): Promise<void> {
  const ptr = await getHomePointer();
  if (!ptr) await setHome(pubkey);
}

/* --------------------------- Phase 1 (device key) --------------------------- */

export async function savePhase1(pubkey: string, seed: Uint8Array): Promise<void> {
  const wrapKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, wrapKey, bs(seed)),
  );
  // APPEND: the record id IS the pubkey, so this only ever overwrites the SAME
  // account (re-claiming the same key) — never a different account.
  await idbPut({ id: pubkey, formatVersion: 1, pubkey, phase: 1, iv, ciphertext, wrapKey });
  await adoptHomeIfUnset(pubkey);
}

export async function unlockPhase1(pubkey?: string): Promise<Uint8Array> {
  const target = pubkey ?? (await getHomePointer())?.pubkey;
  if (!target) throw new Error("no phase-1 key on this device");
  const r = await getAccountRecord(target);
  if (!r || r.phase !== 1 || !r.wrapKey) throw new Error("no phase-1 key on this device");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(r.iv) }, r.wrapKey, bs(r.ciphertext));
  return new Uint8Array(pt);
}

/* ------------------------- Phase 2 (locked to you) -------------------------- */

export async function savePhase2(
  pubkey: string,
  seed: Uint8Array,
  password: string,
  params: ArgonParams,
): Promise<{ deriveMs: number }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const t0 = performance.now();
  const kekBytes = await deriveKek(password, salt, params);
  const deriveMs = performance.now() - t0;
  const kek = await crypto.subtle.importKey("raw", bs(kekBytes), { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, kek, bs(seed)),
  );
  kekBytes.fill(0);
  // APPEND (id = pubkey): only overwrites the SAME account (e.g. locking home from
  // phase 1 → phase 2), never a different account.
  await idbPut({ id: pubkey, formatVersion: 1, pubkey, phase: 2, iv, ciphertext, salt, argon: params });
  await adoptHomeIfUnset(pubkey);
  return { deriveMs };
}

export async function unlockPhase2(
  password: string,
  pubkey?: string,
): Promise<{ seed: Uint8Array; deriveMs: number }> {
  const target = pubkey ?? (await getHomePointer())?.pubkey;
  if (!target) throw new Error("no phase-2 key on this device");
  const r = await getAccountRecord(target);
  if (!r || r.phase !== 2 || !r.salt || !r.argon) throw new Error("no phase-2 key on this device");
  const t0 = performance.now();
  const kekBytes = await deriveKek(password, r.salt, r.argon);
  const deriveMs = performance.now() - t0;
  const kek = await crypto.subtle.importKey("raw", bs(kekBytes), { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(r.iv) }, kek, bs(r.ciphertext));
  kekBytes.fill(0);
  return { seed: new Uint8Array(pt), deriveMs };
}
