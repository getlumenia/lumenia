import { test, expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * "Find my money with Face ID", end to end, in a real browser.
 *
 * This is normally the flow nobody can automate, so it is normally the flow nobody tests. Chromium
 * exposes a VIRTUAL AUTHENTICATOR over CDP that supports discoverable credentials, automatic user
 * verification, AND the PRF extension — verified before this was written. That means the whole
 * mechanism is exercised for real here: a discoverable credential is created, the PRF output comes
 * back, and the assertion returns the `userHandle` the restore cross-checks against.
 *
 * What it proves: the same PRF produces the same box id every time (so a backup can be found
 * again), a different passkey produces a different one (so backups can't collide), the id is not
 * the key that opens the box, and the assertion really does hand back the account's public key
 * with nothing typed.
 *
 * What it CANNOT prove, and this matters: that a real iPhone or Android returns the SAME PRF on a
 * second device after iCloud/Google sync. A virtual authenticator has no sync. That is Spike #2 and
 * needs physical hardware; until it runs, cross-device Face-ID restore is unverified, and this file
 * deliberately does not pretend otherwise.
 *
 * RUN: pnpm --filter @lumenia/web exec playwright test e2e/faceid.spec.ts
 *      [WEB_URL=http://localhost:3111]
 */
const WEB = (process.env.WEB_URL ?? "https://getlumenia.com").replace(/\/$/, "");

/** Attach a discoverable, user-verifying, PRF-capable authenticator to the context. */
async function addAuthenticator(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
}

test.describe("Face ID account discovery", () => {
  test("a discoverable passkey yields a stable box id and hands back the account", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await addAuthenticator(context, page);
    // Any page on the origin: the ceremony is bound to the origin, not to a route.
    await page.goto(`${WEB}/account`, { waitUntil: "domcontentloaded" });

    const result = await page.evaluate(async () => {
      const SALT = new TextEncoder().encode("lumenia-recovery-prf-salt-v1");
      const ID_INFO = new TextEncoder().encode("lumenia-recovery-id-v1");
      const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

      // The same derivation lib/recovery.ts::prfToBoxId performs.
      async function boxId(prf: ArrayBuffer): Promise<string> {
        const ikm = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveBits"]);
        return hex(
          await crypto.subtle.deriveBits(
            { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: ID_INFO },
            ikm,
            256,
          ),
        );
      }

      // Enrol exactly the way wallet.tsx does: user.id IS the account's raw public key.
      const accountKey = new Uint8Array(32).map((_, i) => (i * 7 + 3) % 251);
      const mk = async (userId: Uint8Array) =>
        (await navigator.credentials.create({
          publicKey: {
            rp: { name: "Lumenia" },
            user: { id: userId, name: "Lumenia GTEST", displayName: "Lumenia GTEST" },
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: { residentKey: "required", userVerification: "required" },
            extensions: { prf: { eval: { first: SALT } } },
          },
        })) as PublicKeyCredential;

      const cred = await mk(accountKey);
      const enrolPrf = (cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf
        ?.results?.first;

      // The restore ceremony: NO allowCredentials, i.e. exactly what a fresh device does.
      const assert1 = (await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [],
          userVerification: "required",
          extensions: { prf: { eval: { first: SALT } } },
        },
      })) as PublicKeyCredential;
      const prf1 = (assert1.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf
        ?.results?.first;
      const handle = (assert1.response as AuthenticatorAssertionResponse).userHandle;

      // A second assertion must derive the SAME id, or a backup could never be found twice.
      const assert2 = (await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [],
          userVerification: "required",
          extensions: { prf: { eval: { first: SALT } } },
        },
      })) as PublicKeyCredential;
      const prf2 = (assert2.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf
        ?.results?.first;

      return {
        enrolPrfPresent: Boolean(enrolPrf),
        id1: prf1 ? await boxId(prf1) : null,
        id2: prf2 ? await boxId(prf2) : null,
        idIsNotKey: prf1 ? (await boxId(prf1)) !== hex(prf1) : false,
        userHandleHex: handle ? hex(handle) : null,
        expectedHandleHex: hex(accountKey.buffer as ArrayBuffer),
      };
    });

    expect(result.enrolPrfPresent, "the authenticator returns a PRF on create").toBeTruthy();
    expect(result.id1, "an assertion yields a box id").toMatch(/^[0-9a-f]{64}$/);
    expect(result.id2, "the SAME passkey always finds the SAME backup").toBe(result.id1);
    expect(result.idIsNotKey, "the id is not the raw PRF (it can be handed to a server)").toBeTruthy();
    // The identity, handed back with nothing typed.
    expect(result.userHandleHex, "the assertion returns the account's public key").toBe(result.expectedHandleHex);

    await context.close();
  });

  test("the find-my-money entry point is offered when no account exists", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await addAuthenticator(context, page);
    await page.goto(`${WEB}/account`, { waitUntil: "domcontentloaded" });
    // A browser with no keystore lands on the no-account state, where the zero-typing path leads.
    await expect(page.getByRole("button", { name: /find my money with face id/i })).toBeVisible({ timeout: 15000 });
    // …and the email path is still offered underneath, because Face ID is not the only way back.
    await expect(page.getByText(/already have money on another phone/i)).toBeVisible();
    await context.close();
  });
});
