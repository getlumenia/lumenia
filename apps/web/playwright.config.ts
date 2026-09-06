import { defineConfig, devices } from "@playwright/test";

/**
 * Live-claim regression harness (owner-approved). Runs the automated form of
 * Guardrail 2: after every deploy, mint a FRESH real claim link and claim it in a
 * real browser against the deployed sponsor + web. Targets the live URLs by
 * default (override with WEB_URL / SPONSOR_URL). Since 2026-09-06 the claim spec mints
 * through the sponsor's own /demo-link, so it needs NO secret and runs nightly in CI; set
 * MINT_VIA=cli with USDC_ISSUER_SECRET in the
 * env (HANDOFF §3) so the minted Claimable Balance matches the sponsor's trustline.
 *
 * This is a post-deploy gate, not a per-save test — each run consumes friendbot
 * funding + one on-chain Claimable Balance (testnet, worthless).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 150_000, // friendbot + issue + create CB + sponsored claim can be slow
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
