#!/usr/bin/env node
/**
 * The extension end to end on TESTNET through the POPUP'S OWN SCREENS, and the five store
 * screenshots taken from those real screens on the way.
 *
 *   1. a throwaway practice account is made and backed up on getlumenia.com (e2e/lib.mjs);
 *   2. in the popup: Hello -> Get started; "One thing first" -> Agree; "Yes, bring it here"; email; the
 *      mailed code; the backup password;
 *   3. "Paste a Lumenia link here" is chosen on the chat box of a local page (the click is
 *      simulated); in the popup, $0.10 -> "Make the link"; the worker pastes the link into that box;
 *   4. two more $0.10 links are made in the popup; the Links screen shows them Waiting;
 *   5. the pasted link is claimed on getlumenia.com in a browser with no extension, and the Links
 *      screen turns it Claimed;
 *   6. after the 180 s expiry of the end-to-end build, one link is taken back with the screen's own
 *      "Take it back" button (Reclaimed), the other is left Reclaimable for the screenshot, then
 *      taken back too, so no link shown in any image can still be claimed.
 *
 * Shots land in dist/store-shots/raw-*.png (the popup at 2x) and the 1280x800 composites in
 * store/screenshots/ (01-hello, 02-send, 03-link-ready, 04-paste, 05-links). Evidence in
 * dist/e2e-evidence-ui-<time>.json.
 *
 *   node build.mjs --e2e-ttl=180 && node e2e/ui.e2e.mjs     (from apps/extension; about seven minutes)
 *   node e2e/ui.e2e.mjs --compose-only                     re-make the composites from the last raw captures
 *   node build.mjs --e2e-ttl=604800 && node e2e/ui.e2e.mjs --paste-shots
 *                                                          re-take shots 3 and 4 with the store's own
 *                                                          seven days, then claim both links shown
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  ROOT,
  chromium,
  HEADLESS,
  PASSWORD,
  SEND_USD,
  log,
  sleep,
  evidence,
  expert,
  inbox,
  makeBackedUpAccount,
  extensionContext,
  serveTestPage,
  simulateMenuClick,
  claimOnWeb,
  writeEvidence,
} from "./lib.mjs";

evidence.mode = "ui";
const RAW = path.join(ROOT, "dist", "store-shots");
const OUT = path.join(ROOT, "store", "screenshots");

async function main() {
  if (!process.argv.includes("--paste-shots")) await rm(RAW, { recursive: true, force: true });
  await mkdir(RAW, { recursive: true });
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: HEADLESS });
  const mail = await inbox();
  evidence.inbox = mail.address;
  const short = await makeBackedUpAccount(browser, mail);
  evidence.webAccountShort = short;

  const ext = await extensionContext({ deviceScaleFactor: 2, locale: "en-US", timezoneId: "UTC", colorScheme: "light" });
  const p = ext.page;
  await p.setViewportSize({ width: 360, height: 600 });
  await p.reload();
  const shot = async (name) => {
    await p.waitForTimeout(400); // let transitions settle
    await p.screenshot({ path: path.join(RAW, `raw-${name}.png`) });
    log(`shot ${name}`);
  };

  // The name field sits behind "Add your name or a password" until it is opened.
  const fillFrom = async (name) => {
    const field = p.getByLabel("From (optional)");
    if (!(await field.isVisible().catch(() => false))) await p.getByRole("button", { name: /Add your name or a password/ }).click();
    await field.fill(name);
  };

  // 2. first run: hello, the agreement, the account question, then restore through the screens
  const getStarted = p.getByRole("button", { name: "Get started" });
  await getStarted.waitFor({ timeout: 30_000 });
  await shot("hello");
  await getStarted.click();
  const agree = p.getByRole("button", { name: "Agree and continue" });
  await agree.waitFor({ timeout: 10_000 });
  await shot("before-you-start");
  await agree.click();
  await p.getByRole("button", { name: "Yes, bring it here" }).click();
  await mail.skipExisting();
  await p.getByLabel("Email").fill(mail.address);
  await p.getByRole("button", { name: "Send me a code" }).click();
  const code = await mail.nextCode();
  log("popup: restore code arrived by mail");
  await p.getByLabel("6-digit code").fill(code);
  await p.getByLabel("Backup password").fill(PASSWORD, { timeout: 60_000 });
  await p.getByRole("button", { name: /^Restore$/ }).click();
  await p.getByLabel("Amount").waitFor({ timeout: 90_000 });
  const { pubkey } = (await ext.ask({ type: "state" })).account;
  evidence.account = pubkey;
  const same = short.startsWith(pubkey.slice(0, 6)) && short.endsWith(pubkey.slice(-6));
  log(`popup: restored ${pubkey} (same account as the web: ${same})`);
  if (!same) throw new Error("the restored account is not the one backed up on the web");

  // Shot 1: the Send screen with an amount and a name typed, nothing pressed. The amount stays
  // under what the restored account holds (one $0.50 practice link), so the picture never shows a
  // send the balance could not cover.
  await p.getByText(/You have \$/).waitFor({ timeout: 30_000 }).catch(() => undefined);
  await p.getByLabel("Amount").fill("0.25");
  await fillFrom("Alex");
  if (!process.argv.includes("--paste-shots")) await shot("send");

  // 3. the paste target, then the first link from the screen
  const { server, url: pageUrl } = await serveTestPage();
  const chatPage = await ext.ctx.newPage();
  await chatPage.setViewportSize({ width: 640, height: 400 });
  await chatPage.goto(pageUrl);
  await chatPage.focus("#chat");
  await simulateMenuClick(ext, pageUrl);
  await p.bringToFront();
  await p.reload();
  await p.getByText(/will be pasted into/i).waitFor({ timeout: 15_000 });
  await p.getByLabel("Amount").fill(SEND_USD);
  await fillFrom("Alex");
  const t1 = Date.now();
  await p.getByRole("button", { name: "Make the link" }).click();
  await p.getByText("Your link is ready").waitFor({ timeout: 120_000 });
  const pastedAfterMs = Date.now() - t1;
  const linkA = ((await chatPage.locator("#chat").textContent()) ?? "").trim();
  // src=ext is the last query parameter, and on practice money the only one (`?src=ext#...`).
  log(`popup: link A made, the chat box holds it after ${pastedAfterMs} ms (${/[?&]src=ext#/.test(linkA) ? "src=ext present" : "NO src"})`);
  await p.getByText("Pasted into the page").waitFor({ timeout: 10_000 });
  await shot("ready-pasted");
  await chatPage.locator("#chat").screenshot({ path: path.join(RAW, "raw-chatbox.png") });
  evidence.paste = { boxHoldsALink: /^https:\/\/getlumenia\.com\/v2\/c\/[0-9a-f]{64}\?/.test(linkA), msFromClickToReady: pastedAfterMs };
  // The private shape (0.1.3): no amount and no name in the query; the name typed for A rides after the '#'.
  const urlA = new URL(linkA);
  evidence.linkA = {
    noAmountOrNameInQuery: !urlA.searchParams.has("a") && !urlA.searchParams.has("s"),
    typedNameAfterHash: urlA.hash.split("&").slice(1).includes("s=Alex"),
  };
  if (!evidence.linkA.noAmountOrNameInQuery || !evidence.linkA.typedNameAfterHash) {
    throw new Error(`link A is not the private shape: ${JSON.stringify(evidence.linkA)}`);
  }

  if (process.argv.includes("--paste-shots")) {
    // Screenshot pass on the seven-day build: one more link for shot 2, then spend both links shown.
    await p.getByRole("button", { name: "Make another link" }).click();
    await p.getByLabel("Amount").fill(SEND_USD);
    await p.getByRole("button", { name: "Make the link" }).click();
    await p.getByText("Your link is ready").waitFor({ timeout: 120_000 });
    await shot("link-ready");
    const shown = (await ext.ask({ type: "links.list" })).slice(0, 2);
    const spent = [];
    for (const r of shown) {
      const { link } = await ext.ask({ type: "links.reveal", linkHex: r.linkHex });
      spent.push({ linkHex: r.linkHex, depositHash: r.hash, claimHash: await claimOnWeb(browser, link) });
    }
    evidence.shotLinksSpent = spent;
    log(`both links shown in the shots were claimed: ${spent.map((x) => x.claimHash.slice(0, 10)).join(", ")}`);
    server.close();
    log(`evidence written to ${await writeEvidence("-shots")}`);
    await ext.ctx.close();
    await compose(browser);
    await browser.close();
    return;
  }

  // 4. two more links from the screen (B shown on "Your link is ready" for shot 2)
  await p.getByRole("button", { name: "Make another link" }).click();
  await p.getByLabel("Amount").fill(SEND_USD);
  await p.getByRole("button", { name: "Make the link" }).click();
  await p.getByText("Your link is ready").waitFor({ timeout: 120_000 });
  await shot("link-ready");
  await p.getByRole("button", { name: "Make another link" }).click();
  await p.getByLabel("Amount").fill(SEND_USD);
  await p.getByRole("button", { name: "Make the link" }).click();
  await p.getByText("Your link is ready").waitFor({ timeout: 120_000 });
  const made = (await ext.ask({ type: "links.list" })).slice(0, 3); // newest first: C, B, A
  evidence.links = made.map((r) => ({ linkHex: r.linkHex, depositHash: r.hash, depositUrl: expert(r.hash), expiry: r.expiry }));
  log(`popup: three links made: ${made.map((r) => r.hash.slice(0, 10)).join(", ")}`);
  // B and C were made after "Make another link" with nothing typed in From: the field started empty,
  // so neither link carries a name, before or after the '#'.
  for (const r of made.slice(0, 2)) {
    const { link } = await ext.ask({ type: "links.reveal", linkHex: r.linkHex });
    const u = new URL(link);
    const noName = !u.searchParams.has("s") && !u.hash.split("&").slice(1).some((p) => p.startsWith("s=")) && r.from === "";
    if (!noName) throw new Error(`a link made with an empty From carries a name: ${r.linkHex}`);
  }
  evidence.untypedLinksCarryNoName = true;

  await p.getByRole("button", { name: "Links" }).click();
  await p.locator("li.row-card--waiting").first().waitFor({ timeout: 30_000 });
  evidence.waitingBeforeClaim = await p.locator("li.row-card--waiting").count();

  // 5. claim A (the pasted one) on the web; the Links screen turns it Claimed
  const claimHash = await claimOnWeb(browser, linkA);
  evidence.claimA = { claimHash, claimUrl: expert(claimHash) };
  log(`web: link A claimed with no extension, ${claimHash}`);
  for (let i = 0; i < 12; i++) {
    await p.reload();
    await p.getByRole("button", { name: "Links" }).click();
    if (await p.locator("li.row-card--claimed").count()) break;
    await sleep(5_000);
  }
  evidence.claimedShownOnScreen = (await p.locator("li.row-card--claimed").count()) === 1;
  log(`popup: Links shows Claimed: ${evidence.claimedShownOnScreen}`);
  server.close();

  // 6. after the expiry: take one back with the screen's button, shoot, then take the other back
  const newest = made[0];
  const wait = newest.expiry * 1000 - Date.now() + 15_000;
  log(`waiting ${Math.ceil(wait / 1000)} s for the links' expiry`);
  await sleep(Math.max(0, wait));
  await p.reload();
  await p.getByRole("button", { name: "Links" }).click();
  await p.locator("li.row-card--reclaimable").nth(1).waitFor({ timeout: 60_000 });
  const first = p.locator("li.row-card--reclaimable").first();
  await first.getByRole("button", { name: "Take it back" }).click();
  await p.locator(".confirm").getByRole("button", { name: "Take it back" }).click();
  await p.locator("li.row-card--reclaimed").first().waitFor({ timeout: 120_000 });
  log("popup: one link taken back with the screen's own button");
  await p.evaluate(() => window.scrollTo(0, 0));
  await shot("links");

  const second = p.locator("li.row-card--reclaimable").first();
  await second.getByRole("button", { name: "Take it back" }).click();
  await p.locator(".confirm").getByRole("button", { name: "Take it back" }).click();
  await p.locator("li.row-card--reclaimed").nth(1).waitFor({ timeout: 120_000 });
  const finalList = await ext.ask({ type: "links.list" });
  evidence.final = finalList.slice(0, 3).map((r) => ({ linkHex: r.linkHex, status: r.status, reclaimHash: r.reclaimHash, reclaimUrl: r.reclaimHash ? expert(r.reclaimHash) : undefined }));
  log(`popup: final statuses ${finalList.slice(0, 3).map((r) => r.status).join(", ")}`);

  await p.getByRole("button", { name: "Back" }).click().catch(() => undefined);
  await p.getByRole("button", { name: "Settings", exact: true }).click();
  await shot("settings");
  evidence.balanceAfter = (await ext.ask({ type: "balance" })).usd;
  log(`evidence written to ${await writeEvidence("-ui")}`);
  await ext.ctx.close();

  await compose(browser);
  await browser.close();
}

/* --------------------------- 1280x800 composites of the real screens --------------------------- */
const PAPER = "#F5F3EF";
const INK = "#1E1B22";
const MUTED = "#67626E";
const LINE = "#E5DFE8";

/** A capture as a data URL: a page made with setContent may not load file:// images. */
async function dataUrl(file) {
  return `data:image/png;base64,${(await readFile(file)).toString("base64")}`;
}

async function popupFrame(file) {
  return `<img src="${await dataUrl(file)}" style="width:432px;height:720px;border:1px solid ${LINE};border-radius:20px;box-shadow:0 18px 48px rgba(30,27,34,0.16);display:block">`;
}

function page(caption, sub, right) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:1280px;height:800px;background:${PAPER};overflow:hidden}
    .wrap{display:flex;align-items:center;justify-content:space-between;height:800px;padding:0 96px;box-sizing:border-box}
    .text{max-width:520px}
    h1{font-family:Georgia,"Times New Roman",serif;font-weight:500;font-size:56px;line-height:1.08;color:${INK};margin:0 0 20px;letter-spacing:-0.01em}
    p{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:26px;line-height:1.35;color:${MUTED};margin:0}
  </style></head><body><div class="wrap"><div class="text"><h1>${caption}</h1><p>${sub}</p></div>${right}</div></body></html>`;
}

async function compose(browser) {
  const raw = (n) => path.join(RAW, `raw-${n}.png`);
  const shots = [
    ["01-hello.png", "Money home, in a link", "They tap it, and the money is theirs. No app, no wallet, and they pay no gas.", await popupFrame(raw("hello"))],
    ["02-send.png", "Make a payment link", "Enter an amount. The recipient pays no gas.", await popupFrame(raw("send"))],
    ["03-link-ready.png", "Copy it, or paste it where you type", "If nobody claims it, you can take it back after 7 days.", await popupFrame(raw("link-ready"))],
    [
      "04-paste.png",
      "Paste it into a text box",
      "Right-click a text box and choose Paste a Lumenia link here. It only types the link; you press Send.",
      `<div style="display:flex;flex-direction:column;gap:20px;align-items:flex-end">
         <img src="${await dataUrl(raw("chatbox"))}" style="width:480px;border:1px solid ${LINE};border-radius:14px;background:#fff;display:block">
         <img src="${await dataUrl(raw("ready-pasted"))}" style="width:288px;height:480px;border:1px solid ${LINE};border-radius:20px;box-shadow:0 18px 48px rgba(30,27,34,0.16);display:block">
       </div>`,
    ],
    ["05-links.png", "See what happened to every link you made here", "Waiting, Claimed, Reclaimable, Reclaimed.", await popupFrame(raw("links"))],
  ];
  // The earlier set had other names; only the five above belong in the store folder.
  for (const old of ["01-send.png", "02-link-ready.png", "03-links.png", "05-before-you-start.png"]) await rm(path.join(OUT, old), { force: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const pg = await ctx.newPage();
  for (const [file, caption, sub, right] of shots) {
    await pg.setContent(page(caption, sub, right), { waitUntil: "load" });
    await pg.screenshot({ path: path.join(OUT, file) });
    log(`store screenshot ${file}`);
  }
  await ctx.close();
}

if (process.argv.includes("--compose-only")) {
  // Re-make the 1280x800 composites from the raw captures of the last run, without a new run.
  const browser = await chromium.launch({ headless: true });
  await mkdir(OUT, { recursive: true });
  await compose(browser);
  await browser.close();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("UI E2E FAILED:", e?.stack ?? e);
  evidence.error = String(e?.message ?? e);
  try {
    await writeEvidence("-ui-failed");
  } catch {
    /* best effort */
  }
  process.exit(1);
});
