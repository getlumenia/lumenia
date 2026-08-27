import { test, expect } from "@playwright/test";

/**
 * Desktop self-test of the key-lifecycle spike harness (Stage 3). Drives the full
 * cycle — keypair → friendbot fund → Argon2id encrypt → IndexedDB persist →
 * read-back + decrypt → sign a REAL testnet op → submit — and asserts PASS + a tx
 * hash. NOT part of the default regression; run explicitly against a flag-on dev
 * server: NEXT_PUBLIC_ENABLE_SPIKE=1 next dev, then `playwright test spike`.
 */
const SPIKE_URL = process.env.SPIKE_URL ?? "http://localhost:3000/spike/keys";

/**
 * SKIPPED unless its dev server is actually up. The file already says this is "NOT part of the
 * default regression" and needs `NEXT_PUBLIC_ENABLE_SPIKE=1 next dev` — but it still ran, still
 * failed on ERR_CONNECTION_REFUSED, and a suite with a permanent red in it is a suite people stop
 * reading. Point SPIKE_URL at a running server (or start one) and it runs as before.
 */
test("key-lifecycle: encrypt → persist → decrypt → sign real testnet op", async ({ page }) => {
  const reachable = await fetch(SPIKE_URL, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
  test.skip(!reachable, `spike harness not running at ${SPIKE_URL} (see the note above)`);
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(SPIKE_URL, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /key-lifecycle spike/i })).toBeVisible();

  await page.getByRole("button", { name: /run full spike/i }).click();
  await expect(page.getByText("✅ PASS", { exact: true })).toBeVisible({ timeout: 120_000 });

  const panel = await page.locator("dl").first().innerText();
  const txHref = await page.getByRole("link", { name: /^tx /i }).getAttribute("href");
  console.log("\n=== SPIKE RESULT (desktop) ===\n" + panel + "\n" + txHref + "\n");
  expect(txHref).toMatch(/\/tx\/[a-f0-9]{64}/i);
});
