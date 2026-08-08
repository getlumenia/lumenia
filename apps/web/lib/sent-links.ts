/**
 * Where a sent money link is kept so the sender can copy it again.
 *
 * The link's #fragment is a bearer key: whoever reads it can take the money. It used to sit in
 * `localStorage` as plain text next to the amount, which made every unclaimed link readable by
 * anything that can read storage — a malicious extension, a shared or forensically imaged device,
 * or any script that gets into the page. A list of "here is unclaimed money, and here is the key
 * to it" is the single most valuable thing this app could leave lying around.
 *
 * So the link is encrypted here under a NON-EXTRACTABLE AES-GCM key that lives only in IndexedDB,
 * the same shape `keystore.ts` uses for the Phase-1 device key. `crypto.subtle` will hand that key
 * to this origin's code and never hand out its bytes, so dumping storage yields ciphertext.
 *
 * Being honest about the limit: this defeats reading storage, not running code in the page. An
 * attacker who achieves script execution here can call `recallLink` like we do. It raises the
 * floor from "copy the file" to "own the origin", which is the same bar the seed itself sits behind.
 *
 * A separate database from `keystore.ts` on purpose: this is convenience data with its own
 * lifecycle, and it must never share a versionchange migration with the key material.
 */

const DB_NAME = "lumenia-links";
const DB_VERSION = 1;
const STORE = "links";

interface WrappedLink {
  id: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  wrapKey: CryptoKey;
}

/** WebCrypto wants a plain ArrayBuffer view; Uint8Array from IndexedDB satisfies BufferSource. */
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Keep a link for later re-copying. Storage failures are non-fatal: the link is already shared. */
export async function rememberLink(id: string, link: string): Promise<void> {
  try {
    const wrapKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, wrapKey, new TextEncoder().encode(link)),
    );
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ id, iv, ciphertext, wrapKey } satisfies WrappedLink);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* no local copy — the link is in the chat the sender just shared it to */
  }
}

/** The link for a sent id, or null when this device never had it (or storage is blocked). */
export async function recallLink(id: string): Promise<string | null> {
  try {
    const db = await openDb();
    const rec = await new Promise<WrappedLink | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as WrappedLink | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!rec) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(rec.iv) }, rec.wrapKey, bs(rec.ciphertext));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/**
 * Move any link still sitting in plaintext `localStorage` into the encrypted store, then strip it.
 *
 * Fixing the write path only helps people who send their NEXT link. Anyone who has used the app
 * already has bearer keys to unclaimed money sitting in `lumenia.sent` right now, and those links
 * stay claimable for seven days. Idempotent and cheap, so it can run on every mount.
 */
export async function migrateLegacySentLinks(): Promise<void> {
  let all: Record<string, { link?: string; hasLink?: boolean }>;
  try {
    all = JSON.parse(localStorage.getItem("lumenia.sent") ?? "{}") as typeof all;
  } catch {
    return;
  }
  const stale = Object.entries(all).filter(([, rec]) => typeof rec?.link === "string");
  if (stale.length === 0) return;

  for (const [id, rec] of stale) {
    // An empty `link` was the old marker for a pay-to-address send: nothing to keep, just drop it.
    if (rec.link) {
      await rememberLink(id, rec.link);
      rec.hasLink = true;
    } else {
      rec.hasLink = false;
    }
    delete rec.link;
  }
  try {
    localStorage.setItem("lumenia.sent", JSON.stringify(all));
  } catch {
    /* storage blocked — nothing was removed, and nothing was made worse */
  }
}

/** Drop every stored link — pairs with clearing the keystore ("forget me on this device"). */
export async function forgetAllLinks(): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  } catch {
    /* nothing to drop */
  }
}
