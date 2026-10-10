/**
 * Where the full link (with its #fragment, the bearer key) is kept so the sender can copy it again.
 *
 * Each link is encrypted with AES-256-GCM under a key DERIVED FROM THE ACCOUNT'S SEED (HKDF-SHA-256
 * with a fixed label), bound to the link's id as additional data. Only the iv and the ciphertext are
 * stored. The key is never stored anywhere: it exists in memory only while the account is unlocked,
 * so the kept links are exactly as protected as the account key itself (Argon2id over the user's
 * password), and a locked extension cannot read them back.
 *
 * Why not the website's scheme (apps/web/lib/sent-links.ts, a non-extractable key stored in
 * IndexedDB next to the ciphertext): "non-extractable" only stops script from exporting the key.
 * The key's bytes are still serialised into the profile's IndexedDB files, and reading those files
 * recovers it (measured on Chromium, 2026-10-03). A key that is never written down avoids that.
 *
 * These functions THROW on failure: the extension keeps a link BEFORE the deposit is posted (the
 * `onPrepared` hook), and a save that silently failed there would be money with no way back to its
 * key. A thrown save stops the send before anything leaves the device.
 */
const DB_NAME = "lumenia-ext-links";
const DB_VERSION = 2;
const STORE = "links";
const KEY_LABEL = new TextEncoder().encode("lumenia-ext-links-v1");

interface Sealed {
  id: string;
  v: 2;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

/** The key that encrypts kept links, from the 32-byte account seed. Deterministic, never stored. */
export async function linksKeyFromSeed(seed: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", bs(seed), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bs(new Uint8Array(32)), info: bs(KEY_LABEL) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt `link` for the link id `id` (the id is authenticated, so a record cannot be swapped). */
export async function encryptLink(key: CryptoKey, id: string, link: string): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(new TextEncoder().encode(id)) }, key, new TextEncoder().encode(link)),
  );
  return { iv, ciphertext };
}

/** Decrypt a kept link. Throws on a wrong key (another account) or a record that was tampered with. */
export async function decryptLink(key: CryptoKey, id: string, rec: { iv: Uint8Array; ciphertext: Uint8Array }): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(rec.iv), additionalData: bs(new TextEncoder().encode(id)) }, key, bs(rec.ciphertext));
  return new TextDecoder().decode(pt);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Version 1 kept a key next to each link; nothing of it is worth keeping.
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      let value: T | undefined;
      req.onsuccess = () => {
        value = req.result;
      };
      tx.oncomplete = () => resolve(value as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("link store transaction aborted"));
    });
  } finally {
    db.close();
  }
}

/** Keep `link` under `id` (the link's hex id), encrypted with `key`. Throws if it could not be kept. */
export async function sealLink(id: string, link: string, key: CryptoKey): Promise<void> {
  const { iv, ciphertext } = await encryptLink(key, id, link);
  await withStore("readwrite", (s) => s.put({ id, v: 2, iv, ciphertext } satisfies Sealed));
  // Read it back: a store that accepted the write but cannot return it is not a store.
  if ((await unsealLink(id, key)) !== link) throw new Error("the link could not be kept on this device");
}

/** The link kept under `id`, or null when there is none. Throws when it cannot be read or opened. */
export async function unsealLink(id: string, key: CryptoKey): Promise<string | null> {
  const rec = await withStore<Sealed | undefined>("readonly", (s) => s.get(id) as IDBRequest<Sealed | undefined>);
  if (!rec || rec.v !== 2) return null;
  return decryptLink(key, id, rec);
}

/**
 * Drop the kept links of these ids only: an account that leaves this browser while another one
 * comes in (its key, and with it the only way to open them, is gone). Throws if they could not be
 * dropped.
 */
export async function forgetSealedIds(ids: string[]): Promise<void> {
  for (const id of ids) {
    await withStore("readwrite", (s) => s.delete(id) as IDBRequest<undefined>);
  }
}

/** Drop every kept link ("Forget this account"). */
export async function forgetSealed(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
