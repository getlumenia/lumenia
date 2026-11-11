// Password protection for a downloaded key file: PBKDF2-SHA256 -> AES-256-GCM, WebCrypto only.
// The box is self-describing JSON so it can be opened later with any WebCrypto runtime (the Node
// recipe is in the key file's own note). Deliberately not Argon2id: the Stellar keystore's KEK is
// for a key that stays on the device, where hash-wasm is already loaded; this is a FILE a person
// may open years later on another machine, and PBKDF2 is the one KDF every WebCrypto has.

export interface EncryptedBox {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  cipher: "AES-256-GCM";
  ciphertext: string;
}

export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** WebCrypto wants a plain ArrayBuffer view; our arrays are always ArrayBuffer-backed at runtime. */
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: bs(salt), iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptWithPassword(password: string, plaintext: string, iterations = DEFAULT_PBKDF2_ITERATIONS): Promise<EncryptedBox> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, key, new TextEncoder().encode(plaintext));
  return {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: b64(salt),
    iv: b64(iv),
    cipher: "AES-256-GCM",
    ciphertext: b64(new Uint8Array(ct)),
  };
}

export async function decryptWithPassword(password: string, box: EncryptedBox): Promise<string> {
  const key = await deriveKey(password, unb64(box.salt), box.iterations);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(unb64(box.iv)) }, key, bs(unb64(box.ciphertext)));
  return new TextDecoder().decode(pt);
}
