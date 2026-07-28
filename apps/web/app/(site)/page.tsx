/**
 * Landing (/) — the LOCKED Periwinkle landing, composed from per-section components under
 * components/site/sections/. This file is intentionally thin: it only wires the section order and
 * the overlay-reveal structure. The opening IS the Apple-style scroll-scrub hero — a sticky mascot
 * Greeting the ScrubHero scrolls up over. Sticky greeting z0; everything after rides in .op-over z1
 * (overlay-reveal, our locked transition). Shared styles live in ./sections/landing.css.
 *
 * Section order (top→bottom, brand.md §12 narrative):
 *   1 Greeting + ScrubHero + HeroResolution — the hero (subtraction → "Money home, in a link.")
 *   2 Fears        — the four fears, named then struck through
 *   2b Difference  — everyone else makes the RECEIVER do the work; we don't
 *   3 Moment       — the real human beat (treated photograph)
 *   4 HowItWorks   — pinned 3-step scroll story
 *   5 Proof        — the one Stellar-dark strip + real on-chain receipt
 *   6 Trust        — "Where is my money, exactly?" essay + FAQ
 *   7 CloseCTA + Footer — dual CTA over the living video + the dark footer
 */
import type { Metadata } from "next";
import SmoothScroll from "../../components/brand/SmoothScroll";
import "../../components/site/sections/landing.css";
import { BootOpening } from "../../components/site/sections/BootOpening";
import { Greeting } from "../../components/site/sections/Greeting";
import { ScrubHero } from "../../components/site/sections/ScrubHero";
import { HeroResolution } from "../../components/site/sections/HeroResolution";
import { Fears } from "../../components/site/sections/Fears";
import { Difference } from "../../components/site/sections/Difference";
import { Moment } from "../../components/site/sections/Moment";
import { HowItWorks } from "../../components/site/sections/HowItWorks";
import { Proof } from "../../components/site/sections/Proof";
import { Trust } from "../../components/site/sections/Trust";
import { CloseCTA } from "../../components/site/sections/CloseCTA";
import { Footer } from "../../components/site/sections/Footer";

const TITLE = "Lumenia — money home, in a link";
const DESCRIPTION =
  "Send money by link. They tap it, and it's theirs. No wallet, no seed phrase, no app to install. Held in dollars until they need it.";

/**
 * The landing's metadata. It lives here rather than in the group layout because (site) now holds
 * more than one route, and canonical/OG are per-route.
 *
 * The OG/Twitter card is a real asset (public/og.png), not a screenshot: the wordmark, the locked
 * §6 hero line and the messenger, on the landing's own paper. Both are absolute via the root
 * layout's metadataBase — link crawlers reject relative image URLs.
 *
 * Vocabulary law (lib/copy.ts) applies here as much as in the UI: no wallet/crypto/Stellar/gas.
 * "no wallet, no seed phrase" is the approved subtraction line — it names what you DON'T need.
 */
export const metadata: Metadata = {
  // absolute: the landing's title IS the brand line — the group template would
  // double the name ("Lumenia — … — Lumenia").
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Lumenia — money home, in a link. The Lumenia messenger holding an envelope.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
};

/**
 * Structured data. Organization + WebSite let a search engine name the product and its mark rather
 * than guessing from the DOM. Kept minimal and TRUE: no aggregateRating, no fabricated review or
 * price markup — the same honesty rule the rest of the repo runs on applies to what we tell crawlers.
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://lumenia-chi.vercel.app";
const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: "Lumenia",
      url: SITE_URL,
      logo: `${SITE_URL}/icon-512.png`,
      description:
        "Send money by link. They tap it, and it's theirs. No wallet, no seed phrase, no app.",
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: "Lumenia",
      publisher: { "@id": `${SITE_URL}/#organization` },
      inLanguage: "en",
    },
    // WebApplication classifies the product (FinanceApplication) for engines that
    // key on it. Still minimal and TRUE: it is free to use today (receiving is
    // free), and there are deliberately NO ratings/reviews.
    {
      "@type": "WebApplication",
      "@id": `${SITE_URL}/#webapp`,
      name: "Lumenia",
      url: SITE_URL,
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
  ],
};

export default function Landing() {
  return (
    <SmoothScroll>
      <script
        type="application/ld+json"
        // Static, authored-here object — no user input reaches this.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      {/* `site-theme` maps shadcn semantic tokens to Periwinkle so shadcn primitives placed inside the
          landing render on-brand; the landing's own styles use the collision-free `--pw-*` namespace. */}
      <div className="op site-theme">
        {/* First frame: a flat field of the wordmark's "i" colour that drains into the "i" itself.
            Inside .op so it inherits --pw-accent (the letters' fill) and flips with the theme.
            Pure CSS — it opens at first paint, with or without JS. */}
        <BootOpening />
        <Greeting />
        {/* Section transitions = the brand-kit sticky-overlap (each section is position:sticky;top:0
            with a rising z-index, so the NEXT section slides up over the pinned previous one). The
            tall scroll-regions (scrub reel, pinned how-it-works, the FAQ-heavy Trust) can't pin
            without hiding content, so they stay relative and their neighbours overlay them instead.
            Sticky/z-index is driven from landing.css by section class. */}
        <div className="op-over">
          <ScrubHero />
          <HeroResolution />
          <Fears />
          <Difference />
          <Moment />
          <HowItWorks />
          <Proof />
          <Trust />
          <CloseCTA />
          <Footer />
        </div>
      </div>
    </SmoothScroll>
  );
}
