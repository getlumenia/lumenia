// Link keys and implicit accounts.
// A link carries a fresh ed25519 SECRET key in the URL fragment, printed the way near-api-js
// prints it ("ed25519:<base58 of the 64-byte secret>"). The drop on the contract is keyed by the
// matching PUBLIC key. An implicit NEAR account id is the lowercase hex of a 32-byte ed25519
// public key; whoever holds that key owns the account.

import { KeyPair, PublicKey, type KeyPairString } from "near-api-js";
import { NEAR_CLAIM_PATH } from "./config";

const BASE58_SECRET = /^ed25519:([1-9A-HJ-NP-Za-km-z]{80,96})$/;

export interface LinkKey {
  secret: KeyPairString;
  publicKey: string;
}

export function newLinkKey(): LinkKey {
  const kp = KeyPair.fromRandom("ed25519");
  return { secret: kp.toString(), publicKey: kp.getPublicKey().toString() };
}

export function publicKeyOf(secret: KeyPairString): string {
  return KeyPair.fromString(secret).getPublicKey().toString();
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** "ed25519:5bC2PGuJ..." -> "4430f5be...": the 64-hex implicit account id for that key. */
export function implicitAccountId(publicKey: string | PublicKey): string {
  const pk = typeof publicKey === "string" ? PublicKey.fromString(publicKey) : publicKey;
  if (pk.data.length !== 32) throw new Error("An implicit account needs a 32-byte ed25519 public key.");
  return bytesToHex(pk.data);
}

/** The fragment is the secret itself. base58 and ":" need no URL encoding and never reach a server. */
export function encodeLinkFragment(secret: KeyPairString): string {
  return secret;
}

export function claimUrl(origin: string, secret: KeyPairString): string {
  return `${origin.replace(/\/+$/, "")}${NEAR_CLAIM_PATH}#${encodeLinkFragment(secret)}`;
}

/** Accepts "#ed25519:...", "ed25519:..." or a percent-encoded copy. Returns null for anything else. */
export function decodeLinkFragment(fragment: string): KeyPairString | null {
  let s = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  try {
    s = decodeURIComponent(s);
  } catch {
    return null;
  }
  s = s.trim();
  if (!BASE58_SECRET.test(s)) return null;
  try {
    const kp = KeyPair.fromString(s as KeyPairString);
    if (kp.getPublicKey().data.length !== 32) return null;
  } catch {
    return null;
  }
  return s as KeyPairString;
}

/** A whole pasted claim URL, or just its fragment. */
export function secretFromPastedLink(text: string): KeyPairString | null {
  const t = text.trim();
  const i = t.indexOf("#");
  return decodeLinkFragment(i >= 0 ? t.slice(i) : t);
}
