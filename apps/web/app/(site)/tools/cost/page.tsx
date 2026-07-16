/**
 * /tools/cost — what sending money home usually costs, and what Lumenia costs today. Rebuilt on
 * Periwinkle, moved from (marketing). Fully server-rendered. Copy carried over verbatim; the one
 * accent-tinted row is us (brand.md §4.5 — the accent marks the arrival moment).
 */
import type { Metadata } from "next";
import { Footer } from "../../../../components/site/sections/Footer";
import "../../../../components/site/page.css";
import "../../../../components/site/tools.css";

const TITLE = "What it costs — Lumenia";
const DESCRIPTION = "What sending money home usually costs — and what Lumenia costs today (receiving is free; we cover the small network cost).";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/tools/cost" },
  openGraph: {
    type: "website",
    url: "/tools/cost",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

const INCUMBENTS: Array<{ name: string; range: string; note: string }> = [
  { name: "Bank transfer (SEPA/SWIFT → Turkey)", range: "€6 – €15+", note: "plus an exchange spread, and often days to arrive" },
  { name: "Money-transfer apps", range: "€2 – €10", note: "cheaper and faster, but your recipient needs their app or a bank account" },
  { name: "Cash pickup services", range: "€5 – €20", note: "ubiquitous, but a branch visit and higher fees" },
];

export default function Cost() {
  return (
    <div className="pg">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner" style={{ maxWidth: "620px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Tools
          </p>
          <h1 className="pg-h1">What sending money home usually costs.</h1>
          <p className="pg-lead">
            Typical published ranges for sending money to Turkey. Millions of families already pay
            these every month — that&apos;s the market telling you the job matters.
          </p>
        </div>
      </header>

      <section className="tool-body">
        <div className="tool-inner">
          <div className="tool-rows">
            {INCUMBENTS.map((r) => (
              <div key={r.name} className="tool-row">
                <div className="tool-row-top">
                  <p className="tool-row-name">{r.name}</p>
                  <p className="tool-row-range">{r.range}</p>
                </div>
                <p className="tool-row-note">{r.note}</p>
              </div>
            ))}
            <div className="tool-row tool-row-hi">
              <div className="tool-row-top">
                <p className="tool-row-name">Lumenia (pilot)</p>
                <p className="tool-row-range">Free</p>
              </div>
              <p className="tool-row-note">
                Receiving is free — your recipient never pays to accept money, and we cover the small
                network cost. When we introduce a sending fee, it will be one number shown before you
                confirm.
              </p>
            </div>
          </div>
          <p className="tool-fine">
            Ranges are typical published figures for illustration, not a live comparison. Lumenia is on
            a test network today.
          </p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
