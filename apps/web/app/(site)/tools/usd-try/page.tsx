/**
 * /tools/usd-try — an indicative dollar↔lira estimate, honestly labeled "indicative". Rebuilt on
 * Periwinkle, moved from (marketing). Server shell + client island (the converter). Not a quote; a
 * display estimate from the same rate lib the app uses.
 */
import type { Metadata } from "next";
import { Footer } from "../../../../components/site/sections/Footer";
import { Converter } from "./Converter";
import "../../../../components/site/page.css";
import "../../../../components/site/tools.css";

const TITLE = "USD ↔ TRY — Lumenia";
const DESCRIPTION = "An indicative estimate of what dollars are worth in Turkish lira — a guide, not a quote.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/tools/usd-try" },
  openGraph: {
    type: "website",
    url: "/tools/usd-try",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function UsdTry() {
  return (
    <div className="pg">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner" style={{ maxWidth: "620px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Tools
          </p>
          <h1 className="pg-h1">USD ↔ TRY.</h1>
          <p className="pg-lead">
            An <strong>indicative</strong> estimate of what dollars are worth in Turkish lira — a
            guide, not a quote.
          </p>
        </div>
      </header>

      <section className="tool-body">
        <div className="tool-inner">
          <Converter />
        </div>
      </section>

      <Footer />
    </div>
  );
}
