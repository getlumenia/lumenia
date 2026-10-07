import { test, expect } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
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
  const link = await mintClaimLink({ sponsor: SPONSOR, web: WEB, from: "Alvin" });
  test.info().annotations.push({ type: "claim-url", description: link.url });

  // 0. the link is private (D2): nothing about the money or the person in its query. The amount
  //    is read from the ledger and the name rides behind the key in the fragment, so a chat
  //    preview, a bot's fetch or a server log of this URL learns neither.
  const query = new URL(link.url).searchParams;
  expect(query.has("a"), "a private link carries no amount in its query").toBe(false);
  expect(query.has("s"), "a private link carries no name in its query").toBe(false);

  // 1. value-first: the money is painted before any action, no crypto words. Both are filled in
  //    by the browser (the name from the fragment, the amount from Horizon testnet), so allow the
  //    ledger read its time rather than the default five seconds.
  await page.goto(link.url, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/sent you money/i)).toBeVisible({ timeout: 30_000 });
  // The name came out of the fragment, not the query (step 0 proved the query has none).
  await expect(page.getByText(/sent you money/i)).toContainText(link.from);
  // Assert the amount the minter actually produced, not a number typed here. The demo link's
  // size is a configuration value and it changed once already; a hardcoded "$20.00" turns that
  // into a red test that looks like a product failure.
  const shown = `$${Number(link.amount).toFixed(2)}`;
  await expect(page.getByText(shown)).toBeVisible({ timeout: 30_000 });

  // 2. wait for hydration BEFORE clicking (avoids a click-before-hydration race on a
  //    cold first load). ClaimButton strips the #fragment on mount (C3), so an empty
  //    location.hash is a reliable "hydrated" signal — and asserts C3 at the same time.
  expect(link.url).toContain("#");
  await page.waitForFunction(() => window.location.hash === "", null, { timeout: 20_000 });

  // 3. claim — one decision, one button.
  await page.getByRole("button", { name: /claim my money|^take \$/i }).click();

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

  // 5. The link's key never becomes this device's home account. A practice link's key was made by
  // the server and is in the link, so on a device with no home the app makes a home of its own and
  // moves the money there before the next buttons show (lib/claim-home.ts).
  await expect(page.getByRole("link", { name: /see my money/i })).toBeVisible({ timeout: 90_000 });
  const linkPub = Keypair.fromSecret(link.url.split("#")[1]!.split("&")[0]!).publicKey();
  const homePub = await page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        const open = indexedDB.open("lumenia");
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const get = open.result.transaction("keys", "readonly").objectStore("keys").get("__home__");
          get.onsuccess = () => resolve((get.result as { pubkey?: string } | undefined)?.pubkey ?? null);
          get.onerror = () => resolve(null);
        };
      }),
  );
  expect(homePub, "this device has a home account after the claim").toMatch(/^G[A-Z2-7]{55}$/);
  expect(homePub, "the home account is not the link's account").not.toBe(linkPub);
  console.log(`\n✅ live claim OK — tx https://stellar.expert/explorer/testnet/tx/${hash}\n`);
});
