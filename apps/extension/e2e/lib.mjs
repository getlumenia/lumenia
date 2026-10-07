/**
 * Shared steps of the extension's end-to-end runs on TESTNET (e2e/testnet.e2e.mjs drives the worker
 * through its messages, e2e/ui.e2e.mjs drives the popup's screens). Practice money only; nothing here
 * can reach mainnet. See e2e/testnet.e2e.mjs for what a run proves and how to start one.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));
export const { chromium } = require("@playwright/test");

export const WEB = (process.env.WEB_URL ?? "https://getlumenia.com").replace(/\/$/, "");
export const SPONSOR = (process.env.SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev").replace(/\/$/, "");
export const EXT = path.join(ROOT, "dist", "e2e-chrome");
export const HEADLESS = process.env.HEADLESS !== "0";
export const PASSWORD = `practice-${Math.random().toString(36).slice(2, 10)}-Lx9`;
export const SEND_USD = "0.10";

export const t0 = Date.now();
export const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** What a run proves, written to dist/e2e-evidence-<time>.json by the script that imports this. */
export const evidence = { startedAt: new Date(t0).toISOString(), network: "testnet", web: WEB, sponsor: SPONSOR };

/* ------------------------------ a disposable inbox (mail.tm) ------------------------------ */
export async function inbox() {
  const api = "https://api.mail.tm";
  const domains = await (await fetch(`${api}/domains`)).json();
  const domain = (domains["hydra:member"] ?? domains)[0].domain;
  // The service refuses usernames containing words on its blocklist ("test", and any word random
  // letters happen to spell), so the name is digits between two fixed letters. It also rate-limits:
  // 429 is waited out, a few times.
  const address = `qa${Date.now()}${Math.floor(Math.random() * 1e4)}x@${domain}`;
  const secret = `${Math.random().toString(36).slice(2)}A9!`;
  const post = async (url, body) => {
    for (let i = 0; i < 6; i++) {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.status !== 429) return r;
      await sleep(10_000);
    }
    throw new Error(`mail.tm kept answering 429 for ${url}`);
  };
  const created = await post(`${api}/accounts`, { address, password: secret });
  if (!created.ok) throw new Error(`mail.tm account: ${created.status} ${(await created.text()).slice(0, 200)}`);
  const { token } = await (await post(`${api}/token`, { address, password: secret })).json();
  const seen = new Set();
  return {
    address,
    /** The next Lumenia code that arrives after this call. */
    async nextCode(timeoutMs = 180_000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const list = await (await fetch(`${api}/messages`, { headers: { authorization: `Bearer ${token}` } })).json();
        for (const m of list["hydra:member"] ?? []) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          const code = /Your Lumenia code:\s*(\d{6})/.exec(m.subject ?? "")?.[1];
          if (code) return code;
        }
        await sleep(3_000);
      }
      throw new Error("no code arrived in the inbox");
    },
    /** Mark every message already there as seen, so the next code is a NEW one. */
    async skipExisting() {
      const list = await (await fetch(`${api}/messages`, { headers: { authorization: `Bearer ${token}` } })).json();
      for (const m of list["hydra:member"] ?? []) seen.add(m.id);
    },
  };
}

/* ------------------------------ 1. a practice account on the web ------------------------------ */
export async function makeBackedUpAccount(browser, mail) {
  const res = await fetch(`${SPONSOR}/demo-link`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const demo = await res.json();
  if (!res.ok || !demo.balanceId || !demo.bearerSecret) throw new Error(`/demo-link: ${res.status} ${JSON.stringify(demo).slice(0, 200)}`);
  // The private v1 shape (apps/web/lib/link-fragment.ts): the balance id in the query, the key and
  // then the sender's name after the '#', no amount anywhere (the claim page reads it from Horizon).
  const q = new URLSearchParams({ b: demo.balanceId });
  const url = `${WEB}/c/${demo.balanceId.slice(-8)}?${q}#${demo.bearerSecret}&s=${encodeURIComponent(demo.from ?? "Lumenia")}`;
  evidence.practiceDollars = demo.amount;

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("[web pageerror]", e.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.location.hash === "", null, { timeout: 30_000 });
  await page.getByRole("button", { name: /claim my money|^take \$/i }).click();
  await page.getByText(/^\s*it['’]s (in your account|yours)\b/i).waitFor({ timeout: 120_000 });
  log(`web: claimed the $${demo.amount} practice link into a new account`);

  await page.goto(`${WEB}/account`, { waitUntil: "domcontentloaded" });
  const short = ((await page.locator("p.font-mono").first().textContent({ timeout: 30_000 })) ?? "").trim();
  await mail.skipExisting();
  await page.getByLabel("Your email").fill(mail.address);
  await page.getByRole("button", { name: /send me a code/i }).click();
  const code = await mail.nextCode();
  log("web: backup code arrived by mail");
  await page.getByLabel("6-digit code").fill(code);
  await page.getByLabel("Choose a password").fill(PASSWORD);
  await page.getByLabel("Type the password again").fill(PASSWORD);
  await page.getByRole("button", { name: /back up my money/i }).click();
  await page.getByText(/backed up/i).first().waitFor({ timeout: 60_000 });
  log(`web: account ${short} backed up with ${mail.address}`);
  await ctx.close();
  return short;
}

/* ------------------------------ a local page with text boxes ------------------------------ */
export const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Paste target</title></head>
<body style="font:15px system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;color:#1e1b22">
<p>A chat box, as most web chats build it (one line, so a capture never shows a whole link):</p>
<div id="chat" contenteditable="true" role="textbox" aria-label="Message"
  style="border:1px solid #d6d1db;border-radius:22px;padding:11px 16px;background:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:560px"></div>
<p>A plain textarea:</p><textarea id="area" rows="3" cols="60"></textarea>
<p>A text input:</p><input id="line" type="text" size="60">
</body></html>`;

export function serveTestPage() {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(TEST_PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

/* ------------------------------ 2-5. the extension ------------------------------ */
export async function extensionContext(launch = {}) {
  const userDir = path.join(ROOT, "dist", `e2e-profile-${Date.now()}`);
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: "chromium",
    headless: HEADLESS,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    ...launch,
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 30_000 });
  const id = new URL(sw.url()).host;
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("[popup pageerror]", e.message));
  await page.goto(`chrome-extension://${id}/popup.html`);
  const ask = async (msg) => {
    const r = await page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    if (!r?.ok) throw new Error(`${msg.type}: ${r?.code} ${r?.message}`);
    return r.data;
  };
  return { ctx, page, ask, id, sw };
}

/** Chrome's own context-menu click, as the worker receives it, on `tabUrl`'s tab. */
export async function simulateMenuClick(ext, tabUrlPrefix) {
  return ext.sw.evaluate(async (prefix) => {
    const [tab] = await chrome.tabs.query({ url: `${prefix}*` });
    await globalThis.__lumeniaE2E.onMenuClicked({ menuItemId: "lumenia-paste-link", frameId: 0, editable: true, pageUrl: tab.url }, tab);
    return tab.id;
  }, tabUrlPrefix);
}

export async function claimOnWeb(browser, link) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("[claim pageerror]", e.message));
  await page.goto(link, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.location.hash === "", null, { timeout: 30_000 });
  // A one-to-one link names its amount on the button ("Take $0.10"); the website's own claim test
  // matches both forms the same way.
  await page.getByRole("button", { name: /claim my money|^take \$/i }).click();
  await page.getByText(/^\s*it['’]s (in your account|yours)\b/i).waitFor({ timeout: 120_000 });
  const hash = await page.locator("[data-tx-hash]").first().getAttribute("data-tx-hash", { timeout: 30_000 });
  await ctx.close();
  return hash;
}

export const expert = (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

/** Write the evidence file; returns its path relative to apps/extension. */
export async function writeEvidence(tag = "") {
  evidence.finishedAt = new Date().toISOString();
  const out = path.join(ROOT, "dist", `e2e-evidence${tag}-${new Date(t0).toISOString().replace(/[:.]/g, "-")}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`);
  return path.relative(ROOT, out);
}
