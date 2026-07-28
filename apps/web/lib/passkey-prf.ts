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
// Relying-Party id (security review F6): pin to the PRODUCTION apex (e.g. getlumenia.com) via
// NEXT_PUBLIC_RP_ID so a passkey enrolled on the real site restores on the real site (and across
// its subdomains). Unset ⇒ the browser defaults to the current origin's domain — the safe default
// for local dev / previews (a wrong rp.id breaks the ceremony). Spike #2 confirms the prod value.
const RP_ID = (typeof process !== "undefined" && process.env.NEXT_PUBLIC_RP_ID) || undefined;
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
  throw new Error("Face ID isn't available on this device. Your password still works.");
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
      rp: RP_ID ? { name: RP_NAME, id: RP_ID } : { name: RP_NAME },
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

export interface PasskeyAssertion {
  /** The PRF output — the secret that unwraps the seed, and (via prfToBoxId) addresses the box. */
  prf: Uint8Array;
  /**
   * The `user.id` set at enrollment, handed back by the authenticator: the account's raw 32-byte
   * Ed25519 public key. This is the account identity, and it has been sitting inside the
   * credential unread since the day passkeys shipped here. StrKey.encodeEd25519PublicKey turns it
   * into the G… address with the user typing nothing at all.
   *
   * Null where a browser or authenticator omits it, so treat it as a bonus rather than a
   * requirement: AES-GCM authentication on the box is the real integrity check, and this is a
   * cross-check and a way to show the address BEFORE anything is decrypted.
   */
  userHandle: Uint8Array | null;
  credentialId: Uint8Array;
}

/**
 * One discoverable assertion, returning everything the ceremony produced.
 *
 * With no `credentialId` the browser lets the user pick any discoverable Lumenia passkey — the
 * cross-device path, where a synced passkey lives on a phone that has never seen this account.
 */
export async function assertPasskeyPrf(credentialId?: Uint8Array): Promise<PasskeyAssertion> {
  if (!isPasskeyCapable()) notSupported();
  if (RP_ID && typeof location !== "undefined" && location.hostname !== RP_ID && !location.hostname.endsWith(`.${RP_ID}`)) {
    // Without this the browser throws a bare SecurityError. Worth naming, because the usual cause
    // is a preview deployment: a passkey enrolled there can never assert on the real site, and the
    // symptom the user sees is "no backup found" for money that exists.
    throw new Error(`This passkey belongs to ${RP_ID}. Open the site at that address to use Face ID.`);
  }
  const assertion = (await navigator.credentials.get({
    publicKey: {
      ...(RP_ID ? { rpId: RP_ID } : {}),
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
    throw new Error("Face ID didn't return a key on this device. Your password still works.");
  }
  const handle = (assertion.response as AuthenticatorAssertionResponse).userHandle;
  return {
    prf: new Uint8Array(first),
    userHandle: handle ? new Uint8Array(handle) : null,
    credentialId: new Uint8Array(assertion.rawId),
  };
}

/**
 * Re-derive just the PRF output from an existing passkey (for unwrapWithPrf on restore /
 * fast-unlock). A thin wrapper over assertPasskeyPrf so existing callers are untouched.
 */
export async function derivePasskeyPrf(credentialId?: Uint8Array): Promise<Uint8Array> {
  return (await assertPasskeyPrf(credentialId)).prf;
}
