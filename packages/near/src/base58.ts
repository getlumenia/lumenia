// Minimal base58 (Bitcoin alphabet) decoder, used only to check key lengths:
// near-api-js happily parses a 32-byte public key string as a 64-byte secret
// (and derives the wrong public key), so lengths are checked here first.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function base58Decode(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array();
  const bytes: number[] = [];
  for (const ch of text) {
    let carry = MAP.get(ch);
    if (carry === undefined) throw new Error(`invalid base58 character "${ch}"`);
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] ?? 0) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leading = 0;
  for (const ch of text) {
    if (ch !== "1") break;
    leading++;
  }
  const out = new Uint8Array(leading + bytes.length);
  out.set(bytes.reverse(), leading);
  return out;
}

/** Byte length of an "ed25519:<base58>" key string, or -1 when it is not one. */
export function ed25519KeyBytes(text: string): number {
  if (!text.startsWith("ed25519:")) return -1;
  try {
    return base58Decode(text.slice("ed25519:".length)).length;
  } catch {
    return -1;
  }
}
