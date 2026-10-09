/**
 * Real money, said the same way everywhere it is said.
 *
 * THE WARNING (SOW 2 shared decision D1) is one sentence set, verbatim on every surface that shows it
 * (the warning sheet before the first switch, /pilot in both of its states, the ask-to-join sheet;
 * outside this app the extension's one-time note, the pilot approval mail and the store listings
 * carry the same words). It names all four things a person needs before real money: it is an early
 * pilot, nobody outside has reviewed it, they can lose money, so amounts stay small. A cap sentence,
 * where one is shown, follows it separately.
 *
 * THE CAPS are the mainnet Worker's own numbers (apps/sponsor/wrangler.toml [env.mainnet.vars]:
 * MAX_DROP_USDC, MAX_DAY_USDC_PER_SENDER, MAX_DAY_USDC). The Worker enforces them whatever this page
 * says; these only make the page say the same thing. Each is a build-time variable with today's value
 * as its default, so a change on the Worker is one env change here and never a code edit:
 *
 *   NEXT_PUBLIC_PILOT_TX_CAP_USD          per link (or per pot)           default 5
 *   NEXT_PUBLIC_PILOT_SENDER_DAY_CAP_USD  per sender, per UTC day         default 25
 *   NEXT_PUBLIC_PILOT_DAY_CAP_USD         across the whole pilot, per day default 50
 *
 * THE RETIREMENT FLAG for the public waitlist: see `realMoneyOpen`.
 *
 * Plain ASCII on purpose (no curly quotes, no dashes): the same strings are pasted into mail and
 * store listings, and lib/pilot-access.selftest.ts holds them to it.
 */

/** D1, verbatim. Do not reword it on one surface: change it here, and in the places named above. */
export const REAL_MONEY_WARNING =
  "Real money on Lumenia is an early pilot. It has not been reviewed by an outside security firm yet. You can lose money, so keep amounts small.";

/* Spelled out in full: Next inlines a NEXT_PUBLIC_ value only where its whole name is written. */
/** The most one link (or one group pot) may hold on real money. */
export const PILOT_TX_CAP_USD = process.env.NEXT_PUBLIC_PILOT_TX_CAP_USD ?? "5";
/** What one sender may put into links on real money in one UTC day. */
export const PILOT_SENDER_DAY_CAP_USD = process.env.NEXT_PUBLIC_PILOT_SENDER_DAY_CAP_USD ?? "25";
/** What everyone together may put into links on real money in one UTC day. */
export const PILOT_DAY_CAP_USD = process.env.NEXT_PUBLIC_PILOT_DAY_CAP_USD ?? "50";

/** D2, long form: "$5 a link and up to $25 a day from you ($50 a day across the whole pilot)". */
export function pilotCaps(): string {
  return `$${PILOT_TX_CAP_USD} a link and up to $${PILOT_SENDER_DAY_CAP_USD} a day from you ($${PILOT_DAY_CAP_USD} a day across the whole pilot)`;
}

/** D2, short form: "$5 a link, $25 a day". */
export function pilotCapsShort(): string {
  return `$${PILOT_TX_CAP_USD} a link, $${PILOT_SENDER_DAY_CAP_USD} a day`;
}

/** The cap sentence that follows the warning. */
export function pilotCapsSentence(): string {
  return `The pilot caps what you send at ${pilotCaps()}.`;
}

/**
 * `NEXT_PUBLIC_REAL_MONEY_OPEN=1` at build time: real money is open to everyone, so the public site
 * stops asking people to join a waitlist for it. Default off, which is today: real money is a
 * hand-approved pilot and the waitlist is the honest offer.
 *
 * It only RETIRES the public waitlist's calls to action (the /waitlist page, the landing's closing
 * band, the footer, /roadmap) and points them at /start instead. It opens nothing: who may move real
 * money is the mainnet Worker's PILOT_MODE, and the app's own screens already follow the Worker's
 * answer (/pilot-status). Set it in the same step as that switch (the ops note's opening procedure),
 * and redeploy: NEXT_PUBLIC values are baked into the build.
 */
export function realMoneyOpen(): boolean {
  return process.env.NEXT_PUBLIC_REAL_MONEY_OPEN === "1";
}

/** Where a waitlist call to action points: the waitlist today, /start once real money is open. */
export function waitlistCta(): { href: string; label: string } {
  return realMoneyOpen() ? { href: "/start", label: "Get started" } : { href: "/waitlist", label: "Join the waitlist" };
}
