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
 *
 * It is ANCHORED to the start of an element's own text and must stay that way. BOTH routes carry
 * these same words inside a FAILURE line \u2014 "This link was claimed \u2014 it's in your account already."
 * (v1) and "\u2026it was claimed, or {sender} took it back after the link expired. If you claimed it on
 * this phone, it's in your account." (v2) \u2014 so an unanchored substring match goes green on a claim
 * this run never made. Only the success line BEGINS with the phrase.
 */
export const MONEY_LANDED = /^\s*it['\u2019]s (in your account|yours)\b/i;

export async function expectMoneyLanded(page: Page, timeout = 120_000): Promise<void> {
  await expect(page.getByText(MONEY_LANDED)).toBeVisible({ timeout });
}
