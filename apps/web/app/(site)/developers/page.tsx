/**
 * /developers — the primitive under the product, for the people who might build on it. Rebuilt on
 * the Periwinkle system and moved here from (marketing).
 *
 * Along with /how-it-works, this is a page where the technical register is on-brand (the memory
 * note: "teknik estetik sadece how-it-works/developers"). It still does not get to overclaim: the
 * API does not exist, and the copy says so in as many words.
 *
 * The GitHub link now points at the actual repository. It used to be `https://github.com/` — a
 * button labelled "View the code on GitHub" that landed you on GitHub's homepage. The real URL is
 * the one in the git remote, and README.md and EVIDENCE.md both already publish it.
 */
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Footer } from "../../../components/site/sections/Footer";
import "../../../components/site/page.css";
import "../../../components/site/editorial.css";

const PAGE_TITLE = "Developers — payouts by link";
const TITLE = `${PAGE_TITLE} — Lumenia`; // OG/Twitter keep the full branded form
const DESCRIPTION =
  "Pay someone who has nothing set up yet: no wallet, no account, no address. The code that powers Lumenia — the sponsor service, the anti-drain validator, the claim flow — is public.";

export const metadata: Metadata = {
  title: PAGE_TITLE, // the (site) layout template appends “ — Lumenia”
  description: DESCRIPTION,
  alternates: { canonical: "/developers" },
  openGraph: {
    type: "website",
    url: "/developers",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

const REPO = "https://github.com/mericcintosun/lumenia";

export default function Developers() {
  return (
    <div className="pg ed">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner">
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Developers
          </p>
          <h1 className="pg-h1">Payouts by link.</h1>
          <p className="pg-lead">
            Pay someone who has <strong>nothing set up yet</strong>: no wallet, no seed phrase, no
            account, no address. We create the account, cover the network cost, and hand them the
            money. They tap a link.
          </p>
        </div>
      </header>

      <section className="ed-body">
        {/* il-request — an open hand cupped under a periwinkle glow: the whole primitive is "someone
            holds out their hand and receives," which is exactly what a payout-by-link is. */}
        <figure className="pg-figure" style={{ marginBottom: "clamp(32px,5vh,52px)" }}>
          <div className="pg-figure-frame">
            <Image src="/brand-kit-assets/il-request.webp" alt="" fill sizes="(max-width:760px) 92vw, 700px" />
          </div>
        </figure>
        <div className="ed-prose">
          <p>
            That primitive is useful well beyond consumer transfers. Refunds, earnings, rewards, gig
            payouts — anywhere you owe money to someone who never signed up for the rails you happen
            to use.
          </p>
          <p>
            We&apos;re building toward a small API and SDK so any product can send a{" "}
            <strong>payout by link</strong>, without asking the person on the other end to make a
            wallet first.
          </p>
          <p>
            It&apos;s early, and it&apos;s open. The code that powers Lumenia is public today: the
            sponsor service, the anti-drain validator, the claim flow. Real API docs will land
            alongside the API itself. We won&apos;t publish a docs site for something that
            doesn&apos;t exist yet.
          </p>
        </div>

        <div className="ed-close">
          <p className="ed-close-p">
            The mechanism is written up in plain language on{" "}
            <Link href="/how-it-works">the audit trail</Link>, with real transactions you can open.
          </p>
          <div className="pg-cta">
            <a className="pg-btn pg-btn-primary" href={REPO} target="_blank" rel="noreferrer">
              View the code on GitHub ↗
            </a>
            <Link className="pg-btn pg-btn-ghost" href="/how-it-works">
              How it works
            </Link>
          </div>
          <p className="ed-fine">Docs come with the API.</p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
