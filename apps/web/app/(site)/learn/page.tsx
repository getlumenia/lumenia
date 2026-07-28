/**
 * /learn — the guide index. Rebuilt on the Periwinkle system and moved here from (marketing).
 *
 * A stack of rows, not a card grid: brand.md §8 rules out three identical cards in a symmetric
 * grid, and a list of articles is a list — the row is the affordance. The old page wrapped each
 * guide in a MoneyCard, which is the retired warm-paper component (and the last thing on this route
 * that referenced it).
 *
 * Content comes from lib/learn.ts, unchanged — it is editorial copy, not data, and it is already
 * vocabulary-law safe (money + people, no crypto terms).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { GUIDES } from "../../../lib/learn";
import { Footer } from "../../../components/site/sections/Footer";
import "../../../components/site/page.css";
import "../../../components/site/editorial.css";

const PAGE_TITLE = "Learn: plain-language guides";
const TITLE = `${PAGE_TITLE} | Lumenia`; // OG/Twitter keep the full branded form
const DESCRIPTION =
  "Plain-language guides to sending money home: how a link transfer works, where your money is before it's claimed, and an honest map of the alternatives.";

export const metadata: Metadata = {
  title: PAGE_TITLE, // the (site) layout template appends “ | Lumenia”
  description: DESCRIPTION,
  alternates: { canonical: "/learn" },
  openGraph: {
    type: "website",
    url: "/learn",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function Learn() {
  return (
    <div className="pg ed">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner">
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Learn
          </p>
          <h1 className="pg-h1">Plain-language guides.</h1>
          <p className="pg-lead">
            No jargon, no crypto, no assumed knowledge. Short answers to the questions people
            actually ask before they trust something with their money.
          </p>
        </div>
      </header>

      <section className="ed-body">
        <nav className="ed-list" aria-label="Guides">
          {GUIDES.map((g) => (
            <Link className="ed-item" href={`/learn/${g.slug}`} key={g.slug}>
              <h2 className="ed-item-t">{g.title}</h2>
              <p className="ed-item-s">{g.summary}</p>
              <span className="ed-item-go">
                Read it{" "}
                <span className="ed-item-arrow" aria-hidden="true">
                  →
                </span>
              </span>
            </Link>
          ))}
        </nav>

        <div className="ed-close">
          <p className="ed-close-p">
            Would rather just see it? It sends you a real link and takes
            about 30 seconds.
          </p>
          <div className="pg-cta">
            <Link className="pg-btn pg-btn-primary" href="/try">
              See it work
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
