import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { expectMoneyLanded } from "./landed";
import { mintClaimLink, usd } from "./mintLink";
import { PRIVATE_PREVIEW_DESCRIPTION, PRIVATE_PREVIEW_TITLE } from "../lib/link-preview";

/**
 * SOW 2, D2: a link is private by default. This is the leak audit's live half (the offline half is
 * lib/link-privacy.selftest.ts in CI). Against the deployed product, on testnet practice money:
 *
 *   1. the claim pages a chat app's preview bot fetches (four real bot user agents) carry no amount,
 *      no sender name and only the fixed preview tags, for the v1 practice link and for a v2 link
 *      made on /send with a sender name typed in;
 *   2. a forwarded link edited to say `?a=999&s=Mallory` still gets the fixed preview, and the page
 *      shows the amount the ledger holds, never the one written in the URL;
 *   3. the counters the claim page sends carry no amount, no URL and no name, and the link claims.
 *
 * A bot never sees the part after '#'. Neither does this test's fetch: `fetch` drops the fragment
 * before the request is made, exactly like a crawler.
 */
const SPONSOR = process.env.SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
const WEB = process.env.WEB_URL ?? "https://getlumenia.com";
const BAKED_SPONSOR = "https://lumenia-sponsor.avakit.workers.dev";

/** A sender name that appears nowhere else on the site, so finding it anywhere in a page is a leak. */
const NAME = "Zephyrine";
const ONWARD = "0.20";
const BOTS = [
  "WhatsApp/2.23.20.0",
  "TelegramBot (like TwitterBot)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Twitterbot/1.0",
];
/** What a beacon body may carry (apps/web/lib/events.ts). Anything else is a new channel. */
const BEACON_KEYS = new Set(["event", "cid", "aid", "seeded", "dur", "src"]);

/**
 * A local run builds the web against the LIVE sponsor origin, whose CORS allowlist pins the deployed
 * web origin, so the browser cannot call it from localhost. Re-issue those calls from Node (a URL
 * rewrite, not a stub: every byte still comes from the real sponsor and the real testnet).
 */
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

/** The address a bot fetches: everything before the '#'. */
const beforeHash = (link: string) => link.split("#")[0]!;

/** Add query params to a link without disturbing its fragment. */
function withQuery(link: string, extra: Record<string, string>): string {
  const [base, frag] = link.split("#");
  const u = new URL(base!);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return frag === undefined ? u.toString() : `${u.toString()}#${frag}`;
}

function metaContent(html: string, key: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)="${key}"[^>]*content="([^"]*)"|<meta[^>]+content="([^"]*)"[^>]*(?:property|name)="${key}"`, "i");
  const m = re.exec(html);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** Fetch a claim URL as each preview bot and hold the response to the private-preview contract. */
async function assertPrivateToBots(url: string, forbidden: string[]): Promise<void> {
  for (const ua of BOTS) {
    const res = await fetch(url, { headers: { "user-agent": ua }, redirect: "manual" });
    const html = await res.text();
    const who = `${ua.split(" ")[0]} on ${new URL(url).pathname}${new URL(url).search}`;
    expect(res.status, who).toBe(200);
    expect(res.headers.get("referrer-policy"), who).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag") ?? "", who).toMatch(/noindex/);
    // No dollar figure anywhere in the document, the RSC payload Next inlines included. A formatted
    // amount is "$0.20"; Next's own flight references ("$1", "$L2") have no cents, so they never match.
    expect(/\$\s?\d[\d,]*\.\d{2}/.test(html), `${who}: a dollar figure in the HTML`).toBe(false);
    for (const word of forbidden) expect(html.includes(word), `${who}: "${word}" in the HTML`).toBe(false);
    expect(html, who).toContain(`<title>${PRIVATE_PREVIEW_TITLE}</title>`);
    expect(metaContent(html, "og:title"), who).toBe(PRIVATE_PREVIEW_TITLE);
    expect(metaContent(html, "og:description"), who).toBe(PRIVATE_PREVIEW_DESCRIPTION);
    expect(metaContent(html, "description"), who).toBe(PRIVATE_PREVIEW_DESCRIPTION);
    expect(metaContent(html, "og:image") ?? "", who).toMatch(/\/og\.png$/);
    expect(metaContent(html, "twitter:card"), who).toBe("summary_large_image");
  }
}

/**
 * Every beacon the page sends, by body, so the test can say what left the device. Read through a
 * route: a `navigator.sendBeacon` body is a Blob, which the plain request event does not expose
 * (it reads as empty against production, where nothing else intercepts the call). `fallback` hands
 * the request on unchanged, to the local-run proxy when there is one, else to the network.
 */
async function collectBeacons(page: Page): Promise<string[]> {
  const bodies: string[] = [];
  await page.route("**/events", async (route) => {
    const req = route.request();
    if (req.method() === "POST") bodies.push(req.postDataBuffer()?.toString("utf8") ?? "");
    await route.fallback();
  });
  return bodies;
}

test("a private link: bots see no amount and no name, the page shows the ledger's amount, beacons stay clean", async ({ browser }) => {
  test.setTimeout(300_000);

  // 1. The v1 practice link, as /try mints it.
  const v1 = await mintClaimLink({ sponsor: SPONSOR, web: WEB, from: "Alvin" });
  expect(new URL(beforeHash(v1.url)).searchParams.has("a"), "a v1 link carries no amount").toBe(false);
  expect(new URL(beforeHash(v1.url)).searchParams.has("s"), "a v1 link carries no name in its query").toBe(false);
  await assertPrivateToBots(beforeHash(v1.url), []);

  // 2. A sender claims it, then makes a v2 link on /send with a name typed in.
  const sender = await browser.newContext();
  await proxySponsorForLocalRuns(sender);
  const page = await sender.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(v1.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await page.getByRole("button", { name: /claim my money|^take \$/i }).click();
  await expectMoneyLanded(page);
  await page.getByRole("link", { name: /send money to someone/i }).click();
  await expect(page).toHaveURL(/\/send/);
  await page.getByPlaceholder("0.00").fill(ONWARD);
  await page.getByText(/sent as .* change/i).click();
  await page.getByPlaceholder(/e\.g\./).fill(NAME);
  await page.getByRole("button", { name: /create a money link/i }).click();
  await expect(page.getByText(/your money link is ready/i)).toBeVisible({ timeout: 120_000 });
  const link = (await page.getByTestId("money-link").textContent())?.trim() ?? "";
  await sender.close();

  // The link itself: no amount anywhere, the name only after the '#', the key first there.
  const query = new URL(beforeHash(link)).searchParams;
  expect(link).toMatch(/\/v2\/c\/[0-9a-f]{64}/);
  expect(query.has("a") || query.has("s") || query.has("p"), `query of ${beforeHash(link)}`).toBe(false);
  expect(link.includes(ONWARD) || link.includes("0.2000000"), "the amount is nowhere in the link").toBe(false);
  expect(link.split("#")[1] ?? "").toMatch(new RegExp(`^S[A-Z2-7]{55}&s=${NAME}$`));

  // 3. What every preview bot gets for it, and for a copy edited to lie about the amount and sender.
  // The private link's HTML carries neither the name nor the ledger amount in any form. The edited
  // copy gets the same fixed preview; Next echoes the request's own query into its router data, so
  // "999" and "Mallory" may sit in a script there, but only as the bytes the bot itself sent, never
  // in a title, a preview tag or a dollar figure (assertPrivateToBots checks those).
  await assertPrivateToBots(beforeHash(link), [NAME, "0.2000000"]);
  const spoofed = withQuery(link, { a: "999", s: "Mallory" });
  await assertPrivateToBots(beforeHash(spoofed), [NAME]);

  // 4. A recipient opens the edited copy on a fresh device: the ledger's amount, never the URL's.
  const recipient = await browser.newContext();
  await proxySponsorForLocalRuns(recipient);
  const claim = await recipient.newPage();
  const beacons = await collectBeacons(claim);
  await claim.goto(spoofed, { waitUntil: "domcontentloaded" });
  await expect(claim.getByText(usd(ONWARD), { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(claim.getByText(/verified on the ledger/i)).toBeVisible();
  await expect(claim.getByText(/\$999/)).toHaveCount(0);
  await expect(claim.getByText(new RegExp(`${NAME} sent you money`, "i"))).toBeVisible();
  await expect(claim.getByText(/mallory/i)).toHaveCount(0);
  await claim.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await claim.getByRole("button", { name: /claim my money|^take \$/i }).click();
  await expectMoneyLanded(claim);

  // 5. The counters that left the recipient's device.
  expect(beacons.length, "the claim page sent its counters").toBeGreaterThan(0);
  for (const body of beacons) {
    expect(body.length, "a beacon body the test could read").toBeGreaterThan(0);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(parsed).every((k) => BEACON_KEYS.has(k)), `beacon keys: ${body}`).toBe(true);
    for (const leak of ["http", "#", NAME, "Mallory", "999", ONWARD, "0.2"]) {
      expect(body.includes(leak), `beacon carries "${leak}": ${body}`).toBe(false);
    }
  }
  await recipient.close();

  // 6. The same link opened again on another fresh device: the escrow says it is spent, so the
  //    settled screen comes up front with the ledger's figure, and no button buys a sponsored
  //    account just to be told the same thing.
  const later = await browser.newContext();
  await proxySponsorForLocalRuns(later);
  const again = await later.newPage();
  await again.goto(link, { waitUntil: "domcontentloaded" });
  await expect(again.getByText(/already been used/i)).toBeVisible({ timeout: 30_000 });
  await expect(again.getByText(usd(ONWARD)).first()).toBeVisible();
  await expect(again.getByRole("button", { name: /claim my money|^take \$/i })).toHaveCount(0);
  await later.close();
  console.log(`\nprivate link OK: ${beforeHash(link)}#<key> - bots saw no amount or name, the page showed ${usd(ONWARD)} from the ledger`);
});
