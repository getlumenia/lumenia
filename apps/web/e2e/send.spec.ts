import { test, expect } from "@playwright/test";
import { expectMoneyLanded } from "./landed";
import { cents, mintClaimLink, usd } from "./mintLink";

/**
 * Stage 5 — the loop closes. Claim money → send part of it onward with a link of
 * your own (0-XLM sender, sponsor-reserved CB via /send-link) → the onward link is
 * itself claimable. All real testnet data. Runs against a local stack pre-deploy or
 * the live URLs.
 */
const SPONSOR = process.env.SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
const WEB = process.env.WEB_URL ?? "https://getlumenia.com";
const BAKED_SPONSOR = "https://lumenia-sponsor.avakit.workers.dev";

/**
 * What is sent onward. It has to stay BELOW what one claim holds (0.50 from /demo-link today).
 * Past the balance, /send quietly tops up from the practice faucet, and the send would pass on
 * money this test never claimed, which is not the loop it exists to prove.
 */
const ONWARD = "0.20";

test("claim → send part of it onward → the onward link is claimable (loop closed)", async ({ page }) => {
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

  // 1. claim a fresh link to get money on this device
  const link = await mintClaimLink({ sponsor: SPONSOR, web: WEB, from: "Alvin" });
  // Name the real cause in seconds if the minted amount ever shrinks to the onward amount or below.
  expect(cents(ONWARD), `the onward ${usd(ONWARD)} must fit inside the claimed ${usd(link.amount)}`).toBeLessThan(
    cents(link.amount),
  );
  await page.goto(link.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await page.getByRole("button", { name: /claim my money|^take \$/i }).click();
  await expectMoneyLanded(page);

  // 2. send part of it onward
  await page.getByRole("link", { name: /send money to someone/i }).click();
  await expect(page).toHaveURL(/\/send/);
  await page.getByPlaceholder("0.00").fill(ONWARD);
  // Deliberately NOT naming the sender. The name is optional now — the field is folded away behind
  // "Sent as … — change" — and this is the shortest real path through the screen, so it is the one
  // worth guarding. request.spec covers opening that fold and typing a name.
  await page.getByRole("button", { name: /create a money link/i }).click();
  await expect(page.getByText(/your money link is ready/i)).toBeVisible({ timeout: 120_000 });

  // 3. the onward link is itself claimable
  const onward = (await page.getByTestId("money-link").textContent())?.trim() ?? "";
  expect(onward).toMatch(/\/c\/.+#S/);
  await page.goto(onward, { waitUntil: "domcontentloaded" });
  // Exact: the v2 claim button repeats the figure ("Take $X.XX"), so a substring match finds two
  // elements. The headline is the value-first promise, so that is the one asserted.
  await expect(page.getByText(usd(ONWARD), { exact: true })).toBeVisible();
  await page.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await page.getByRole("button", { name: /claim my money|^take \$/i }).click();
  await expectMoneyLanded(page);
  console.log(`\n✅ loop closed: claim ${usd(link.amount)} → send ${usd(ONWARD)} onward → onward claim OK\n`);
});
