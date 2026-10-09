/**
 * /waitlist — be first when real money goes live. Rebuilt on Periwinkle, moved from (marketing).
 * The email is kept in an ISOLATED store, never joined to money or an account (EmailCapture).
 *
 * RETIRED BY ONE SWITCH (lib/real-money.ts `realMoneyOpen`). Once real money is open to everyone
 * (NEXT_PUBLIC_REAL_MONEY_OPEN=1, set with the mainnet Worker's own switch and a redeploy), there is
 * nothing to wait for: the page says so and points at /start instead of collecting another email.
 * Old links to /waitlist keep landing somewhere true.
 */
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Footer } from "../../../components/site/sections/Footer";
import { EmailCapture } from "../../../components/site/EmailCapture";
import { REAL_MONEY_WARNING, realMoneyOpen, waitlistCta } from "../../../lib/real-money";
import "../../../components/site/page.css";
import "../../../components/site/tools.css";

/** Decided at build time, like every NEXT_PUBLIC value: the page is static. */
const OPEN = realMoneyOpen();

const PAGE_TITLE = OPEN ? "Real money is open" : "Join the waitlist";
const TITLE = `${PAGE_TITLE} | Lumenia`; // OG/Twitter keep the full branded form
const DESCRIPTION = OPEN
  ? "Real money on Lumenia is open to everyone. There is no waitlist: start now, and switch to real money when you are ready."
  : "We're opening Lumenia to more people. Leave your email and we'll tell you the moment you can send real money home.";

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
  const cta = waitlistCta();
  return (
    <div className="pg">
      <header className="pg-hero pg-glow" style={{ textAlign: "center" }}>
        <div className="pg-hero-inner" style={{ maxWidth: "640px" }}>
          {/* The messenger waving hello — "we'll be in touch." */}
          <div className="pg-mascot-wrap" aria-hidden="true" style={{ marginBottom: "clamp(8px,2vh,20px)" }}>
            <span className="pg-mascot-glow" />
            <Image className="pg-mascot" src="/brand-kit-assets/mascot-wave-cut.webp" alt="" width={184} height={204} priority />
          </div>
          {OPEN ? (
            <>
              <h1 className="pg-h1">Real money is open to everyone.</h1>
              <p className="pg-lead" style={{ marginLeft: "auto", marginRight: "auto" }}>
                There is no waitlist any more. Start with practice money, and switch to real money
                when you are ready. {REAL_MONEY_WARNING}
              </p>
            </>
          ) : (
            <>
              <h1 className="pg-h1">Be first when real money goes live.</h1>
              <p className="pg-lead" style={{ marginLeft: "auto", marginRight: "auto" }}>
                We&apos;re opening Lumenia to more people. Leave your email and we&apos;ll tell you the
                moment you can send real money home. Your email is kept on its own, never tied to any
                money or account.
              </p>
            </>
          )}
        </div>
      </header>

      <section className="tool-body">
        <div className="tool-inner" style={{ display: "flex", justifyContent: "center" }}>
          {OPEN ? (
            <Link className="pg-btn pg-btn-primary" href={cta.href}>
              {cta.label}
            </Link>
          ) : (
            <EmailCapture list="waitlist" cta={cta.label} />
          )}
        </div>
      </section>

      <Footer />
    </div>
  );
}
