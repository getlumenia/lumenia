// A Lumenia link is <web origin>/c#<secret key>. The secret key is a fresh
// ed25519 key pair in near-api-js text form ("ed25519:<base58 of 64 bytes>");
// the escrow contract keys the drop by the matching PUBLIC key
// ("ed25519:<base58 of 32 bytes>"). Browsers never send the URL fragment to
// the server, which is why the secret can travel inside the link.
import { KeyPair, PublicKey, type KeyPairString } from "near-api-js";
import { ed25519KeyBytes } from "./base58.js";

export const LINK_PATH = "/c";

export class LinkError extends Error {
  override name = "LinkError";
}

export interface LinkKey {
  secretKey: string;
  publicKey: string;
}

export function newLinkKey(): LinkKey {
  const kp = KeyPair.fromRandom("ed25519");
  return { secretKey: kp.toString(), publicKey: kp.getPublicKey().toString() };
}

export function buildLink(webOrigin: string, secretKey: string): string {
  const origin = webOrigin.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(origin)) {
    throw new LinkError(`WEB_ORIGIN must start with http:// or https://, got "${webOrigin}"`);
  }
  if (ed25519KeyBytes(secretKey) !== 64) throw new LinkError("buildLink needs an ed25519 secret key");
  return `${origin}${LINK_PATH}#${secretKey}`;
}

/**
 * Accepts a full link, a bare secret key or a bare public key and returns the
 * public key the contract knows the drop by (plus the secret when one was given).
 */
export function parseLinkOrKey(input: string): { publicKey: string; secretKey?: string } {
  let s = input.trim();
  if (s.includes("#")) {
    const fragment = s.slice(s.lastIndexOf("#") + 1);
    try {
      s = decodeURIComponent(fragment.split(/[&?]/)[0] ?? "");
    } catch {
      throw new LinkError("the link fragment is not valid URL text");
    }
  }
  if (!s.startsWith("ed25519:")) {
    throw new LinkError("expected a Lumenia link (https://.../c#ed25519:...) or an ed25519:... key");
  }
  const bytes = ed25519KeyBytes(s);
  if (bytes === 64) {
    const kp = KeyPair.fromString(s as KeyPairString);
    return { publicKey: kp.getPublicKey().toString(), secretKey: s };
  }
  if (bytes === 32) {
    return { publicKey: PublicKey.fromString(s).toString() };
  }
  throw new LinkError(
    `not a valid ed25519 key (${bytes < 0 ? "bad base58" : `${bytes} bytes`}): the link looks truncated or altered`,
  );
}
