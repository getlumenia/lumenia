import { test, expect, type BrowserContext } from "@playwright/test";
import { expectMoneyLanded } from "./landed";
import { mintClaimLink, usd } from "./mintLink";

/**
 * SOW 2, D2: the two private-link variants the nightly preview spec does not open in a browser, a
 * password-locked link and a group link, made on /send and /group and claimed on a fresh device.
 * The claim page reads their amount from the escrow (a locked link before the password is typed, a
 * pot's per-share figure), shows the lock line from the fragment, and claims.
 *
 * On demand, not nightly: it spends a practice link and three escrow transactions.
 *   WEB_URL=http://localhost:3000 SPONSOR_URL=https://lumenia-sponsor.avakit.workers.dev:443 \
 *     pnpm --filter @lumenia/web exec playwright test e2e/private-variants.spec.ts
 */
const SPONSOR = process.env.SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
const WEB = process.env.WEB_URL ?? "https://getlumenia.com";
const BAKED_SPONSOR = "https://lumenia-sponsor.avakit.workers.dev";
const PASSWORD = "tangerine-lighthouse-47";
const LOCKED = "0.10";
const SHARE = "0.10";

/** See preview.spec.ts: a local run reaches the live sponsor from Node, because its CORS pins getlumenia.com. */
async function proxySponsorForLocalRuns(context: BrowserContext): Promise<void> {
  if (new URL(WEB).origin === "https://getlumenia.com" && SPONSOR === BAKED_SPONSOR) return;
  await context.route(`${BAKED_SPONSOR}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const res = await fetch(`${SPONSOR}${url.pathname}${url.search}`, {
      method: req.method(),
      headers: req.postData() ? { "content-type": "application/json" } : undefined,
      body: req.postData() ?? undefined,
    });
    await route.fulfill({ status: res.status, body: await res.text(), contentType: res.headers.get("content-type") ?? "application/json" });
  });
}

test("a password-locked link and a group link: private shape, ledger amount, lock line, claimed", async ({ browser }) => {
  test.setTimeout(420_000);

  // Money to send from: a practice link claimed into a fresh account.
  const sender = await browser.newContext();
  await proxySponsorForLocalRuns(sender);
  const page = await sender.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  const v1 = await mintClaimLink({ sponsor: SPONSOR, web: WEB });
  await page.goto(v1.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await page.getByRole("button", { name: /claim my money|^take \$/i }).click();
  await expectMoneyLanded(page);

  // 1. A password-locked link from /send (testnet: the box starts unticked, so tick it).
  await page.goto(`${WEB}/send`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("0.00").fill(LOCKED);
  await page.getByText("Make them enter a password").click();
  await page.getByLabel("Claim password").fill(PASSWORD);
  await page.getByRole("button", { name: /create a money link/i }).click();
  await expect(page.getByText(/your money link is ready/i)).toBeVisible({ timeout: 120_000 });
  const locked = (await page.getByTestId("money-link").textContent())?.trim() ?? "";
  const lockedQuery = new URL(locked.split("#")[0]!).searchParams;
  expect(lockedQuery.has("a") || lockedQuery.has("s") || lockedQuery.has("p"), `query of ${locked.split("#")[0]}`).toBe(false);
  // The seed (base64url) first, then the name if one was set, then the lock marker; no password anywhere.
  expect(locked.split("#")[1] ?? "").toMatch(/^p1\.[A-Za-z0-9_-]+(&s=[^&#]+)?&p=1$/);
  expect(locked.includes(PASSWORD)).toBe(false);

  const r1 = await browser.newContext();
  await proxySponsorForLocalRuns(r1);
  const claimLocked = await r1.newPage();
  await claimLocked.goto(locked, { waitUntil: "domcontentloaded" });
  await expect(claimLocked.getByText(/this one is locked/i)).toBeVisible({ timeout: 30_000 });
  await expect(claimLocked.getByText(usd(LOCKED), { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(claimLocked.getByText(/verified on the ledger/i)).toBeVisible();
  await claimLocked.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await claimLocked.getByLabel("Password").fill(PASSWORD);
  await claimLocked.getByRole("button", { name: /claim my money|^take \$/i }).click();
  await expectMoneyLanded(claimLocked);
  await r1.close();

  // 2. A group link from /group: two shares of SHARE each.
  await page.goto(`${WEB}/group`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("0.00").fill(SHARE);
  for (let i = 0; i < 30; i++) {
    const fewer = page.getByRole("button", { name: "fewer people" });
    if (!(await fewer.isEnabled())) break;
    const before = await page.locator("span.tabular-nums").first().textContent();
    await fewer.click();
    if ((await page.locator("span.tabular-nums").first().textContent()) === before) break;
  }
  await page.getByRole("button", { name: /make the link/i }).click();
  await expect(page.getByTestId("money-link")).toBeVisible({ timeout: 120_000 });
  const pot = (await page.getByTestId("money-link").textContent())?.trim() ?? "";
  const potQuery = new URL(pot.split("#")[0]!).searchParams;
  expect(potQuery.get("g"), `query of ${pot.split("#")[0]}`).toBe("2");
  expect(potQuery.has("a") || potQuery.has("s")).toBe(false);
  expect(pot.split("#")[1] ?? "").toMatch(/^S[A-Z2-7]{55}(&s=[^&#]+)?&g=2$/);
  await sender.close();

  const r2 = await browser.newContext();
  await proxySponsorForLocalRuns(r2);
  const claimShare = await r2.newPage();
  await claimShare.goto(pot, { waitUntil: "domcontentloaded" });
  await expect(claimShare.getByText(usd(SHARE), { exact: true })).toBeVisible({ timeout: 30_000 });
  await claimShare.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await claimShare.getByRole("button", { name: /take my share/i }).click();
  await expectMoneyLanded(claimShare);
  await r2.close();
  console.log(`\nprivate variants OK: locked ${locked.split("#")[0]}#<seed> and pot ${pot.split("#")[0]}#<key> both read from the ledger and claimed`);
});
