/**
 * The Lumenia demo film — recorded, not animated.
 *
 * Every frame is a real browser on the real deployment, driving the real sponsor and putting real
 * transactions on the ledger. Nothing here is a mock or a storyboard: the money that gets claimed
 * in scene 2 is the money that gets sent in scene 4 and locked behind a password in scene 5.
 *
 * It is silent by design. A demo that needs narration to make sense is a demo whose screens don't,
 * so each scene has to answer its question on its own: where is my key, what if the link reaches
 * the wrong person, how do I get back to my account, how does money move to and from an exchange.
 *
 * Each scene records into its own browser context, which is also how the film gets its cuts — the
 * "other person" in scene 5 and the "new phone" in scene 6 are genuinely separate browsers with
 * separate storage, not the same one pretending.
 *
 * RUN:  node e2e/demo/record.mjs            (records against https://getlumenia.com)
 *       node e2e/demo/build.mjs             (concatenates + encodes to MP4)
 *       WEB_URL=http://localhost:3111 node e2e/demo/record.mjs   (a local production build)
 */
import { chromium } from "@playwright/test";
import { mkdir, rm, readdir, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CURSOR_SCRIPT, moveTo, click, type, scrollBy, scrollTo, beat, sleep } from "./cursor.mjs";

const WEB = (process.env.WEB_URL ?? "https://getlumenia.com").replace(/\/$/, "");
const OUT = path.resolve("e2e/demo/.raw");
const VIEWPORT = { width: 1440, height: 900 };

const scenes = [];
const PROFILES = path.join(os.tmpdir(), "lumenia-demo-profiles");

/**
 * Record one scene in a PERSISTENT profile.
 *
 * The account lives in IndexedDB, and IndexedDB is not part of Playwright's storageState — so a
 * plain new context would forget the money between scenes. A persistent user-data-dir keeps it,
 * which is also what makes the film honest: scenes 3 to 8 really are the same person on the same
 * browser, and the profile named "other" in scene 5 really is somebody else's.
 */
async function scene(name, profile, fn) {
  const dir = path.join(OUT, name);
  await mkdir(dir, { recursive: true });
  const context = await chromium.launchPersistentContext(path.join(PROFILES, profile), {
    viewport: VIEWPORT,
    recordVideo: { dir, size: VIEWPORT },
    deviceScaleFactor: 1,
    args: ["--force-prefers-reduced-motion=false"],
  });
  await context.addInitScript(CURSOR_SCRIPT);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.setViewportSize(VIEWPORT);
  const started = Date.now();
  try {
    await fn(page, context);
  } catch (e) {
    console.error(`  x ${name}: ${e.message}`);
    await context.close().catch(() => {});
    throw e;
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  await context.close(); // flushes the video
  // Playwright names videos by an internal id; give each scene a sortable filename.
  const files = (await readdir(dir)).filter((f) => f.endsWith(".webm"));
  if (files[0]) await rename(path.join(dir, files[0]), path.join(OUT, `${name}.webm`));
  scenes.push({ name, secs });
  console.log(`  + ${name}  ${secs}s`);
}

/** Land on a page with the pointer already in frame, so nothing pops in. */
async function open(page, route, { wait = 900 } = {}) {
  await page.goto(`${WEB}${route}`, { waitUntil: "domcontentloaded" });
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height * 0.62);
  await sleep(wait);
}

/* ------------------------------------------------------------------------- */

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await rm(PROFILES, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  console.log(`Recording against ${WEB}\n`);

  /* 1 — What is this. The hero, then the one line that says what makes it different. */
  await scene("01-landing", "visitor", async (page) => {
    await open(page, "/", { wait: 2200 });
    await scrollBy(page, 900, 1400);
    await beat(600);
    await scrollBy(page, 1400, 1600);
    await beat(500);
    // The differentiation beat: everyone else makes the RECEIVER do the work.
    await scrollTo(page, ".diff", 1400);
    await beat(1550);
    await scrollBy(page, 500, 1000);
    await beat(700);
  });

  /* 2 — Receiving. A real link is minted and claimed in the browser: no wallet, no signup. */
  let claimUrl = null;
  await scene("02-claim", "user", async (page) => {
    await open(page, "/try", { wait: 1200 });
    await scrollBy(page, 260, 800);
    await click(page, page.getByRole("button", { name: /send myself a link/i }), { after: 1200 });
    // The frozen claim route: the money is shown BEFORE anything is asked of you.
    await page.waitForURL(/\/c\//, { timeout: 45000 });
    claimUrl = page.url();
    await sleep(1800);
    await click(page, page.getByRole("button", { name: /claim my money/i }), { after: 1000 });
    // Wait for the DONE state specifically. "your money" alone also matches the in-flight line
    // "Moving your money to you…", which would cut the scene mid-claim and, worse, move on before
    // the account exists — every later scene depends on this one actually finishing.
    await page.getByText(/in your account/i).first().waitFor({ timeout: 90000 });
    await beat(2100);
  });

  /* 3 — It arrived, and it is yours. The balance, read from the public record. */
  await scene("03-home", "user", async (page) => {
    await open(page, "/home", { wait: 1800 });
    await scrollBy(page, 380, 1100);
    await beat(1250);
  });

  /* 4 — Sending, with the optional lock. This is the answer to "what if it reaches the wrong
   *     person": you can put a password on the link itself. */
  let sendLink = null;
  await scene("04-send", "user", async (page) => {
    await open(page, "/send", { wait: 1400 });
    // A just-claimed account can still read as empty for a beat while Horizon catches up, and the
    // product's own answer to an empty balance is the faucet. Taking that path on camera is more
    // honest than waiting off-screen for a number to appear.
    const empty = page.getByRole("button", { name: /get test money/i });
    if (await empty.isVisible().catch(() => false)) {
      await click(page, empty, { after: 2500 });
      await page.locator('input[inputmode="decimal"]').waitFor({ timeout: 60000 });
      await beat(900);
    }
    await type(page, page.locator('input[inputmode="decimal"]'), "3.00");
    await beat(400);
    await type(page, page.getByPlaceholder(/e\.g\. Alex/i), "Meric");
    await beat(500);
    // The lock, off by default: the fast path stays fast.
    await click(page, page.locator('input[type="checkbox"]').first(), { after: 700 });
    await type(page, page.getByLabel(/claim password/i), "izmir-kahve");
    await beat(1400);
    await click(page, page.getByRole("button", { name: /create a money link/i }), { after: 1500 });
    await page.getByTestId("money-link").waitFor({ timeout: 90000 });
    sendLink = (await page.getByTestId("money-link").textContent())?.trim() ?? null;
    await beat(1550);
  });

  /* 5 — The other person. A genuinely separate browser opens the link: the money is visible, but
   *     a wrong password is refused on the spot, without anything being sent anywhere. */
  if (sendLink) {
    await scene("05-locked-claim", "other", async (page) => {
      await page.goto(sendLink, { waitUntil: "domcontentloaded" });
      await page.mouse.move(720, 560);
      await sleep(1700);
      await type(page, page.getByLabel(/^password$/i), "wrong-guess");
      await beat(300);
      await click(page, page.getByRole("button", { name: /claim my money/i }), { after: 1400 });
      await page.getByText(/doesn'?t match/i).waitFor({ timeout: 20000 }).catch(() => {});
      await beat(1400);
      await page.getByLabel(/^password$/i).fill("");
      await type(page, page.getByLabel(/^password$/i), "izmir-kahve");
      await beat(400);
      await click(page, page.getByRole("button", { name: /claim my money/i }), { after: 1200 });
      await page.getByText(/it'?s yours/i).waitFor({ timeout: 90000 }).catch(() => {});
      await beat(1700);
    });
  }

  /* 6 — Where the key lives, and how you get back to it. */
  await scene("06-account", "user", async (page) => {
    await open(page, "/account", { wait: 1600 });
    await scrollBy(page, 420, 1100);
    await beat(700);
    // The address, and the code somebody scans to pay you in person.
    await click(page, page.getByRole("button", { name: /show code/i }), { after: 1300 });
    await beat(1400);
    await scrollBy(page, 700, 1200);
    await beat(1200);
    // "Your password is the key" — the honest custody line.
    await scrollTo(page, "text=Your password is the key", 1100).catch(() => {});
    await beat(1850);
  });

  /* 7 — Getting money IN. The screen that corrects the memo misconception. */
  await scene("07-add-money", "user", async (page) => {
    await open(page, "/add-money", { wait: 1600 });
    await beat(1850); // the correction: your money has its own account
    await scrollBy(page, 520, 1200);
    await beat(1550); // the network, and the reciprocal truth
    await scrollBy(page, 620, 1200);
    await beat(1250);
  });

  /* 8 — Getting money OUT, and the two mistakes that lose it. */
  await scene("08-send-out", "user", async (page) => {
    await open(page, "/send-out", { wait: 1500 });
    await beat(1200);
    // An address copied from the wrong network: the screen names what they actually pasted.
    await type(page, page.locator("textarea"), "0x8f2A55949038A9610F50FB23b5883Af3B4c8b2D9", {
      perChar: 26,
    });
    await beat(1700);
    await page.locator("textarea").fill("");
    // A Stellar address with no reference tag: refused, with the reason.
    await type(page, page.locator("textarea"), "GDO7HI2WKTMDLDG54XKAVE6BTJ5BYXE7PAYQNM5535J2SJNXR334ECYC", {
      perChar: 9,
    });
    await beat(700);
    await type(page, page.locator('input[inputmode="decimal"]'), "5.00");
    await beat(400);
    await click(page, page.getByRole("button", { name: /review the transfer/i }), { after: 1400 });
    await beat(1850);
    await scrollBy(page, 400, 900);
    await beat(1200);
  });

  /* 9 — What happens after, and the honest answers. */
  await scene("09-cash-out", "visitor", async (page) => {
    await open(page, "/cash-out", { wait: 1400 });
    await scrollBy(page, 900, 1500);
    await beat(900);
    await scrollBy(page, 1100, 1600);
    await beat(1400);
    await scrollBy(page, 1200, 1600);
    await beat(1200);
  });

  await scene("10-trust", "visitor", async (page) => {
    await open(page, "/", { wait: 600 });
    await scrollTo(page, ".faq", 1600);
    await beat(700);
    await click(page, page.getByRole("button", { name: /can I cancel it/i }).first(), { after: 900 });
    await beat(2100);
    await click(page, page.getByRole("button", { name: /what happens if Lumenia disappears/i }).first(), {
      after: 900,
    });
    await beat(1550);
    await scrollBy(page, 900, 1400);
    await beat(1250);
  });

  const total = scenes.reduce((a, s) => a + Number(s.secs), 0);
  console.log(`\nRecorded ${scenes.length} scenes, ${total.toFixed(1)}s of footage.`);
  console.log("Next: node e2e/demo/build.mjs");
}

main().catch((e) => {
  console.error("\nRecording failed:", e.message);
  process.exit(1);
});
