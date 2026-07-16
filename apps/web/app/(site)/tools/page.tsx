/**
 * /tools — the utility hub. Rebuilt on the Periwinkle system and moved here from (marketing).
 *
 * A row list (the guide-index primitive from editorial.css), not a card grid — brand.md §8 rules
 * out three identical cards in a symmetric grid, and a list of tools is a list: the row IS the
 * affordance. Copy carried over verbatim.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "../../../components/site/sections/Footer";
import "../../../components/site/page.css";
import "../../../components/site/editorial.css";

const TITLE = "Tools — Lumenia";
const DESCRIPTION = "Small, free tools — no account needed. Verify a transfer, check a money link, estimate USD to lira, or see what sending money home usually costs.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/tools" },
  openGraph: {
    type: "website",
    url: "/tools",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

const TOOLS: Array<{ href: string; t: string; b: string }> = [
  { href: "/tools/verify", t: "Verify a transfer", b: "Paste a transfer code and see the real, public record behind it." },
  { href: "/tools/link-check", t: "Check a money link", b: "Paste a link to see if it's still waiting, claimed, or returned." },
  { href: "/tools/usd-try", t: "USD ↔ TRY", b: "An indicative dollar-to-lira estimate." },
  { href: "/tools/cost", t: "What it costs", b: "What sending money home usually costs — and what Lumenia costs today." },
];

export default function Tools() {
  return (
    <div className="pg ed">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner">
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Tools
          </p>
          <h1 className="pg-h1">Small, free tools.</h1>
          <p className="pg-lead">No account, no sign-up — just a few things worth checking for yourself.</p>
        </div>
      </header>

      <section className="ed-body">
        <div className="ed-list">
          {TOOLS.map((t) => (
            <Link key={t.href} href={t.href} className="ed-item">
              <p className="ed-item-t">{t.t}</p>
              <p className="ed-item-s">{t.b}</p>
              <span className="ed-item-go">
                Open <span className="ed-item-arrow" aria-hidden="true">→</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <Footer />
    </div>
  );
}
