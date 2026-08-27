import { test, expect, type BrowserContext } from "@playwright/test";
import { expectMoneyLanded } from "./landed";
import { mintClaimLink } from "./mintLink";

/**
 * Request money — the pull loop, both §5.1 paths (REQUEST_MONEY.md §10). All real
 * testnet data, no stubs:
 *   1. RETURNING asker: has an account → her request carries `to=<address>` → the
 *      payer's money goes straight to her account (no bearer link) → she collects
 *      it on /home ("Money waiting for you").
 *   2. FIRST-TIME asker: no account → her request carries no address → the payer
 *      gets a normal bearer claim link with "send it back to <name>" framing → the
 *      asker claims it walletless, like any claim link.
 *
 * Local runs: the web build bakes the LIVE sponsor origin, whose CORS allowlist
 * pins the deployed web origin — so when SPONSOR_URL points elsewhere (a local
 * sponsor), browser calls to the baked origin are REWRITTEN to it. That is a URL
 * rewrite, not a stub: every byte still comes from the real sponsor code + the
 * real testnet.
 */
const SPONSOR = process.env.SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
const WEB = process.env.WEB_URL ?? "https://getlumenia.com";
const BAKED_SPONSOR = "https://lumenia-sponsor.avakit.workers.dev";

async function rewriteSponsor(context: BrowserContext) {
  if (SPONSOR === BAKED_SPONSOR) return;
  await context.route(`${BAKED_SPONSOR}/**`, async (route) => {
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

/** Claim a fresh real testnet link in this context → a funded local account. */
async function claimFresh(context: BrowserContext, amount: string): Promise<void> {
  const page = await context.newPage();
  const link = await mintClaimLink({ sponsor: SPONSOR, web: WEB, amount, from: "Alvin" });
  await page.goto(link.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await page.getByRole("button", { name: /claim my money/i }).click();
  await expectMoneyLanded(page);
  await page.close();
}

test("returning asker: request → pay to her address → collect on /home", async ({ browser }) => {
  test.setTimeout(480_000);

  // 1. The ASKER claims $20 once — she is a returning user with an account.
  const asker = await browser.newContext();
  await rewriteSponsor(asker);
  await claimFresh(asker, "20");

  // 2. She asks for $5 — the link must carry her address.
  const askerPage = await asker.newPage();
  await askerPage.goto(`${WEB}/request`, { waitUntil: "domcontentloaded" });
  await askerPage.getByPlaceholder("0.00").fill("5");
  await askerPage.getByPlaceholder(/so they know/i).fill("Ayse");
  await askerPage.getByRole("button", { name: /create my request link/i }).click();
  const askLink = (await askerPage.getByTestId("request-link").textContent())?.trim() ?? "";
  expect(askLink).toMatch(/\/r\/[a-z2-7]+\?/);
  expect(askLink).toContain("to=G");

  // 2b. She taps her OWN link (very common: checking the message she just sent).
  //     Paying yourself is a guaranteed on-chain rejection (duplicate claimant
  //     destinations), so she must get the honest own-request state, not a Pay button.
  await askerPage.goto(askLink, { waitUntil: "domcontentloaded" });
  await expect(askerPage.getByText(/this is your own request/i)).toBeVisible({ timeout: 30_000 });
  await expect(askerPage.getByRole("button", { name: /pay ayse/i })).toHaveCount(0);

  // 3. The PAYER (their own claimed $20, separate device) opens the ask and pays.
  const payer = await browser.newContext();
  await rewriteSponsor(payer);
  await claimFresh(payer, "20");
  const payerPage = await payer.newPage();
  await payerPage.goto(askLink, { waitUntil: "domcontentloaded" });
  await expect(payerPage.getByText(/ayse is asking for/i)).toBeVisible();
  // exact — "Pay Ayse $5.00" (the button) contains the same substring
  await expect(payerPage.getByText("$5.00", { exact: true })).toBeVisible();
  await payerPage.getByRole("button", { name: /pay ayse/i }).click();
  await expect(payerPage).toHaveURL(/\/send\?/);
  await expect(payerPage.getByPlaceholder("0.00")).toHaveValue("5.00");
  // paying straight to her account — no bearer link, so no "your name" field
  await expect(payerPage.getByPlaceholder(/e\.g\./)).toHaveCount(0);
  await payerPage.getByRole("button", { name: /pay ayse/i }).click();
  // copy.ts calls this `paidDirectTitle`: "Paid, and on its way".
  await expect(payerPage.getByText(/on its way/i)).toBeVisible({ timeout: 120_000 });

  // 4. The ASKER finds it waiting on /home and collects it: $20 → $25.
  await askerPage.goto(`${WEB}/home`, { waitUntil: "domcontentloaded" });
  await expect(askerPage.getByText(/money waiting for you/i)).toBeVisible({ timeout: 60_000 });
  await expect(askerPage.getByText(/\$5\.00 is waiting/i)).toBeVisible();
  await askerPage.getByRole("button", { name: /add to my money/i }).click();
  await expect(askerPage.getByText(/money waiting for you/i)).toHaveCount(0, { timeout: 120_000 });
  await expect(askerPage.getByText("$25.00")).toBeVisible({ timeout: 60_000 });
  console.log("\n✅ returning-asker loop: request → address-pay → collected on /home\n");

  await asker.close();
  await payer.close();
});

test("first-time asker: request with no account → payer sends the link back → asker claims", async ({ browser }) => {
  test.setTimeout(480_000);

  // 1. A FIRST-TIME asker (no account at all) asks for $3.
  const asker = await browser.newContext();
  await rewriteSponsor(asker);
  const askerPage = await asker.newPage();
  await askerPage.goto(`${WEB}/request`, { waitUntil: "domcontentloaded" });
  await askerPage.getByPlaceholder("0.00").fill("3");
  await askerPage.getByPlaceholder(/so they know/i).fill("Zeynep");
  await askerPage.getByRole("button", { name: /create my request link/i }).click();
  const askLink = (await askerPage.getByTestId("request-link").textContent())?.trim() ?? "";
  expect(askLink).toMatch(/\/r\/[a-z2-7]+\?/);
  expect(askLink).not.toContain("to=");

  // 2. The PAYER opens the ask and pays — this path makes a bearer claim link
  //    framed as "send it back to Zeynep".
  const payer = await browser.newContext();
  await rewriteSponsor(payer);
  await claimFresh(payer, "20");
  const payerPage = await payer.newPage();
  await payerPage.goto(askLink, { waitUntil: "domcontentloaded" });
  await expect(payerPage.getByText(/zeynep is asking for/i)).toBeVisible();
  await payerPage.getByRole("button", { name: /pay zeynep/i }).click();
  await expect(payerPage).toHaveURL(/\/send\?/);
  await expect(payerPage.getByPlaceholder("0.00")).toHaveValue("3.00");
  // The name lives behind a fold now, so naming the sender means opening it first — which is also
  // the only coverage that the fold OPENS at all. It stayed shut for a whole test run once.
  await payerPage.getByText(/sent as .* — change/i).click();
  await payerPage.getByPlaceholder(/e\.g\./).fill("Meric");
  await payerPage.getByRole("button", { name: /pay zeynep/i }).click();
  await expect(payerPage.getByText(/send this link back to zeynep/i)).toBeVisible({ timeout: 120_000 });
  const claimLink = (await payerPage.getByTestId("money-link").textContent())?.trim() ?? "";
  expect(claimLink).toMatch(/\/c\/.+#S/);

  // 3. The asker taps the link that came back — the normal walletless claim.
  await askerPage.goto(claimLink, { waitUntil: "domcontentloaded" });
  await expect(askerPage.getByText("$3.00")).toBeVisible();
  await askerPage.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await askerPage.getByRole("button", { name: /claim my money/i }).click();
  await expectMoneyLanded(askerPage);
  console.log("\n✅ first-time-asker loop: request → bearer link sent back → claimed\n");

  await asker.close();
  await payer.close();
});
