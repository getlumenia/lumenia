import { test, expect, type BrowserContext } from "@playwright/test";
import { expectMoneyLanded } from "./landed";
import { cents, mintClaimLink, usd } from "./mintLink";

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

/**
 * What each asker asks for. It has to stay BELOW what one claim holds (0.50 from /demo-link today).
 * Past the payer's balance, /send quietly tops up from the practice faucet, and the pay would pass
 * on money this test never claimed.
 */
const ASK = "0.20";

/** Name the real cause in seconds if the minted amount ever shrinks to the ask or below. */
function expectAskFits(payerHas: string): void {
  expect(cents(ASK), `the ${usd(ASK)} ask must fit inside the payer's claimed ${usd(payerHas)}`).toBeLessThan(
    cents(payerHas),
  );
}

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

/** Claim a fresh real testnet link in this context → a funded local account. Returns what it held. */
async function claimFresh(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  const link = await mintClaimLink({ sponsor: SPONSOR, web: WEB, from: "Alvin" });
  await page.goto(link.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await page.getByRole("button", { name: /claim my money|^take \$/i }).click();
  await expectMoneyLanded(page);
  await page.close();
  return link.amount;
}

test("returning asker: request → pay to her address → collect on /home", async ({ browser }) => {
  test.setTimeout(480_000);

  // 1. The ASKER claims a fresh link once, so she is a returning user with an account.
  const asker = await browser.newContext();
  await rewriteSponsor(asker);
  const askerHas = await claimFresh(asker);

  // 2. She asks for ASK, and the link must carry her address.
  const askerPage = await asker.newPage();
  await askerPage.goto(`${WEB}/request`, { waitUntil: "domcontentloaded" });
  await askerPage.getByPlaceholder("0.00").fill(ASK);
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

  // 3. The PAYER (their own claimed money, separate device) opens the ask and pays.
  const payer = await browser.newContext();
  await rewriteSponsor(payer);
  expectAskFits(await claimFresh(payer));
  const payerPage = await payer.newPage();
  await payerPage.goto(askLink, { waitUntil: "domcontentloaded" });
  await expect(payerPage.getByText(/ayse is asking for/i)).toBeVisible();
  // exact: the "Pay Ayse $X.XX" button contains the same substring
  await expect(payerPage.getByText(usd(ASK), { exact: true })).toBeVisible();
  await payerPage.getByRole("button", { name: /pay ayse/i }).click();
  await expect(payerPage).toHaveURL(/\/send\?/);
  await expect(payerPage.getByPlaceholder("0.00")).toHaveValue(Number(ASK).toFixed(2));
  // paying straight to her account — no bearer link, so no "your name" field
  await expect(payerPage.getByPlaceholder(/e\.g\./)).toHaveCount(0);
  await payerPage.getByRole("button", { name: /pay ayse/i }).click();
  // copy.ts calls this `paidDirectTitle`: "Paid, and on its way".
  await expect(payerPage.getByText(/on its way/i)).toBeVisible({ timeout: 120_000 });

  // 4. The ASKER finds it waiting on /home and collects it: what she claimed plus ASK
  //    ($0.50 -> $0.70 at today's amounts).
  await askerPage.goto(`${WEB}/home`, { waitUntil: "domcontentloaded" });
  await expect(askerPage.getByText(/money waiting for you/i)).toBeVisible({ timeout: 60_000 });
  await expect(askerPage.getByText(`${usd(ASK)} is waiting`)).toBeVisible();
  await askerPage.getByRole("button", { name: /add to my money/i }).click();
  await expect(askerPage.getByText(/money waiting for you/i)).toHaveCount(0, { timeout: 120_000 });
  // Exact: the activity rows carry figures with a sign ("+$X.XX"); the balance is the bare figure.
  const collected = usd((cents(askerHas) + cents(ASK)) / 100);
  await expect(askerPage.getByText(collected, { exact: true })).toBeVisible({ timeout: 60_000 });
  console.log("\n✅ returning-asker loop: request → address-pay → collected on /home\n");

  await asker.close();
  await payer.close();
});

test("first-time asker: request with no account → payer sends the link back → asker claims", async ({ browser }) => {
  test.setTimeout(480_000);

  // 1. A FIRST-TIME asker (no account at all) asks for ASK.
  const asker = await browser.newContext();
  await rewriteSponsor(asker);
  const askerPage = await asker.newPage();
  await askerPage.goto(`${WEB}/request`, { waitUntil: "domcontentloaded" });
  await askerPage.getByPlaceholder("0.00").fill(ASK);
  await askerPage.getByPlaceholder(/so they know/i).fill("Zeynep");
  await askerPage.getByRole("button", { name: /create my request link/i }).click();
  const askLink = (await askerPage.getByTestId("request-link").textContent())?.trim() ?? "";
  expect(askLink).toMatch(/\/r\/[a-z2-7]+\?/);
  expect(askLink).not.toContain("to=");

  // 2. The PAYER opens the ask and pays — this path makes a bearer claim link
  //    framed as "send it back to Zeynep".
  const payer = await browser.newContext();
  await rewriteSponsor(payer);
  expectAskFits(await claimFresh(payer));
  const payerPage = await payer.newPage();
  await payerPage.goto(askLink, { waitUntil: "domcontentloaded" });
  await expect(payerPage.getByText(/zeynep is asking for/i)).toBeVisible();
  await payerPage.getByRole("button", { name: /pay zeynep/i }).click();
  await expect(payerPage).toHaveURL(/\/send\?/);
  await expect(payerPage.getByPlaceholder("0.00")).toHaveValue(Number(ASK).toFixed(2));
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
  // Exact: the v2 claim button repeats the figure ("Take $X.XX"), so a substring match finds two
  // elements. The headline is the value-first promise, so that is the one asserted. The figure is
  // read from the ledger after the page loads (a link no longer carries it), hence the wait.
  await expect(askerPage.getByText(usd(ASK), { exact: true })).toBeVisible({ timeout: 30_000 });
  await askerPage.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await askerPage.getByRole("button", { name: /claim my money|^take \$/i }).click();
  await expectMoneyLanded(askerPage);
  console.log("\n✅ first-time-asker loop: request → bearer link sent back → claimed\n");

  await asker.close();
  await payer.close();
});
