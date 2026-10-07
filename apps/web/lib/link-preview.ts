/**
 * What a chat app's preview card may say about a claim link.
 *
 * Every chat app fetches a pasted link to draw its card, and the card is built from the page's
 * metadata. Before D2 that metadata named the sender and printed the amount for every link, so both
 * landed in every card and in the request line of every fetch. A link is now private by default: the
 * card says only that money is waiting, the same words for every link, and nothing taken from the
 * URL can reach it. Showing the name and the amount is the sender's explicit choice (`preview=rich`,
 * decided in lib/lumendrop.ts v2LinkUrl), and even then the amount comes from the ledger.
 *
 * Constants only, plus the one function both claim pages return, so a self-test can hold it.
 */
import type { Metadata } from "next";

export { RICH_PREVIEW_PARAM, RICH_PREVIEW_VALUE } from "./link-fragment";

export const PRIVATE_PREVIEW_TITLE = "Lumenia";
export const PRIVATE_PREVIEW_DESCRIPTION =
  "Someone sent you dollars by link. Open it to see the amount. No app, no sign-up, and the recipient pays no gas.";
export const PRIVATE_PREVIEW_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." };

/**
 * The metadata of a claim page for every link that is not an explicit rich one: the same title,
 * description and image whatever the URL says, and no indexing. Built fresh on each call so no caller
 * can change what the next one returns.
 */
export function privateClaimMetadata(): Metadata {
  return {
    title: { absolute: PRIVATE_PREVIEW_TITLE },
    description: PRIVATE_PREVIEW_DESCRIPTION,
    openGraph: {
      title: PRIVATE_PREVIEW_TITLE,
      description: PRIVATE_PREVIEW_DESCRIPTION,
      images: [{ ...PRIVATE_PREVIEW_IMAGE }],
    },
    twitter: {
      card: "summary_large_image",
      title: PRIVATE_PREVIEW_TITLE,
      description: PRIVATE_PREVIEW_DESCRIPTION,
      images: [{ ...PRIVATE_PREVIEW_IMAGE }],
    },
    robots: { index: false, follow: false },
  };
}
