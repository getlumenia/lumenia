/**
 * /learn content (FRONTEND_PLAN §1b launch set). Plain-language guides targeting the
 * corridor's real searches. Vocabulary-law safe (money + people). Static data — no
 * mock ledger data, just editorial copy.
 */
export interface Guide {
  slug: string;
  title: string;
  summary: string;
  body: string[]; // paragraphs
}

/**
 * REAL content dates for the guide set (all guides shipped in one commit:
 * a71741e, 2026-07-12; unchanged since). Used by the Article JSON-LD and the
 * sitemap. When a guide's copy meaningfully changes, bump GUIDES_UPDATED (or
 * promote these to per-guide fields) — never fabricate freshness.
 */
export const GUIDES_PUBLISHED = "2026-07-12";
export const GUIDES_UPDATED = "2026-07-12";

export const GUIDES: Guide[] = [
  {
    slug: "how-sending-money-by-a-link-works",
    title: "How sending money by a link works",
    summary: "The whole idea in three sentences.",
    body: [
      "You choose an amount and get a link. You share that link on WhatsApp, just like you'd share anything else. That's the transfer. No forms, no account numbers.",
      "Your recipient taps the link and sees the money right away, before creating anything. Then they claim it in their browser with their face or a password they choose.",
      "The exact amount arrives, held in dollars. Receiving is free. If nobody claims the link within 7 days, the money comes back to you.",
    ],
  },
  {
    slug: "where-is-my-money-before-its-claimed",
    title: "Where is my money before it's claimed?",
    summary: "Not with us, and that's the whole point.",
    body: [
      "The moment you send, your money moves into escrow on a public ledger, a shared record no single company controls. Lumenia never holds it, so we can't lend it, invest it, or lose it.",
      "Only two people can move it: your recipient, who can claim it any time, and you, who can take it back if it isn't claimed within 7 days. Nobody else, including us.",
      "Every transfer produces a public record you can check yourself. You don't have to trust a page; you can verify it.",
    ],
  },
  {
    slug: "why-the-amount-is-held-in-dollars",
    title: "Why the amount is held in dollars",
    summary: "Protection, not growth.",
    body: [
      "The amount is held in dollars so it doesn't shrink in a volatile currency or wobble with markets while it waits to be claimed or spent.",
      "This is about keeping a promise intact: what you sent is what arrives. It doesn't grow and it earns nothing, and we'd be suspicious of anyone who told you otherwise.",
      "Your recipient can hold it as dollars and send it onward whenever they like.",
    ],
  },
  {
    slug: "is-lumenia-a-bank",
    title: "Is Lumenia a bank? (No, and here's why that's good)",
    summary: "Banks hold your money. We never do.",
    body: [
      "Lumenia is not a bank and doesn't want to be one. We don't take deposits, we don't pay interest, and your money is never sitting in an account with our name on it.",
      "Because we never hold your money, there's nothing for us to freeze, lose, or lend. If Lumenia disappeared tomorrow, your money wouldn't. It lives on a public ledger under your recipient's control, or yours for unclaimed links.",
      "We're a way to move money from you to someone you love, and then we get out of the way.",
    ],
  },
  {
    slug: "sending-money-home-to-turkey",
    title: "Sending money home to Turkey: what your options really are",
    summary: "An honest map of the choices.",
    body: [
      "Banks reliably land money in a Turkish account, but they're often the slowest and priciest, and your recipient needs an IBAN ready.",
      "Money-transfer apps are cheaper and faster, but usually your recipient needs their app or a bank account set up first.",
      "Lumenia's angle is different: the person you send to needs nothing: no app, no account, no IBAN, and nothing to pay to receive. Turning dollars into lira in a bank will come via licensed partners.",
    ],
  },
];

export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}
