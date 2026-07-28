/**
 * /roadmap — the line between what works today and what is still ahead. Rebuilt on the Periwinkle
 * system and moved here from (marketing).
 *
 * The items are carried over verbatim. This page's whole job is the honesty rule (CLAUDE.md: no
 * overclaiming; keep the proven/unverified line truthful), so the copy is not the redesign's to
 * touch — and neither is the boundary it draws.
 *
 * The status reaches the reader as a LABEL, not as colour alone (WCAG 1.4.1). The dot is a second,
 * redundant channel. The old page carried the distinction in the dot only, which meant the one
 * thing this page exists to say was the one thing a colour-blind reader could not read.
 *
 * No green for "Proven" either — the standing no-brand-green rule (brand.md §4.3) holds, so the
 * accent carries what shipped.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "../../../components/site/sections/Footer";
import "../../../components/site/page.css";
import "../../../components/site/editorial.css";

const PAGE_TITLE = "Roadmap";
const TITLE = `${PAGE_TITLE} — Lumenia`; // OG/Twitter keep the full branded form
const DESCRIPTION =
  "Honest about the line between what works today and what's still ahead: what's proven, what we're building, and what comes next.";

export const metadata: Metadata = {
  title: PAGE_TITLE, // the (site) layout template appends “ — Lumenia”
  description: DESCRIPTION,
  alternates: { canonical: "/roadmap" },
  openGraph: {
    type: "website",
    url: "/roadmap",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

const GROUPS: Array<{ title: string; tone: "done" | "building" | "next"; label: string; items: string[] }> = [
  {
    title: "Proven",
    tone: "done",
    label: "Works today",
    items: [
      "Send money by a link; the recipient claims it walletless, with no app and no account.",
      "The recipient pays nothing to receive; we cover the network cost.",
      "Send money onward with a link of your own.",
      "Every transfer is publicly verifiable; unclaimed links come back after 7 days.",
    ],
  },
  {
    title: "Building",
    tone: "building",
    label: "In progress",
    items: [
      "Lock your money to you with a password (recovery on a new device).",
      "Ask someone to pay you with a link (request money).",
      "A smoother first-time experience on the cheapest phones.",
    ],
  },
  {
    title: "Next",
    tone: "next",
    label: "Not started",
    items: [
      "Turning dollars into local currency through licensed partners.",
      "Spending directly with a card.",
      "Real money, open to everyone.",
    ],
  },
];

export default function Roadmap() {
  return (
    <div className="pg ed">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner">
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Roadmap
          </p>
          <h1 className="pg-h1">What works today — and what doesn&apos;t yet.</h1>
          <p className="pg-lead">
            Most roadmaps are a wish list with the dates removed. This one draws the line instead:
            everything under <strong>Proven</strong> you can go and check right now, and everything
            below it is honest about not being real yet.
          </p>
        </div>
      </header>

      <section className="ed-body">
        <div className="ed-groups">
          {GROUPS.map((g) => (
            <div className="ed-group" data-tone={g.tone} key={g.title}>
              <div className="ed-group-head">
                <span className="ed-group-dot" aria-hidden="true" />
                <h2 className="ed-group-t">{g.title}</h2>
                {/* The label, not the dot, is what actually carries the status. */}
                <span className="ed-group-note">{g.label}</span>
              </div>
              <ul className="ed-items">
                {g.items.map((it) => (
                  <li className="ed-li" key={it}>
                    {it}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="ed-close">
          <p className="ed-close-p">
            The &ldquo;Proven&rdquo; list isn&apos;t a claim — it&apos;s a set of transactions on a
            public ledger. <Link href="/how-it-works">Open one and check it yourself.</Link>
          </p>
          <div className="pg-cta">
            <Link className="pg-btn pg-btn-primary" href="/try">
              See it work
            </Link>
            <Link className="pg-btn pg-btn-ghost" href="/waitlist">
              Join the waitlist
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
