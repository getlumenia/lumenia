/**
 * /about — why this exists, in plain words. Rebuilt on the Periwinkle system and moved here from
 * (marketing).
 *
 * The prose is carried over verbatim: it is honest, it is on-voice (brand.md §7 — name the fear,
 * then kill it; no hype), and it says exactly what is and is not true today. Rewriting it would
 * have been a redesign inventing new claims, which is not what this job is.
 */
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Footer } from "../../../components/site/sections/Footer";
import "../../../components/site/page.css";
import "../../../components/site/editorial.css";

const PAGE_TITLE = "About";
const TITLE = `${PAGE_TITLE} — Lumenia`; // OG/Twitter keep the full branded form
const DESCRIPTION =
  "Sending money home shouldn't require the people you love to become tech people. Lumenia is a simple idea taken seriously: send money with a link, and let the person receiving it do nothing but tap.";

export const metadata: Metadata = {
  title: PAGE_TITLE, // the (site) layout template appends “ — Lumenia”
  description: DESCRIPTION,
  alternates: { canonical: "/about" },
  openGraph: {
    type: "website",
    url: "/about",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function About() {
  return (
    <div className="pg ed">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner">
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            About
          </p>
          {/* The same line the footer signs off with. It is the company's whole position in six
              words, so it is the headline here rather than a heading that says "About". */}
          <h1 className="pg-h1">Your money is never ours. That&apos;s the point.</h1>
        </div>
      </header>

      <section className="ed-body">
        {/* il-home — "cozy home, golden hour, the phone glowing on the side table": money reaching
            home is the company's whole thesis ("Money home, in a link"), so /about opens on it. */}
        <figure className="pg-figure" style={{ marginBottom: "clamp(32px,5vh,52px)" }}>
          <div className="pg-figure-frame">
            <Image src="/brand-kit-assets/il-home.webp" alt="" fill sizes="(max-width:760px) 92vw, 700px" />
          </div>
        </figure>
        <div className="ed-prose">
          <p>
            You send money home, and it should arrive whole. The people you love shouldn&apos;t have
            to become tech people to receive it. Today the system taxes the sender&apos;s money and
            the recipient&apos;s dignity: app installs, ID selfies, queues. We think that&apos;s
            backwards.
          </p>
          <p>
            Lumenia is a simple idea taken seriously: send money with a link, and let the person
            receiving it do nothing but tap. No app, no account, no wallet, nothing to pay to
            receive. The money waits in escrow, never in our hands, so we can&apos;t lend it or lose
            it.
          </p>
          <p>
            We build in the open and say plainly what&apos;s proven and what isn&apos;t. Right now
            Lumenia is a <strong>pilot on a test network</strong>; turning dollars into local
            currency will come through licensed partners, when it&apos;s genuinely reliable.
          </p>
          <p>
            It&apos;s built by a small team in the Stellar Türkiye community, for the corridor we
            know: people in Europe sending money home.
          </p>
        </div>

        <div className="ed-close">
          <p className="ed-close-p">
            We&apos;d rather show you than tell you. The demo mints a real link on the test network,
            and <Link href="/how-it-works">the audit trail</Link> is where a skeptic can check every
            word above.
          </p>
          <div className="pg-cta">
            <Link className="pg-btn pg-btn-primary" href="/demo">
              Try the live demo
            </Link>
            <Link className="pg-btn pg-btn-ghost" href="/roadmap">
              What&apos;s next
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
