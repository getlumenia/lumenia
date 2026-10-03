#!/usr/bin/env node
/**
 * The extension, end to end, on TESTNET, against the live website and the live testnet sponsor.
 *
 *   1. a throwaway practice account is made the way a visitor makes one (a demo link claimed on
 *      getlumenia.com) and backed up there with an email and a password, through the real
 *      one-time-code mail (a disposable inbox at mail.tm reads it);
 *   2. the extension, loaded unpacked, restores that account from the backup (a second real code);
 *   3. it sends $0.10 by link, which is opened in a separate browser with no extension and
 *      claimed on getlumenia.com with no change to the claim route;
 *   3b. before that send, "Paste a Lumenia link here" is chosen on a text box of a local page (the
 *      click is simulated: an automated browser cannot open the native menu), and the worker types
 *      the link into it once the deposit is confirmed; the link CLAIMED is the one read back from
 *      that box. The paste is also tried on the Lexical editor's public playground (the editor
 *      WhatsApp Web is built on) with a harmless sample text;
 *   4. the extension's list then shows the link as Claimed;
 *   5. a second link, made by the end-to-end build that expires links after 180 s, is taken back
 *      from the list once its expiry passes.
 * Every hash is written to dist/e2e-evidence-<time>.json.
 *
 * Network-dependent and slow (about six minutes, most of it waiting for the expiry): a local and
 * post-release check, never a CI gate. Practice money only; nothing here can reach mainnet.
 *
 *   node build.mjs --e2e-ttl=180 && node e2e/testnet.e2e.mjs            (from apps/extension)
 *   node e2e/ui.e2e.mjs                   the same through the popup's own screens (and the store shots)
 *   HEADLESS=0 node e2e/testnet.e2e.mjs   watch it
 */
import { writeFile } from "node:fs/promises";
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

const MODE = "messages";
evidence.mode = MODE;

async function main() {
  // The website runs in Playwright's default browser, as the website's own nightly e2e does; only the
  // extension needs the full Chromium build (extensions do not load in the headless shell).
  const browser = await chromium.launch({ headless: HEADLESS });
  const mail = await inbox();
  evidence.inbox = mail.address;
  log(`inbox ${mail.address}`);

  const short = await makeBackedUpAccount(browser, mail);
  evidence.webAccountShort = short;

  const ext = await extensionContext();
  log(`extension loaded (${ext.id}), mode ${MODE}`);

  await ext.ask({ type: "consent.agree" });
  await mail.skipExisting();
  await ext.ask({ type: "restore.requestCode", email: mail.address });
  const code = await mail.nextCode();
  log("extension: restore code arrived by mail");
  await ext.ask({ type: "restore.submitCode", code });
  const { pubkey } = await ext.ask({ type: "restore.submitPassword", password: PASSWORD });
  evidence.account = pubkey;
  const sameAccount = short.startsWith(pubkey.slice(0, 6)) && short.endsWith(pubkey.slice(-6));
  log(`extension: restored ${pubkey} (web showed ${short}; same account: ${sameAccount})`);
  if (!sameAccount) throw new Error("the restored account is not the one backed up on the web");

  const bal = await ext.ask({ type: "balance" });
  log(`extension: balance $${bal.usd}`);
  evidence.balanceBefore = bal.usd;

  // Link 1: the person right-clicked the chat box of a page and chose "Paste a Lumenia link here".
  const { server, url: pageUrl } = await serveTestPage();
  const chatPage = await ext.ctx.newPage();
  await chatPage.goto(pageUrl);
  await chatPage.focus("#chat");
  await simulateMenuClick(ext, pageUrl);
  const pending = (await ext.ask({ type: "state" })).pendingInsert;
  log(`extension: paste target set on ${pending?.host}`);
  evidence.pasteTarget = pending?.host ?? null;

  // Link 1: sent, pasted into that box by the worker, then claimed on the web by a browser with no
  // extension, using the text read back FROM THE BOX.
  const sendStarted = Date.now();
  const sent = await ext.ask({ type: "send", amount: SEND_USD, from: "Extension test" });
  const inBox = ((await chatPage.locator("#chat").textContent()) ?? "").trim();
  const pastedMs = Date.now() - sendStarted;
  log(`extension: inserted=${sent.inserted}; the chat box holds ${inBox === sent.link ? "exactly the link" : JSON.stringify(inBox.slice(0, 40))} ${pastedMs} ms after Send`);
  evidence.paste = { inserted: sent.inserted === true, boxHoldsExactlyTheLink: inBox === sent.link, msFromSendToPasted: pastedMs };
  if (inBox !== sent.link) throw new Error("the chat box does not hold exactly the link");
  const link = inBox;
  const u = new URL(link);
  log(`extension: link ready, deposit ${sent.record.hash}`);
  const contract = {
    srcExtLast: [...u.searchParams.keys()].pop() === "src" && u.searchParams.get("src") === "ext",
    noMainnetMarker: !u.searchParams.has("n"),
    secretOnlyInFragment: u.hash.length > 1 && !u.pathname.includes(u.hash.slice(1)) && !u.search.includes(u.hash.slice(1)),
    path: u.pathname === `/v2/c/${sent.linkHex}`,
  };
  log("link contract:", JSON.stringify(contract));
  evidence.link1 = { linkHex: sent.linkHex, depositHash: sent.record.hash, depositUrl: expert(sent.record.hash), query: u.search, contract };

  const claimHash = await claimOnWeb(browser, link);
  log(`web: claimed with no extension, claim ${claimHash}`);
  evidence.link1.claimHash = claimHash;
  evidence.link1.claimUrl = expert(claimHash);

  let status = "";
  for (let i = 0; i < 10 && status !== "claimed"; i++) {
    const list = await ext.ask({ type: "links.refresh", linkHex: sent.linkHex });
    status = list.find((r) => r.linkHex === sent.linkHex)?.status ?? "";
    if (status !== "claimed") await sleep(6_000);
  }
  log(`extension: link 1 now reads ${status}`);
  evidence.link1.statusAfterClaim = status;

  // The same paste on the other kinds of box, and on Lexical (the editor WhatsApp Web is built on),
  // with a harmless sample text rather than a real link.
  const SAMPLE = "https://getlumenia.com/v2/c/sample-not-a-real-link#sample";
  const boxes = {};
  for (const sel of ["#area", "#line"]) {
    await chatPage.bringToFront();
    await chatPage.focus(sel);
    const r = await ext.sw.evaluate((t) => globalThis.__lumeniaE2E.insertLink(t), SAMPLE);
    boxes[sel] = { ...r, holds: (await chatPage.inputValue(sel)) === SAMPLE };
  }
  try {
    const lex = await ext.ctx.newPage();
    await lex.goto("https://playground.lexical.dev/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    const editor = lex.locator('[contenteditable="true"]').first();
    await editor.waitFor({ timeout: 60_000 });
    await editor.click();
    await lex.keyboard.press("ControlOrMeta+a");
    await lex.keyboard.press("Delete");
    await lex.bringToFront();
    const r = await ext.sw.evaluate((t) => globalThis.__lumeniaE2E.insertLink(t), SAMPLE);
    await lex.waitForTimeout(500);
    const text = (await editor.textContent()) ?? "";
    boxes.lexical = { ...r, holds: text.includes(SAMPLE), copies: text.split(SAMPLE).length - 1 };
    await lex.close();
  } catch (e) {
    boxes.lexical = { error: String(e?.message ?? e) };
  }
  log("paste on other boxes:", JSON.stringify(boxes));
  evidence.paste.otherBoxes = boxes;
  server.close();

  // Link 2: made by the 180 s build, taken back from the list after its expiry.
  const second = await ext.ask({ type: "send", amount: SEND_USD, from: "Extension test" });
  evidence.link2 = { linkHex: second.linkHex, depositHash: second.record.hash, depositUrl: expert(second.record.hash), expiry: second.record.expiry };
  const waitMs = second.record.expiry * 1000 - Date.now() + 15_000;
  log(`extension: link 2 deposited (${second.record.hash}); waiting ${Math.ceil(waitMs / 1000)} s for its expiry`);
  await sleep(Math.max(0, waitMs));
  await ext.page.reload(); // a fresh popup page, as a person reopening it would have
  const reclaimed = await ext.ask({ type: "links.reclaim", linkHex: second.linkHex });
  log(`extension: link 2 taken back, ${reclaimed.status}, tx ${reclaimed.reclaimHash}`);
  evidence.link2.status = reclaimed.status;
  evidence.link2.reclaimHash = reclaimed.reclaimHash;
  evidence.link2.reclaimUrl = expert(reclaimed.reclaimHash);

  const balAfter = await ext.ask({ type: "balance" });
  evidence.balanceAfter = balAfter.usd;
  log(`evidence written to ${await writeEvidence()}`);
  console.log(JSON.stringify(evidence, null, 2));
  await ext.ctx.close();
  await browser.close();
}

main().catch(async (e) => {
  console.error("E2E FAILED:", e?.stack ?? e);
  evidence.error = String(e?.message ?? e);
  try {
    await writeFile(path.join(ROOT, "dist", `e2e-evidence-failed-${Date.now()}.json`), JSON.stringify(evidence, null, 2));
  } catch {
    /* best effort */
  }
  process.exit(1);
});
