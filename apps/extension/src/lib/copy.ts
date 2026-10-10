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

/**
 * Under every backup and restore email field (LUMENIA ACCOUNT CONTRACT v1, 5.5): the server files a
 * backup under the exact address typed (lowercased), so a provider's own aliases are separate emails.
 */
export const EMAIL_HINT = "Type it the same way every time: first.last@gmail.com and firstlast@gmail.com are two different emails here.";

/*
 * What leaves this browser for real money, and what stays on it, in the words the website's /privacy
 * page, this extension's first-run screen, both store listings and the README all use (LUMENIA
 * ACCOUNT CONTRACT v1, 5.6). Each starts with its label, then a colon.
 */
/** D1: the pilot check. */
export const DISCLOSE_PILOT_CHECK =
  "To check the pilot: your account's public key, to the real-money server, when you press Real money or Check again, while you use real money, and while this account's request to join is waiting.";
/** D2: asking to join real money. */
export const DISCLOSE_PILOT_ASK =
  "To ask to join real money: your account's public key, the email that backs it up, a signature from your account and, if asked, a 6-digit code, to the real-money server.";
/** D3: the backup email kept on this device. */
export const DISCLOSE_EMAIL_KEPT = "On this device: the email each account is backed up with, so it can show it to you and use it when you ask to join.";

/** A disclosure sentence split at its label, for a list that sets the label in bold. */
export function disclosureParts(sentence: string): { label: string; rest: string } {
  const i = sentence.indexOf(": ");
  return i < 0 ? { label: "", rest: sentence } : { label: sentence.slice(0, i + 1), rest: sentence.slice(i + 2) };
}
