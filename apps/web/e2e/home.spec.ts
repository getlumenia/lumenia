import { test, expect } from "@playwright/test";
import { expectMoneyLanded } from "./landed";
import { mintClaimLink } from "./mintLink";
import { rewriteSponsor } from "./sponsorRewrite";

/**
 * Stage 4 flow: claim → the account is persisted locally (Phase 1) → "See my money"
 * → /home reads the REAL balance + activity straight from Horizon (no-mock-data).
 * Runs against a local stack (local sponsor+web) pre-deploy, or the live URLs.
 */
const SPONSOR = process.env.SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
const WEB = process.env.WEB_URL ?? "https://getlumenia.com";

test("claim → persisted → /home shows the real balance + activity", async ({ page }) => {
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await rewriteSponsor(page.context()); // no-op against the live sponsor; enables local runs
  const link = await mintClaimLink({ sponsor: SPONSOR, web: WEB, amount: "20", from: "Alvin" });

  await page.goto(link.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await page.getByRole("button", { name: /claim my money/i }).click();
  await expectMoneyLanded(page);

  // hand-off: the claimed account is persisted → /home shows it
  await page.getByRole("link", { name: /see my money/i }).click();
  await expect(page).toHaveURL(/\/home/);
  await expect(page.getByText("Your money", { exact: true })).toBeVisible({ timeout: 30_000 });
  // The balance AND the activity row both read $20.00 (the row as "+$20.00"), so an unqualified
  // text match is a strict-mode violation rather than a failure of the app. Assert the big number.
  await expect(page.getByText("$20.00", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Received", { exact: true })).toBeVisible({ timeout: 30_000 });
  // honest custody label for a fresh (Phase 1) account
  await expect(page.getByText(/not locked/i)).toBeVisible();

  // Phase 2 — "lock this money to you" (Argon2id re-encrypt)
  const PW = "spike-password-123";
  await page.getByPlaceholder("Choose a password").fill(PW);
  await page.getByRole("button", { name: /^lock it$/i }).click();
  await expect(page.getByText(/locked with your password/i)).toBeVisible({ timeout: 30_000 });

  // /unlock — wrong password rejected, right password → back to /home
  await page.goto(WEB.replace(/\/$/, "") + "/unlock", { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Your password").fill("wrong-password");
  await page.getByRole("button", { name: /^unlock$/i }).click();
  await expect(page.getByText(/didn't work/i)).toBeVisible({ timeout: 15_000 });
  await page.getByPlaceholder("Your password").fill(PW);
  await page.getByRole("button", { name: /^unlock$/i }).click();
  await expect(page).toHaveURL(/\/home/, { timeout: 20_000 });
  console.log("\n✅ claim → /home → lock → unlock OK\n");
});
