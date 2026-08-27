import { expect, type Page } from "@playwright/test";

/**
 * "The money landed" — on either claim route.
 *
 * There are two, and they say it differently: the v1 Claimable-Balance route (/c/[id]) says
 * "It's in your account.", the v2 Soroban route (/v2/c/[linkHex]) says "It's yours 🎉". The suite
 * asserted the v1 wording everywhere, so from the day v2 became the DEFAULT send every onward-link
 * test failed on a claim that had actually succeeded — the on-chain tx was right there in the
 * failure snapshot. A gate that fails on success stops being read, which is how it went unnoticed.
 *
 * Matching both is deliberate rather than lazy: what these tests are for is "did the money arrive",
 * and both sentences mean exactly that. If a route's wording changes again, this is the one place
 * to look.
 */
export const MONEY_LANDED = /in your account|it['\u2019]s yours/i;

export async function expectMoneyLanded(page: Page, timeout = 120_000): Promise<void> {
  await expect(page.getByText(MONEY_LANDED)).toBeVisible({ timeout });
}
