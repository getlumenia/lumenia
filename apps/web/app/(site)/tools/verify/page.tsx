/**
 * /tools/verify — the interactive proof of "every claim is checkable". Rebuilt on Periwinkle, moved
 * from (marketing). Server shell (metadata + hero + Footer); the form is a client island.
 */
import type { Metadata } from "next";
import { Footer } from "../../../../components/site/sections/Footer";
import { VerifyForm } from "./VerifyForm";
import "../../../../components/site/page.css";
import "../../../../components/site/tools.css";

const TITLE = "Verify a transfer — Lumenia";
const DESCRIPTION = "Every transfer produces a public record you can check yourself. Paste a transfer code and see the real record behind it.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/tools/verify" },
  openGraph: {
    type: "website",
    url: "/tools/verify",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function Verify() {
  return (
    <div className="pg">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner" style={{ maxWidth: "620px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Tools
          </p>
          <h1 className="pg-h1">Verify a transfer.</h1>
          <p className="pg-lead">
            Every transfer produces a public record you can check yourself. Paste a transfer code below.
          </p>
        </div>
      </header>

      <section className="tool-body">
        <div className="tool-inner">
          <VerifyForm />
        </div>
      </section>

      <Footer />
    </div>
  );
}
