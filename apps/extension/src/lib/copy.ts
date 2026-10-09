/**
 * Sentences the extension shares, word for word, with the website, the pilot's mail and the store
 * listing (store/description.txt, store/amo-listed.json). They live in one place so a change is made
 * once, and src/popup/popup.selftest.ts holds every copy of them to the same words.
 */
import { PILOT_DAY_CAP_USD, SENDER_DAY_CAP_USD, TX_CAP_USD } from "../config";

/** The one-time note before real money, the same sentence on every surface that shows one. */
export const REAL_MONEY_WARNING =
  "Real money on Lumenia is an early pilot. It has not been reviewed by an outside security firm yet. You can lose money, so keep amounts small.";

/** The pilot's caps in words: one link, one sender's day, and the whole pilot's day. */
export const CAPS = `$${TX_CAP_USD} a link and up to $${SENDER_DAY_CAP_USD} a day from you ($${PILOT_DAY_CAP_USD} a day across the whole pilot)`;

/** The same caps where there is room for one short line. */
export const CAPS_SHORT = `$${TX_CAP_USD} a link, $${SENDER_DAY_CAP_USD} a day`;

/** The caps as a sentence of their own: it follows the warning, never joins it. */
export const CAPS_SENTENCE = `Real money is capped at ${CAPS}.`;

/**
 * Shown under the From field while it holds a name. A link carries no name unless the sender types
 * one, and a typed name rides after the '#' with the key (apps/web/lib/link-fragment.ts).
 */
export const NAME_NOTE = "Your name travels inside the link, after the #. Anyone who can read the chat can read it.";
