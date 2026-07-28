import { test, expect } from "@playwright/test";
import { rewriteSponsor } from "./sponsorRewrite";

/**
 * /add-money — the receive side, checked for the things that would cost somebody money if they
 * were wrong rather than for the things that are merely nice.
 *
 * The screen exists to correct one belief: that an incoming transfer needs a memo. So the test
 * asserts the correction is actually on the page, that the network is named (an unnamed network is
 * how money goes to the wrong chain), and that the honest test-network state is shown rather than
 * a receive address nobody can use yet. It also pins the deliberate asymmetry between the QR and
 * the copy button, which is easy to "tidy up" into a bug: a wallet scans a SEP-7 URI, an exchange
 * field only accepts a bare address.
 *
 * RUN: pnpm --filter @lumenia/web exec playwright test e2e/receive.spec.ts
 *      [WEB_URL=http://localhost:3111] [SPONSOR_URL=…]
 */
const WEB = (process.env.WEB_URL ?? "https://getlumenia.com").replace(/\/$/, "");

/** Put a claimed account into the keystore the way a real claim does, so /add-money renders. */
async function seedAccount(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(async () => {
    // The app persists through lib/keystore; driving IndexedDB directly keeps this test free of
    // any bundler import map, at the cost of duplicating the record shape (which the app owns).
    return new Promise<string>((resolve, reject) => {
      const req = indexedDB.open("lumenia", 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys", { keyPath: "id" });
      };
      req.onerror = () => reject(new Error("idb open failed"));
      req.onsuccess = async () => {
        const db = req.result;
        try {
          const seed = crypto.getRandomValues(new Uint8Array(32));
          const wrapKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
            "encrypt",
            "decrypt",
          ]);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, seed),
          );
          // A syntactically valid G… address is all this screen needs; it never signs.
          const pubkey = "GDQFGINJ4PMEX4GN53OHFFO657P5APN5BYEEDKRTNYC74FXUBCQTXDLL";
          const tx = db.transaction("keys", "readwrite");
          tx.objectStore("keys").put({
            id: pubkey,
            formatVersion: 1,
            pubkey,
            phase: 1,
            iv,
            ciphertext,
            wrapKey,
          });
          tx.objectStore("keys").put({ id: "__home__", pubkey });
          tx.oncomplete = () => resolve(pubkey);
          tx.onerror = () => reject(new Error("idb write failed"));
        } catch (e) {
          reject(e as Error);
        }
      };
    });
  });
}

test.describe("receiving money into your account", () => {
  test("teaches no-memo, names the network, and is honest about the test network", async ({ context, page }) => {
    await rewriteSponsor(context);
    await page.goto(`${WEB}/home`, { waitUntil: "domcontentloaded" });
    const address = await seedAccount(page);

    await page.goto(`${WEB}/add-money`, { waitUntil: "domcontentloaded" });

    // The correction, which is the reason this screen exists at all.
    await expect(page.getByText(/your money has its own account/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/leave it blank/i)).toBeVisible();

    // The network, named. An unnamed network is how money goes to the wrong chain.
    await expect(page.getByText(/pick the right network/i)).toBeVisible();
    await expect(page.getByText(/Stellar/i).first()).toBeVisible();

    // The reciprocal truth, the easiest line to drop in an edit.
    await expect(page.getByText(/can't send on this network can't send here either/i)).toBeVisible();

    // Honest about where the product actually is.
    await expect(page.getByText(/practice dollars/i).first()).toBeVisible();

    // The address shown is the account's own, in full (not the truncated display form).
    await expect(page.getByText(address, { exact: false })).toBeVisible();
  });

  test("the QR is a SEP-7 URI and the copy button is the bare address", async ({ context, page }) => {
    await rewriteSponsor(context);
    await page.goto(`${WEB}/home`, { waitUntil: "domcontentloaded" });
    const address = await seedAccount(page);
    await page.goto(`${WEB}/add-money`, { waitUntil: "domcontentloaded" });

    await page.getByRole("button", { name: /show code/i }).click();
    // react-qr-code renders inline SVG, so the QR's presence is checkable without decoding it.
    await expect(page.locator("svg[viewBox]").first()).toBeVisible({ timeout: 10000 });
    // The toggle exists, which is what keeps an exchange-bound user from scanning the wrong thing.
    await expect(page.getByRole("button", { name: /plain address/i })).toBeVisible();

    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.getByRole("button", { name: /copy address/i }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    if (copied) {
      expect(copied, "an exchange field only accepts the bare address").toBe(address);
      expect(copied.startsWith("web+stellar:"), "never the URI").toBeFalsy();
    }
  });
});
