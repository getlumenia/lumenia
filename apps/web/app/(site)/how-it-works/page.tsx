/**
 * /how-it-works — THE trust page, and the ONLY surface allowed to name the tech (CLAUDE.md,
 * brand.md §3): Stellar, USDC, Claimable Balances, sponsored reserves, the explorer. It also
 * serves grant reviewers and partners, so the register is technical on purpose — this is the one
 * page where the numerals and parameter chips banned on consumer sections are on-brand.
 *
 * Rebuilt on the Periwinkle system and moved here from (marketing), which is still on the retired
 * warm-paper chrome. Route groups don't affect URLs, so the page kept /how-it-works and simply
 * arrived with the right chrome (SiteNav, the theme, Sentient + Switzer) already around it.
 *
 * No mock data: both transaction hashes below are real, resolve on stellar.expert, and are the
 * same ones the landing's proof strip and EVIDENCE.md cite.
 */
import type { Metadata } from "next";
import Link from "next/link";
import SmoothScroll from "../../../components/brand/SmoothScroll";
import { AmbientVideo } from "../../../components/site/AmbientVideo";
import { SectionReveal } from "../../../components/site/sections/SectionReveal";
import { Footer } from "../../../components/site/sections/Footer";
import { Beats } from "./Beats";
import "../../../components/site/page.css";
import "./how-it-works.css";

const PAGE_TITLE = "How it works: the audit trail";
const TITLE = `${PAGE_TITLE} | Lumenia`; // OG/Twitter keep the full branded form
const DESCRIPTION =
  "The honest, technical account: how a walletless claim works, why the recipient pays no gas, and how to verify a real transfer yourself.";

export const metadata: Metadata = {
  title: PAGE_TITLE, // the (site) layout template appends “ | Lumenia”
  description: DESCRIPTION,
  alternates: { canonical: "/how-it-works" },
  openGraph: {
    type: "article",
    url: "/how-it-works",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

// Testnet, pinned: each hash below is a specific historical transaction that lives there.
const explorer = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
/** The full hash is 64 chars and wraps to three lines on a phone; the ends are what you compare. */
const short = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-8)}`;

/** Real, publicly-verifiable Stellar transfers (EVIDENCE.md / HANDOFF). */
const PROOFS = [
  {
    hash: "b9ef1844c6ca2df732648b965a2f991ba0197643057b2c9e2a60ab52c3e23746",
    what: "A walletless claim: 20 USDC landed in a brand-new account that holds 0 XLM.",
  },
  {
    hash: "fe528fe145018ea7d05c4028f01c155025535054b9a674c0df3a4aa03f6de43c",
    what: "A second claim, produced by the automated end-to-end check that runs against every deploy.",
  },
];

export default function HowItWorks() {
  return (
    <SmoothScroll>
      <div className="pg">
        {/* Nothing in the hero fades in: Chrome will not make an element an LCP candidate if its
            content paints at opacity 0, and never reconsiders once it does. */}
        <header className="pg-hero pg-glow hw-hero">
          <div className="hw-hero-inner">
            <div className="hw-hero-copy">
              <p className="pg-eyebrow">
                <span className="pg-dot" aria-hidden="true" />
                The audit trail
              </p>
              <h1 className="pg-h1">How it works, and how to check it.</h1>
              <p className="pg-lead">
                Everywhere else on this site we talk about money and people. Here we name the
                technology, because <strong>a non-custodial claim is only worth something if a
                skeptic can verify it</strong>. Nothing below is a mockup. Every claim on this page
                resolves to a real transaction you can open yourself.
              </p>
            </div>
            {/* Empty on purpose: the ribbon is painted by CSS, from inside a min-width:1024 media
                query, so phones never download an illustration they cannot see and /demo never
                downloads this one just because it links here. See how-it-works.css. */}
            <div className="hw-hero-il" aria-hidden="true" />
          </div>
        </header>

        <Beats />

        {/* The ONE strip where the chain is named with pride, on brand.md §4.4's Stellar-dark
            pairing. `iris` is SectionReveal's dramatic entrance, reserved for exactly this. */}
        <SectionReveal kind="iris">
          <section className="hw-proof" aria-labelledby="hw-proof-h">
            {/* The brand kit's own dark aurora, catalogued at /brand-kit/assets as "the
                Stellar/proof strip" — made for this surface and never wired up until now. The
                poster ships to phones and the loop only mounts from 641px (AmbientVideo). */}
            <AmbientVideo
              className="hw-proof-bg"
              poster="/brand-kit-assets/bg-howitworks.webp"
              sources={["/brand-kit-assets/video/bg-howitworks.webm", "/brand-kit-assets/video/bg-howitworks.mp4"]}
            />
            <div className="hw-proof-scrim" aria-hidden="true" />
            <div className="hw-proof-inner">
              <p className="hw-proof-eyebrow">Proof, not promises</p>
              <h2 id="hw-proof-h" className="hw-proof-h">
                Open one and check it yourself.
              </h2>
              <p className="hw-proof-p">
                Every claim writes a transaction to the public ledger, one we can&apos;t hide or
                quietly change. So don&apos;t take the four paragraphs above on trust. Here are two
                real ones. Open either, and look at what landed and in whose account.
              </p>

              <ul className="hw-receipts">
                {PROOFS.map((p) => (
                  <li className="hw-receipts-item" key={p.hash}>
                    <a className="hw-receipt" href={explorer(p.hash)} target="_blank" rel="noreferrer">
                      <div className="hw-rc-top">
                        <span className="hw-rc-label">Public receipt</span>
                        <span className="hw-rc-net">Stellar</span>
                      </div>
                      <p className="hw-rc-what">{p.what}</p>
                      <div className="hw-rc-hash">
                        <span className="hw-rc-k">tx</span>
                        <span className="hw-rc-v">{short(p.hash)}</span>
                      </div>
                      <span className="hw-rc-cta">
                        Verify on Stellar <span className="hw-rc-arrow" aria-hidden="true">→</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>

              <div className="hw-proof-foot">
                <p className="hw-proof-note">
                  These are <strong>real, publicly verifiable Stellar transfers</strong>. Open either
                  one and check it yourself. This is exactly the mechanism that moves your money.
                </p>
                <span className="hw-seal">
                  <span className="hw-seal-star" aria-hidden="true" />
                  Backed by the Stellar Community Fund
                </span>
              </div>
            </div>
          </section>
        </SectionReveal>

        {/* No reveal here, and this one is measured rather than a matter of taste: wrapped in a
            dissolve the CTA sat at opacity .45 until scrolled to, and Lighthouse failed both buttons
            on colour contrast (a11y 96). The conversion moment is never dimmed. */}
        <section className="hw-close">
          <div className="hw-close-inner">
            <h2 className="hw-close-h">Watch it happen, end to end.</h2>
            <p className="hw-close-p">
              It runs the exact same code. A real link, a real claim, and a
              transaction you can open at the end of it. We target about 30 seconds.
            </p>
            <div className="pg-cta">
              <Link className="pg-btn pg-btn-primary" href="/try">
                See it work
              </Link>
              <Link className="pg-btn pg-btn-ghost" href="/developers">
                Developer notes
              </Link>
            </div>
          </div>
        </section>

        <Footer />
      </div>
    </SmoothScroll>
  );
}
