import { test, expect } from "@playwright/test";
import { mintClaimLink } from "./mintLink";
import { rewriteSponsor } from "./sponsorRewrite";

/**
 * The live-claim regression (Guardrail 2). Mints a fresh real claim link and
 * claims it end-to-end in a real browser against the deployed sponsor + web.
 * A green run here is the automated proof the grant-evidence flow still works
 * after a deploy. Assertions are intentionally tolerant of copy tweaks (regex),
 * strict on the mechanics (value-first paint + on-chain tx hash).
 */
const SPONSOR = process.env.SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
const WEB = process.env.WEB_URL ?? "https://getlumenia.com";

test("fresh makelink → claim in a real browser → USDC lands (tx hash)", async ({ page }) => {
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("requestfailed", (r) =>
    console.log("[requestfailed]", r.method(), r.url(), r.failure()?.errorText),
  );
  await rewriteSponsor(page.context()); // no-op against the live sponsor; enables local runs
  const link = await mintClaimLink({ sponsor: SPONSOR, web: WEB, amount: "20", from: "Alvin" });
  test.info().annotations.push({ type: "claim-url", description: link.url });

  // 1. value-first: the money is painted before any action, no crypto words.
  await page.goto(link.url, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/sent you money/i)).toBeVisible();
  await expect(page.getByText("$20.00")).toBeVisible();

  // 2. wait for hydration BEFORE clicking (avoids a click-before-hydration race on a
  //    cold first load). ClaimButton strips the #fragment on mount (C3), so an empty
  //    location.hash is a reliable "hydrated" signal — and asserts C3 at the same time.
  expect(link.url).toContain("#");
  await page.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });

  // 3. claim — one decision, one button.
  await page.getByRole("button", { name: /claim my money/i }).click();

  // 4. success: the money landed. Anchored to the start of the line, because the
  // already-claimed screen says the same words mid-sentence ("This link was claimed — it's
  // in your account already.") and a substring match would pass on a claim this run never
  // made. Vocabulary-law clean UI (no visible crypto), so the on-chain tx hash is surfaced
  // via the "public record" link href + a data-tx-hash attribute — assert on both, not on
  // visible hash text.
  await expect(page.getByText(/^\s*it['’]s in your account\b/i)).toBeVisible({ timeout: 120_000 });
  const receipt = page.getByRole("link", { name: /public record/i });
  await expect(receipt).toBeVisible();
  const href = (await receipt.getAttribute("href")) ?? "";
  // This route is pinned to testnet, so its receipt must be a testnet receipt: a link to any
  // other network would be a record of a transaction that is not the one just made.
  const hash = /\/explorer\/testnet\/tx\/([a-f0-9]{64})/i.exec(href)?.[1] ?? "";
  expect(hash).toMatch(/^[a-f0-9]{64}$/i);
  await expect(page.locator("[data-tx-hash]")).toHaveAttribute("data-tx-hash", hash);
  console.log(`\n✅ live claim OK — tx https://stellar.expert/explorer/testnet/tx/${hash}\n`);
});
