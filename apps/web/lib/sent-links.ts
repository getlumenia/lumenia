import { netKey } from "./scoped-store";
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
 *
 * The second half of this file is the RECORD store (`lumenia.sent`, plain localStorage under the
 * network key): the metadata every surface lists a send by, which never holds the link. See the
 * divider below for why a link's record is written before its deposit is posted.
 */
import type { PreparedDeposit } from "./lumendrop";

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
    all = JSON.parse(localStorage.getItem(netKey("lumenia.sent")) ?? "{}") as typeof all;
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
    localStorage.setItem(netKey("lumenia.sent"), JSON.stringify(all));
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

/* ------------------------------- the record half: `lumenia.sent` -------------------------------
 * The metadata half of every send, in plain localStorage under the network key (lib/scoped-store.ts),
 * one entry per record id: the last eight characters of the drop id or of the claimable balance id.
 * /send and /group write it; /sent/[id], /notifications, lib/contacts.ts, lib/notifications.ts,
 * loadReclaimableV2 and the forget-this-device warning read it. None of them holds the link itself:
 * that is the encrypted store above, keyed by the same id, and `hasLink` is the record's only word
 * about it.
 *
 * A link's record is written TWICE. First in the deposit's `onPrepared` hook, BEFORE the POST, as
 * `phase: "submitted"`; then as `phase: "confirmed"` once the sponsor's 200 or the escrow says the
 * money is there. The first write is what survives a tab killed between the POST and the reply:
 * without it a deposit that landed later had no record at all, so it was listed nowhere, nothing
 * ever offered it back, and the only copy of its link had died with the tab. The same record is
 * what refuses a second send while the first is undecided (`openSend`): the refusal used to live in
 * React state, and the Send pill, "See my activity" and a reload all came back to a blank form with
 * a second deposit of the same money one tap away. A record without a phase was written before the
 * distinction existed and is a confirmed one.
 */

export type SentPhase = "submitted" | "confirmed";

export interface SentRecord {
  /** The v2 drop id (the 64-hex link key), or a classic claimable balance id (72 hex). */
  balanceId: string;
  /** true when a bearer link was stored (encrypted); false for a pay-to-address send. */
  hasLink: boolean;
  /** Dollars as sent: the whole amount of a one-to-one link or a direct pay, the WHOLE POT of a group link. */
  amount: string;
  from: string;
  /** ISO time the record was first written. */
  at: string;
  /** who was paid, when this send answered a request straight to their account. */
  toName?: string;
  /** their account address (direct pays only); lets /contacts offer "pay again". */
  toAddress?: string;
  /** How many equal shares the pot holds, present only on a group link: what makes every reader ask get_pool. */
  slots?: number;
  /** Group only: what one share is. */
  perShare?: string;
  /** Set by /notifications when the sender took the leftover back on THIS device. */
  tookBackUsd?: string;
  /** "submitted": signed and handed to the sponsor, not yet seen in the escrow. "confirmed", or absent: it is there. */
  phase?: SentPhase;
  /** Submitted only: unix ms after which the signed deposit can no longer land, so an empty escrow means nothing moved. */
  retrySafeAfter?: number;
  /** Unix seconds the sender's take-back opens at (a group link also stops paying out then). */
  expiry?: number;
  /** The recipient needs a password (or the group's word) before the money moves. */
  locked?: boolean;
}

/** The record id of a link: the last eight characters of its drop id (the same for a classic balance id). */
export function sentIdOf(balanceId: string): string {
  return balanceId.slice(-8);
}

/** Every record on this network, or none when storage is blocked or holds something else. */
export function readSentRecords(): Record<string, SentRecord> {
  try {
    const all = JSON.parse(localStorage.getItem(netKey("lumenia.sent")) ?? "{}") as unknown;
    return all && typeof all === "object" && !Array.isArray(all) ? (all as Record<string, SentRecord>) : {};
  } catch {
    return {};
  }
}

/** Write one record. Storage failures are non-fatal: the link still works, there is just no local tracking. */
export function saveSent(id: string, rec: SentRecord): void {
  try {
    const all = JSON.parse(localStorage.getItem(netKey("lumenia.sent")) ?? "{}") as Record<string, SentRecord>;
    all[id] = rec;
    localStorage.setItem(netKey("lumenia.sent"), JSON.stringify(all));
  } catch {
    /* localStorage blocked */
  }
}

/**
 * The record written in a deposit's `onPrepared` hook: signed, about to be posted, not yet seen.
 * Never the link. A deposit without an upper time bound stores no deadline at all (JSON would turn
 * Infinity into null, and a null must not read as "provably failed at time zero"); createV2Link
 * always sets one, so this is a guard, not a path.
 */
export function pendingSentRecord(p: PreparedDeposit, ctx: { from: string; locked: boolean; now: number }): SentRecord {
  return {
    balanceId: p.linkHex,
    hasLink: true,
    amount: p.group ? (p.total ?? p.amount) : p.amount,
    from: ctx.from,
    at: new Date(ctx.now).toISOString(),
    ...(p.group ? { slots: p.slots, perShare: p.amount } : {}),
    phase: "submitted",
    ...(Number.isFinite(p.retrySafeAfter) ? { retrySafeAfter: p.retrySafeAfter } : {}),
    expiry: p.expiry,
    locked: ctx.locked,
  };
}

/** The same record once the sponsor's 200, or the escrow, has said the money is there. */
export function confirmedSentRecord(rec: SentRecord): SentRecord {
  const { retrySafeAfter: _deadline, ...rest } = rec;
  return { ...rest, phase: "confirmed" };
}

/** Confirm a stored record in place; nothing happens when there is none (storage was blocked when it was written). */
export function markSentConfirmed(id: string): void {
  const rec = readSentRecords()[id];
  if (rec) saveSent(id, confirmedSentRecord(rec));
}

/** Remove a record whose deposit provably never moved: refused before submission, or read empty past its deadline. */
export function forgetSent(id: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(netKey("lumenia.sent")) ?? "{}") as Record<string, SentRecord>;
    if (!(id in all)) return;
    delete all[id];
    localStorage.setItem(netKey("lumenia.sent"), JSON.stringify(all));
  } catch {
    /* localStorage blocked: nothing was written, so there is nothing to remove */
  }
}

/** What /sent/[id] shows for a record, given what the ledger reader answered. */
export type ShownStatus = "pending" | "settled" | "unknown" | "unconfirmed";

/**
 * A record still in phase "submitted" was signed and handed to the sponsor and never confirmed.
 * For it, an empty escrow is NOT settlement: the deposit may never have reached the ledger, so the
 * page says "not confirmed yet" and leaves the re-check to Send. A drop that IS there proves the
 * deposit landed, and the caller then marks the record confirmed. A confirmed record (or one
 * written before phases existed) keeps the reader's answer as it is.
 */
export function shownStatus(
  rec: Pick<SentRecord, "phase">,
  read: "pending" | "settled" | "unknown",
): { status: ShownStatus; landed: boolean } {
  if (rec.phase !== "submitted") return { status: read, landed: false };
  if (read === "pending") return { status: "pending", landed: true };
  if (read === "settled") return { status: "unconfirmed", landed: false };
  return { status: "unknown", landed: false };
}

/** How long a submitted, unconfirmed send keeps refusing another one. The extension uses the same six hours. */
export const UNCONFIRMED_SEND_WINDOW_MS = 6 * 60 * 60_000;

/**
 * A send on this network that was handed to the sponsor and is not settled yet: the newest
 * submitted record younger than the window. While there is one, another send needs the person's
 * explicit "start a new one anyway", as the extension requires it (background/send.ts): if the
 * first went through, a second escrows the money twice. Read from storage rather than from React
 * state, so it holds across a navigation, a reload and a tab the Send pill opens fresh.
 */
export function openSend(all: Record<string, SentRecord>, now: number): { id: string; rec: SentRecord } | null {
  let open: { id: string; rec: SentRecord; at: number } | null = null;
  for (const [id, rec] of Object.entries(all)) {
    if (!rec || rec.phase !== "submitted") continue;
    const at = Date.parse(rec.at);
    if (!Number.isFinite(at) || now - at >= UNCONFIRMED_SEND_WINDOW_MS) continue;
    if (!open || at > open.at) open = { id, rec, at };
  }
  return open ? { id: open.id, rec: open.rec } : null;
}
