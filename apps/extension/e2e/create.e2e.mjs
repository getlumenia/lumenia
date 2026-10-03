#!/usr/bin/env node
/**
 * An account MADE in the extension, end to end on TESTNET, through the popup's own screens:
 *
 *   1. Hello -> Get started; "One thing first" -> Agree; "No, I'm new here"; a password, twice ->
 *      "You're in!";
 *   2. practice dollars arrive on their own: the sponsor opens the account (no XLM needed) and the
 *      faucet pays it;
 *   3. "Make my first link" -> $0.10 -> claimed on getlumenia.com in a browser with no extension; the
 *      extension reads it as Claimed;
 *   4. "Back it up": a disposable inbox, the mailed code -> backed up;
 *   5. a FRESH browser profile restores the account with that email, a new code and the password, and
 *      gets the same address.
 *
 *   node build.mjs --e2e-ttl=180 && node e2e/create.e2e.mjs     (from apps/extension; about four minutes)
 *
 * Evidence in dist/e2e-evidence-create-<time>.json.
 */
import { chromium, HEADLESS, PASSWORD, SEND_USD, log, sleep, evidence, expert, inbox, extensionContext, claimOnWeb, writeEvidence } from "./lib.mjs";

evidence.mode = "create";

async function firstRun(p) {
  await p.getByRole("button", { name: "Get started" }).click({ timeout: 30_000 });
  await p.getByRole("button", { name: "Agree and continue" }).click({ timeout: 10_000 });
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS });

  // 1. a new account, made here
  const ext = await extensionContext({ locale: "en-US", timezoneId: "UTC" });
  const p = ext.page;
  await p.setViewportSize({ width: 360, height: 600 });
  await p.reload();
  await firstRun(p);
  await p.getByRole("button", { name: "No, I'm new here" }).click();
  await p.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await p.getByLabel("Type it again").fill(PASSWORD);
  const t1 = Date.now();
  await p.getByRole("button", { name: "Create my account" }).click();
  await p.getByText("You're in!").waitFor({ timeout: 60_000 });
  const made = await ext.ask({ type: "state" });
  const pubkey = made.account.pubkey;
  evidence.account = pubkey;
  evidence.createMs = Date.now() - t1;
  evidence.backupNeededAfterCreate = made.backup.needed;
  log(`popup: account made in the extension: ${pubkey} (${evidence.createMs} ms; backup needed: ${made.backup.needed})`);

  // 2. practice dollars, on their own
  await p.getByText(/You have \$[0-9.,]+ in practice dollars/).waitFor({ timeout: 120_000 });
  evidence.practiceDollars = (await ext.ask({ type: "balance" })).usd;
  log(`popup: practice dollars arrived: ${evidence.practiceDollars}`);

  // 3. the first link, claimed on the web
  await p.getByRole("button", { name: "Make my first link" }).click();
  await p.getByLabel("Amount").fill(SEND_USD);
  await p.getByRole("button", { name: "Make the link" }).click();
  await p.getByText("Your link is ready").waitFor({ timeout: 120_000 });
  const [rec] = await ext.ask({ type: "links.list" });
  const { link } = await ext.ask({ type: "links.reveal", linkHex: rec.linkHex });
  const [base, fragment = ""] = link.split("#");
  evidence.link = {
    linkHex: rec.linkHex,
    depositHash: rec.hash,
    depositUrl: expert(rec.hash),
    srcExt: new URL(base).searchParams.get("src") === "ext",
    secretOnlyInFragment: fragment.length > 0 && !base.includes(fragment),
  };
  log(`popup: first link made, ${rec.hash}`);
  const claimHash = await claimOnWeb(browser, link);
  evidence.link.claimHash = claimHash;
  evidence.link.claimUrl = expert(claimHash);
  log(`web: claimed with no extension, ${claimHash}`);
  for (let i = 0; i < 12 && evidence.link.statusAfterClaim !== "claimed"; i++) {
    const r = (await ext.ask({ type: "links.refresh", linkHex: rec.linkHex })).find((x) => x.linkHex === rec.linkHex);
    if (r?.status === "claimed") evidence.link.statusAfterClaim = "claimed";
    else await sleep(5_000);
  }
  log(`extension: the link reads ${evidence.link.statusAfterClaim ?? "not claimed yet"}`);
  if (evidence.link.statusAfterClaim !== "claimed") throw new Error("the extension never read the claim");

  // 4. back it up with an email
  const mail = await inbox();
  evidence.inbox = mail.address;
  await p.getByRole("button", { name: "Make another link" }).click();
  await p.getByRole("button", { name: "Back it up" }).click();
  await mail.skipExisting();
  await p.getByLabel("Email").fill(mail.address);
  await p.getByRole("button", { name: "Send me a code" }).click();
  const code = await mail.nextCode();
  log("popup: backup code arrived by mail");
  await p.getByLabel("6-digit code").fill(code);
  await p.getByText("Backed up").waitFor({ timeout: 60_000 });
  evidence.backedUp = (await ext.ask({ type: "state" })).backup.needed === false;
  log(`popup: backed up: ${evidence.backedUp}`);
  if (!evidence.backedUp) throw new Error("the account still reads as not backed up");
  await ext.ctx.close();

  // 5. a fresh browser profile brings it back
  const ext2 = await extensionContext({ locale: "en-US", timezoneId: "UTC" });
  const q = ext2.page;
  await q.setViewportSize({ width: 360, height: 600 });
  await q.reload();
  await firstRun(q);
  await q.getByRole("button", { name: "Yes, bring it here" }).click();
  await mail.skipExisting();
  await q.getByLabel("Email").fill(mail.address);
  await q.getByRole("button", { name: "Send me a code" }).click();
  const code2 = await mail.nextCode();
  log("fresh profile: restore code arrived by mail");
  await q.getByLabel("6-digit code").fill(code2);
  await q.getByLabel("Backup password").fill(PASSWORD, { timeout: 60_000 });
  await q.getByRole("button", { name: /^Restore$/ }).click();
  await q.getByLabel("Amount").waitFor({ timeout: 90_000 });
  const restored = (await ext2.ask({ type: "state" })).account.pubkey;
  evidence.restoredSameAccount = restored === pubkey;
  evidence.restoredBalance = (await ext2.ask({ type: "balance" })).usd;
  log(`fresh profile: restored ${restored} (same account: ${evidence.restoredSameAccount}, balance ${evidence.restoredBalance})`);
  if (!evidence.restoredSameAccount) throw new Error("the restored account is not the one made in the extension");
  await ext2.ctx.close();

  log(`evidence written to ${await writeEvidence("-create")}`);
  await browser.close();
}

main().catch(async (e) => {
  console.error("CREATE E2E FAILED:", e?.stack ?? e);
  evidence.error = String(e?.message ?? e);
  try {
    await writeEvidence("-create-failed");
  } catch {
    /* best effort */
  }
  process.exit(1);
});
