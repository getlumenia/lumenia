/**
 * Where the NEAR rail keeps its records on this device, with the same discipline as the Stellar
 * side (lib/sent-links.ts, lib/keystore.ts Phase 1):
 *
 *   - the SECRETS (a link's key, a claimed account's private key) live in IndexedDB, encrypted under
 *     a NON-EXTRACTABLE AES-GCM key that `crypto.subtle` hands to this origin's code and never
 *     exports, so dumping storage yields ciphertext;
 *   - the RECORDS (amount, memo, status, the public key) live in plain localStorage, which is what
 *     every list reads and what the ledger's "yours" badge is matched against;
 *   - the sender's session key (the shared demo account, or a key somebody pasted) lives in
 *     sessionStorage only, and is gone when the tab closes.
 *
 * A record and its secret are written BEFORE anything is signed, so a tab killed between the
 * signature and the reply still knows about the funded link. A browser that blocks IndexedDB keeps
 * the secret in memory for the session and `saveLink` answers false, so the screen can say "copy it
 * now". Every access is wrapped: private windows and blocked storage must not break the screens.
 *
 * Its own database and its own keys on purpose: the Stellar keystore is keyed by a `G...` address
 * and read by the wallet provider, the account sweep and the switcher, all of which would treat a
 * NEAR account id as a Stellar account. Nothing here can reach them.
 */
import type { DropStatus } from "./drops";

const LINKS_KEY = "lumenia.near.links.v1";
const CLAIMS_STORAGE_NAME = "lumenia.near.claims.v1";
const FUNDER_KEY = "lumenia.near.funder.v1";
const DB_NAME = "lumenia-near";
const DB_VERSION = 1;
const STORE = "secrets";

export interface StoredLink {
  publicKey: string;
  /** Present only in memory, right after creation. Never written to localStorage: see linkSecret(). */
  secret?: string;
  amountUnits: string;
  memo: string;
  expiresInS: number;
  /** ISO, when this browser created the record (before the transaction was sent) */
  createdAt: string;
  funder: string;
  network: string;
  createTxHash?: string;
  createError?: string;
  /** last status read from the chain; absent until the first successful get_drop */
  lastStatus?: DropStatus;
  lastReadAt?: string;
  claimedTo?: string | null;
  /** expires_at_ns from the chain once read, as a decimal string */
  expiresAtNs?: string;
  statusChangedAtNs?: string;
  reclaimTxHash?: string;
  /** "Send to many": the row label and the id shared by every link of one batch transaction */
  label?: string;
  batchId?: string;
  /** created through the relayer by an account whose key lives in this browser's claims; take-back goes the same way */
  relayed?: boolean;
  relayerExplorerUrl?: string;
}

export interface ClaimedAccount {
  accountId: string;
  publicKey: string;
  dropPublicKey: string;
  kind: "implicit" | "named";
  createdAt: string;
  claimTxHash?: string;
  claimedAt?: string;
}

export interface FunderSession {
  accountId: string;
  secret: string;
  /** signed in through "Use the demo sender" (shared testnet account, tighter caps) */
  demo?: boolean;
}

/* ------------------------------------ plain storage ------------------------------------ */

function readJson<T>(store: Storage | null, key: string, fallback: T): T {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(store: Storage | null, key: string, value: unknown): boolean {
  try {
    store?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function local(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function storageAvailable(): boolean {
  try {
    const s = local();
    if (!s) return false;
    s.setItem("lumenia.near.probe", "1");
    s.removeItem("lumenia.near.probe");
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------ the secret store ------------------------------------ */

interface WrappedSecret {
  id: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  wrapKey: CryptoKey;
}

const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

/** The session's fallback when IndexedDB is blocked: the link still has to be shown once. */
const inMemory = new Map<string, string>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Can the secret store be opened at all? Asked before a key is made, so a blocked browser is told first. */
export async function secretStoreReady(): Promise<boolean> {
  try {
    const db = await openDb();
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Keep a secret under `id`. True when it is on disk, false when only this session holds it. */
export async function rememberSecret(id: string, secret: string): Promise<boolean> {
  inMemory.set(id, secret);
  try {
    const wrapKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, wrapKey, new TextEncoder().encode(secret)));
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ id, iv, ciphertext, wrapKey } satisfies WrappedSecret);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}

export async function recallSecret(id: string): Promise<string | null> {
  const held = inMemory.get(id);
  if (held) return held;
  try {
    const db = await openDb();
    const rec = await new Promise<WrappedSecret | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as WrappedSecret | undefined) ?? null);
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

export async function forgetSecret(id: string): Promise<void> {
  inMemory.delete(id);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* nothing to forget */
  }
}

const linkSecretId = (publicKey: string) => `link:${publicKey}`;
const accountKeyId = (accountId: string) => `account:${accountId}`;

/* ------------------------------------ links ------------------------------------ */

/** Every link record on this device, newest first, without its secret. */
export function loadLinks(): StoredLink[] {
  const v = readJson<unknown>(local(), LINKS_KEY, []);
  return Array.isArray(v) ? (v as StoredLink[]).map(withoutSecret) : [];
}

function withoutSecret(l: StoredLink): StoredLink {
  const { secret: _secret, ...rest } = l;
  return rest;
}

function saveLinks(links: StoredLink[]): boolean {
  return writeJson(local(), LINKS_KEY, links.map(withoutSecret));
}

/** Insert or merge a record by public key. Newest first. The secret is never written here. */
export function upsertLink(patch: Partial<StoredLink> & { publicKey: string }): StoredLink[] {
  const links = loadLinks();
  const i = links.findIndex((l) => l.publicKey === patch.publicKey);
  if (i >= 0) {
    links[i] = withoutSecret({ ...links[i], ...patch } as StoredLink);
  } else {
    links.unshift(withoutSecret(patch as StoredLink));
  }
  saveLinks(links);
  return links;
}

/**
 * A new link: the record, and its secret in the encrypted store. Call BEFORE signing. True when both
 * are on disk; false when the secret could only be held for this session (the screen says so).
 */
export async function saveLink(link: StoredLink): Promise<boolean> {
  upsertLink(link);
  if (!link.secret) return true;
  return rememberSecret(linkSecretId(link.publicKey), link.secret);
}

export async function removeLink(publicKey: string): Promise<StoredLink[]> {
  const links = loadLinks().filter((l) => l.publicKey !== publicKey);
  saveLinks(links);
  await forgetSecret(linkSecretId(publicKey));
  return links;
}

/** The link's secret, or null when this device never had it (or storage is blocked). */
export function linkSecret(publicKey: string): Promise<string | null> {
  return recallSecret(linkSecretId(publicKey));
}

/* ------------------------------------ claimed accounts ------------------------------------ */

export function loadClaims(): ClaimedAccount[] {
  const v = readJson<unknown>(local(), CLAIMS_STORAGE_NAME, []);
  return Array.isArray(v) ? (v as ClaimedAccount[]) : [];
}

export function upsertClaim(patch: Partial<ClaimedAccount> & { accountId: string }): ClaimedAccount[] {
  const claims = loadClaims();
  const i = claims.findIndex((c) => c.accountId === patch.accountId);
  if (i >= 0) {
    claims[i] = { ...claims[i], ...patch } as ClaimedAccount;
  } else {
    claims.unshift(patch as ClaimedAccount);
  }
  writeJson(local(), CLAIMS_STORAGE_NAME, claims);
  return claims;
}

/** A new recipient account: the record, and its private key in the encrypted store. Call BEFORE claiming. */
export async function saveClaim(account: ClaimedAccount, privateKey: string): Promise<boolean> {
  upsertClaim(account);
  return rememberSecret(accountKeyId(account.accountId), privateKey);
}

export function claimForDrop(dropPublicKey: string): ClaimedAccount | undefined {
  return loadClaims().find((c) => c.dropPublicKey === dropPublicKey);
}

export function claimByAccount(accountId: string): ClaimedAccount | undefined {
  return loadClaims().find((c) => c.accountId === accountId);
}

/** The private key of an account this browser made, or null. */
export function accountKey(accountId: string): Promise<string | null> {
  return recallSecret(accountKeyId(accountId));
}

/* ------------------------------------ the sender session ------------------------------------ */

export function loadFunder(): FunderSession | null {
  const v = readJson<unknown>(session(), FUNDER_KEY, null);
  if (!v || typeof v !== "object") return null;
  const f = v as FunderSession;
  return typeof f.accountId === "string" && typeof f.secret === "string" ? f : null;
}

export function saveFunder(f: FunderSession): boolean {
  return writeJson(session(), FUNDER_KEY, f);
}

export function clearFunder(): void {
  try {
    session()?.removeItem(FUNDER_KEY);
  } catch {
    /* nothing to clear */
  }
}
