/**
 * /cash-out — turning money into lira, handled by licensed local partners (delegated, not built by
 * Lumenia). Rebuilt on Periwinkle, moved from (marketing). Honest: no date we can't keep.
 */
import type { Metadata } from "next";
import { Footer } from "../../../components/site/sections/Footer";
import { EmailCapture } from "../../../components/site/EmailCapture";
import "../../../components/site/page.css";
import "../../../components/site/tools.css";

const TITLE = "Turning it into lira — Lumenia";
const DESCRIPTION = "Turning your money into Turkish lira in a bank account will be handled by licensed local partners — shipped when it's genuinely reliable, not before.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/cash-out" },
  openGraph: {
    type: "website",
    url: "/cash-out",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function CashOut() {
  return (
    <div className="pg">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner" style={{ maxWidth: "640px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Cash-out
          </p>
          <h1 className="pg-h1">Turning it into lira.</h1>
          <p className="pg-lead">
            Inside Lumenia you can hold your money in dollars and send it onward with a link. Turning
            it into Turkish lira in a bank account will be handled by <strong>licensed local
            partners</strong> — and we&apos;ll ship it when it&apos;s genuinely reliable, not before.
          </p>
          <p className="pg-lead" style={{ marginTop: "12px" }}>
            We won&apos;t promise a date we can&apos;t keep. Want to know the moment it&apos;s ready?
          </p>
        </div>
      </header>

      <section className="tool-body">
        <div className="tool-inner">
          <EmailCapture list="cashout" cta="Notify me" />
        </div>
      </section>

      <Footer />
    </div>
  );
}
