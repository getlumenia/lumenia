import { test, expect, type BrowserContext } from "@playwright/test";
import { expectMoneyLanded } from "./landed";
import { mintClaimLink } from "./mintLink";

/**
 * Recovery live-flow regression (Stage 3) — the funds-permanence promise end to end in a real
 * browser: claim → back up with a password → RESTORE ON A FRESH DEVICE (a second browser context)
 * → the SAME account + money come back.
 *
 * The blob store + OTP are STUBBED (the OTP email can't be read headless; the sponsor recovery
 * store is separately unit-tested — test-recovery-store.ts, 35/35). ONLY the three /recovery* endpoints
 * are stubbed; /create-account + /feebump still hit the real Worker, so the account is a genuine
 * testnet account that really holds $20 — this proves the CLIENT crypto + the secure/restore UI
 * drive it correctly across devices.
 */
const SPONSOR = process.env.SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
const WEB = (process.env.WEB_URL ?? "https://getlumenia.com").replace(/\/$/, "");
const CODE = "123456"; // the stub accepts any 6 digits (OTP is faked)

// Shared across the two contexts — context A stores the box; context B fetches it (the "server").
let storedBox: unknown = null;

/** Stub ONLY the recovery endpoints on `sponsorOrigin`; let everything else hit the real Worker. */
async function stubRecovery(context: BrowserContext, sponsorOrigin: string): Promise<void> {
  await context.route(
    (url) => url.href.startsWith(sponsorOrigin) && /\/recovery(-otp|-fetch)?$/.test(url.pathname),
    async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith("/recovery-otp")) {
        return route.fulfill({ status: 200, body: "{}", contentType: "application/json" });
      }
      if (p.endsWith("/recovery-fetch")) {
        return route.fulfill({
          status: storedBox ? 200 : 404,
          body: storedBox ? JSON.stringify({ box: storedBox }) : JSON.stringify({ error: "not found" }),
          contentType: "application/json",
        });
      }
      // POST /recovery — store: capture the ciphertext box the client wrapped.
      const body = JSON.parse(route.request().postData() ?? "{}") as { box?: unknown };
      storedBox = body.box ?? null;
      return route.fulfill({ status: 200, body: "{}", contentType: "application/json" });
    },
  );
}

/** The short address the /account page prints (G6chars…6chars) — our "same account" fingerprint. */
async function readAccountShort(page: import("@playwright/test").Page): Promise<string> {
  await page.goto(`${WEB}/account`, { waitUntil: "domcontentloaded" });
  const mono = page.locator("p.font-mono").first();
  await expect(mono).toBeVisible({ timeout: 20_000 });
  return ((await mono.textContent()) ?? "").trim();
}

/* This one does the most work of any test here — mint, claim, back up with a password, then
   restore the whole account on a SECOND browser context — and each half waits on real ledger
   time. The suite-wide 150s budget was not enough, and the symptom was a misleading "target page
   closed" from whichever step happened to be in flight when the clock ran out. */
test.setTimeout(300_000);

test("recovery: back up with a password → restore on a fresh device → same account + money", async ({ browser }) => {
  storedBox = null;
  const password = "recover-me-please-9";
  const email = `e2e-recover-${Date.now()}@example.com`;

  // ---- Context A: a real device that claims money + backs it up ----
  const ctxA = await browser.newContext();
  await stubRecovery(ctxA, SPONSOR);
  const a = await ctxA.newPage();
  a.on("pageerror", (e) => console.log("[A pageerror]", e.message));

  const link = await mintClaimLink({ sponsor: SPONSOR, web: WEB, amount: "20", from: "Backup" });
  await a.goto(link.url, { waitUntil: "domcontentloaded" });
  await a.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });
  await a.getByRole("button", { name: /claim my money/i }).click();
  await expectMoneyLanded(a);

  const shortA = await readAccountShort(a);
  expect(shortA).toMatch(/^G.{5}….{6}$/);

  // Back up: email → code → password. (The "Send me a code" step, then the code+password step.)
  /* The "Back up your money" line is a HEADING, not a button — /account was restructured and this
     step kept reaching for a role that no longer exists there. `.catch()` never rescued it either:
     scrollIntoViewIfNeeded with no timeout waits for the whole TEST budget, so the run died five
     minutes later at the next line with a misleading "target page closed". Playwright scrolls an
     element into view before filling it anyway, so the safe fix is to stop asking. */
  const emailA = a.getByLabel("Your email");
  await emailA.fill(email);
  await a.getByRole("button", { name: /send me a code/i }).click();
  await a.getByLabel("6-digit code").fill(CODE);
  await a.getByLabel("Choose a password").fill(password);
  /* A recovery password can never be reset, so the form takes it twice and keeps the submit
     disabled until the second field matches the first. Filling only "Choose a password" leaves a
     button that never becomes actionable, and the click below then waits out the whole test
     budget before reporting itself as something else entirely. */
  await a.getByLabel("Type the password again").fill(password);
  const backUp = a.getByRole("button", { name: /back up my money/i });
  // Name the real cause in seconds if this form ever grows another required field.
  await expect(backUp).toBeEnabled({ timeout: 10_000 });
  await backUp.click();
  await expect(a.getByText(/backed up/i)).toBeVisible({ timeout: 30_000 });
  expect(storedBox, "the sealed box reached the (stubbed) server").toBeTruthy();
  await ctxA.close();

  // ---- Context B: a FRESH device (no keystore) that restores ----
  const ctxB = await browser.newContext();
  await stubRecovery(ctxB, SPONSOR);
  const b = await ctxB.newPage();
  b.on("pageerror", (e) => console.log("[B pageerror]", e.message));
  await b.goto(`${WEB}/account`, { waitUntil: "domcontentloaded" });
  await expect(b.getByText(/no account yet/i)).toBeVisible({ timeout: 20_000 });

  // Restore via the "Already have money on another phone?" surface.
  await b.getByLabel("Your email").fill(email);
  await b.getByRole("button", { name: /send me a code/i }).click();
  await b.getByLabel("6-digit code").fill(CODE);
  await b.getByLabel("Your password").fill(password);
  await b.getByRole("button", { name: /restore my money/i }).click();
  /* Assert the OUTCOME, not the announcement. "Welcome back. Your money is here." is real, but it
     lives on the no-account surface — the moment the restore lands, /account re-renders as the
     restored account and that component unmounts. The test was polling for a sentence the app had
     already replaced, on a restore that had in fact succeeded (the failure snapshot showed the
     money and the locked account sitting right there). What actually matters is the next two
     lines: the SAME account, with the SAME money, on a device that never had either. */
  await expect(b.getByText(/you have \$20\.00/i)).toBeVisible({ timeout: 30_000 });

  const shortB = await readAccountShort(b);
  expect(shortB, "the restored device shows the SAME account").toBe(shortA);
  // and the money followed the account across devices
  await b.goto(`${WEB}/home`, { waitUntil: "domcontentloaded" });
  // Exact + first: the balance and the activity row ("+$20.00") both contain this string, so an
  // unqualified match is a strict-mode violation rather than anything being wrong with the money.
  await expect(b.getByText("$20.00", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  console.log(`\n✅ recovery loop: backed up + restored ${shortA} on a fresh device with $20\n`);
  await ctxB.close();
});
