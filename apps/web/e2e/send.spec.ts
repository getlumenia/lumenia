import { test, expect } from "@playwright/test";
import { mintClaimLink } from "./mintLink";

/**
 * Stage 5 — the loop closes. Claim money → send part of it onward with a link of
 * your own (0-XLM sender, sponsor-reserved CB via /send-link) → the onward link is
 * itself claimable. All real testnet data. Runs against a local stack pre-deploy or
 * the live URLs.
 */
const SPONSOR = process.env.SPONSOR_URL ?? "https://lumenia-sponsor.vercel.app";
const WEB = process.env.WEB_URL ?? "https://lumenia-chi.vercel.app";
const BAKED_SPONSOR = "https://lumenia-sponsor.vercel.app";

test("claim → send $7 onward → the onward link is claimable (loop closed)", async ({ page }) => {
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  // For local runs the web build bakes the LIVE sponsor origin, whose CORS allowlist pins the
  // deployed web origin — so a browser call from localhost is blocked. Rewrite the baked origin to
  // the target sponsor (a URL swap, not a stub: every byte still comes from the real sponsor code +
  // real testnet). Same helper request.spec uses; no-op when the target IS the baked origin.
  if (SPONSOR !== BAKED_SPONSOR) {
    await page.context().route(`${BAKED_SPONSOR}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const res = await fetch(`${SPONSOR}${url.pathname}${url.search}`, {
        method: req.method(),
        headers: req.postData() ? { "content-type": "application/json" } : undefined,
        body: req.postData() ?? undefined,
      });
      await route.fulfill({
        status: res.status,
        body: await res.text(),
        contentType: res.headers.get("content-type") ?? "application/json",
      });
    });
  }

  // 1. claim $20 to get money on this device
  const link = await mintClaimLink({ sponsor: SPONSOR, web: WEB, amount: "20", from: "Alvin" });
  await page.goto(link.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await page.getByRole("button", { name: /claim my money/i }).click();
  await expect(page.getByText(/in your account/i)).toBeVisible({ timeout: 120_000 });

  // 2. send $7 onward
  await page.getByRole("link", { name: /send money to someone/i }).click();
  await expect(page).toHaveURL(/\/send/);
  await page.getByPlaceholder("0.00").fill("7");
  await page.getByPlaceholder(/e\.g\./).fill("Meric");
  await page.getByRole("button", { name: /create a money link/i }).click();
  await expect(page.getByText(/your money link is ready/i)).toBeVisible({ timeout: 120_000 });

  // 3. the onward link is itself claimable
  const onward = (await page.getByTestId("money-link").textContent())?.trim() ?? "";
  expect(onward).toMatch(/\/c\/.+#S/);
  await page.goto(onward, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("$7.00")).toBeVisible();
  await page.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await page.getByRole("button", { name: /claim my money/i }).click();
  await expect(page.getByText(/in your account/i)).toBeVisible({ timeout: 120_000 });
  console.log("\n✅ loop closed: claim $20 → send $7 onward → onward claim OK\n");
});
