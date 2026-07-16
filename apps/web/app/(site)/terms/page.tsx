/**
 * /terms — the short, honest version; a full legal document comes with launch. Rebuilt on
 * Periwinkle, moved from (marketing). Copy carried over verbatim.
 */
import type { Metadata } from "next";
import { Footer } from "../../../components/site/sections/Footer";
import "../../../components/site/page.css";
import "../../../components/site/editorial.css";

const TITLE = "Terms — Lumenia";
const DESCRIPTION = "The short, honest version: a pilot on a test network, not a bank, money on a public ledger, a link is like cash, and your password is yours alone.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/terms" },
  openGraph: {
    type: "website",
    url: "/terms",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function Terms() {
  return (
    <div className="pg ed">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner">
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Terms
          </p>
          <h1 className="pg-h1">The short, honest version.</h1>
        </div>
      </header>

      <section className="ed-body">
        <div className="ed-prose">
          <p>The short, honest version. A full legal document comes with launch.</p>
          <p>
            <strong>This is a pilot on a test network.</strong> The money here is test money with no
            real value. Don&apos;t send anything you can&apos;t afford to treat as a demo.
          </p>
          <p>
            <strong>We are not a bank or a money-transfer business.</strong> Lumenia doesn&apos;t hold
            your money — it moves between people on a public ledger. We provide the software that sets
            up accounts and covers network costs.
          </p>
          <p>
            <strong>A money link is like cash.</strong> Whoever holds the link can claim it. Keep it
            private and share it only with the person it&apos;s for. Once claimed, it&apos;s claimed.
          </p>
          <p>
            <strong>Your password is yours alone.</strong> If you lock your money with a password and
            forget it, nobody — including Lumenia — can recover it.
          </p>
          <p>
            <strong>No guarantees during the pilot.</strong> We build carefully and verify in public,
            but this is early software provided as-is while we test.
          </p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
