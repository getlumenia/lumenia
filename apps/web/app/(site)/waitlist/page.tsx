/**
 * /waitlist — be first when real money goes live. Rebuilt on Periwinkle, moved from (marketing).
 * The email is kept in an ISOLATED store, never joined to money or an account (EmailCapture).
 */
import type { Metadata } from "next";
import Image from "next/image";
import { Footer } from "../../../components/site/sections/Footer";
import { EmailCapture } from "../../../components/site/EmailCapture";
import "../../../components/site/page.css";
import "../../../components/site/tools.css";

const PAGE_TITLE = "Join the waitlist";
const TITLE = `${PAGE_TITLE} | Lumenia`; // OG/Twitter keep the full branded form
const DESCRIPTION = "We're opening Lumenia to more people. Leave your email and we'll tell you the moment you can send real money home.";

export const metadata: Metadata = {
  title: PAGE_TITLE, // the (site) layout template appends “ | Lumenia”
  description: DESCRIPTION,
  alternates: { canonical: "/waitlist" },
  openGraph: {
    type: "website",
    url: "/waitlist",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function Waitlist() {
  return (
    <div className="pg">
      <header className="pg-hero pg-glow" style={{ textAlign: "center" }}>
        <div className="pg-hero-inner" style={{ maxWidth: "640px" }}>
          {/* The messenger waving hello — "we'll be in touch." */}
          <div className="pg-mascot-wrap" aria-hidden="true" style={{ marginBottom: "clamp(8px,2vh,20px)" }}>
            <span className="pg-mascot-glow" />
            <Image className="pg-mascot" src="/brand-kit-assets/mascot-wave-cut.webp" alt="" width={184} height={204} priority />
          </div>
          <h1 className="pg-h1">Be first when real money goes live.</h1>
          <p className="pg-lead" style={{ marginLeft: "auto", marginRight: "auto" }}>
            We&apos;re opening Lumenia to more people. Leave your email and we&apos;ll tell you the
            moment you can send real money home. Your email is kept on its own, never tied to any
            money or account.
          </p>
        </div>
      </header>

      <section className="tool-body">
        <div className="tool-inner" style={{ display: "flex", justifyContent: "center" }}>
          <EmailCapture list="waitlist" cta="Join the waitlist" />
        </div>
      </section>

      <Footer />
    </div>
  );
}
