/**
 * /tools/link-check — is a money link still waiting, claimed, or returned? Rebuilt on Periwinkle,
 * moved from (marketing). Server shell + client island. The island is CLIENT-SIDE ONLY and NEVER
 * transmits the link's #fragment (the bearer key = cash) — it reads only the public balance id.
 */
import type { Metadata } from "next";
import { Footer } from "../../../../components/site/sections/Footer";
import { LinkCheckForm } from "./LinkCheckForm";
import "../../../../components/site/page.css";
import "../../../../components/site/tools.css";

const TITLE = "Check a money link — Lumenia";
const DESCRIPTION = "Paste a money link to see whether it's still waiting, already claimed, or returned to the sender. The check happens entirely in your browser.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/tools/link-check" },
  openGraph: {
    type: "website",
    url: "/tools/link-check",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function LinkCheck() {
  return (
    <div className="pg">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner" style={{ maxWidth: "620px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Tools
          </p>
          <h1 className="pg-h1">Check a money link.</h1>
          <p className="pg-lead">
            Paste a money link to see whether it&apos;s still waiting, already claimed, or returned to
            the sender.
          </p>
        </div>
      </header>

      <section className="tool-body">
        <div className="tool-inner">
          <LinkCheckForm />
        </div>
      </section>

      <Footer />
    </div>
  );
}
