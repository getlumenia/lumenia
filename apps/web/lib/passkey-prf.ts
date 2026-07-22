/**
 * WebAuthn PRF extraction — the hardware-facing half of the "Lock with Face ID" recovery
 * upgrade (RECOVERY_ARCHITECTURE §12 step 5). lib/recovery.ts already holds the crypto
 * (wrapWithPrf / unwrapWithPrf over a raw 32-byte PRF output); THIS module produces that
 * output from a real passkey (Face ID / Touch ID / a security key) via the WebAuthn `prf`
 * extension. The authenticator's PRF secret never leaves the device — we only ever see the
 * derived output, which HKDF + AES-GCM (lib/recovery.ts) turn into the wrap key.
 *
 * DEVICE REALITY (Spike #2, owner hardware — this can NOT be validated headless): PRF
 * availability + passkey sync vary by platform (iOS 18+, Chrome/Android, security keys;
 * iCloud/GPM sync). This module DETECTS support and degrades GRACEFULLY — a clear thrown
 * message the UI turns into "Face ID isn't available here — your password still works."
 * It is a real-browser UPGRADE on top of the password floor, NEVER a claim-path dependency
 * (the WhatsApp webview can't create passkeys — password is the floor there).
 *
 * The DOM lib doesn't yet type the `prf` extension, so its inputs/outputs are typed locally.
 */

/**
 * A FIXED PRF evaluation salt: the SAME salt must be used at enroll AND at restore so the
 * SAME passkey derives the SAME PRF output → the same AES key → the box opens. The real
 * entropy is the device-bound authenticator secret; a constant eval salt is correct here.
 */
const PRF_SALT = new TextEncoder().encode("lumenia-recovery-prf-salt-v1");

const RP_NAME = "Lumenia";
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

// Local shapes for the (still-unstandardised in TS DOM) `prf` extension.
type PrfExtInput = { prf?: { eval?: { first: BufferSource } } };
type PrfExtOutput = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

/** True only where a platform authenticator + WebAuthn are present (a real browser, not a webview). */
export function isPasskeyCapable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.credentials
  );
}

/** Probe (best-effort) whether a platform authenticator is actually available on this device. */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isPasskeyCapable()) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function notSupported(): never {
  throw new Error("Face ID isn't available on this device — your password still works.");
}

/**
 * Enroll a NEW discoverable passkey bound to this account and derive its PRF output (to feed
 * wrapWithPrf). Some authenticators return the PRF output on create; others only on get — we
 * handle both. `userId` should be a stable per-account id (e.g. the account's raw public key).
 */
export async function enrollPasskeyPrf(opts: {
  userId: Uint8Array;
  userName: string;
}): Promise<{ credentialId: Uint8Array; prf: Uint8Array }> {
  if (!isPasskeyCapable()) notSupported();
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: RP_NAME },
      user: { id: bs(opts.userId), name: opts.userName, displayName: opts.userName },
      challenge: bs(crypto.getRandomValues(new Uint8Array(32))),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: bs(PRF_SALT) } } } as PrfExtInput,
    },
  })) as PublicKeyCredential | null;
  if (!cred) notSupported();
  const credentialId = new Uint8Array(cred.rawId);
  const ext = cred.getClientExtensionResults() as PrfExtOutput;
  const onCreate = ext.prf?.results?.first;
  if (onCreate) return { credentialId, prf: new Uint8Array(onCreate) };
  // The credential exists but didn't return the PRF on create → one get() derives it.
  if (ext.prf?.enabled === false) notSupported();
  const prf = await derivePasskeyPrf(credentialId);
  return { credentialId, prf };
}

/**
 * Re-derive the PRF output from an existing passkey (for unwrapWithPrf on restore / fast-unlock).
 * With no `credentialId` the browser lets the user pick any discoverable Lumenia passkey (the
 * cross-device restore path, where a synced passkey may live on a fresh device).
 */
export async function derivePasskeyPrf(credentialId?: Uint8Array): Promise<Uint8Array> {
  if (!isPasskeyCapable()) notSupported();
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: bs(crypto.getRandomValues(new Uint8Array(32))),
      allowCredentials: credentialId ? [{ type: "public-key", id: bs(credentialId) }] : [],
      userVerification: "required",
      extensions: { prf: { eval: { first: bs(PRF_SALT) } } } as PrfExtInput,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) notSupported();
  const ext = assertion.getClientExtensionResults() as PrfExtOutput;
  const first = ext.prf?.results?.first;
  if (!first) {
    throw new Error("Face ID didn't return a key on this device — your password still works.");
  }
  return new Uint8Array(first);
}
