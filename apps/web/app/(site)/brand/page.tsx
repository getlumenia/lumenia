/**
 * /brand — press kit + the basics for writing about us. Rebuilt on Periwinkle, moved from
 * (marketing).
 *
 * This page RESOLVES the palette contradiction SITE_REDESIGN §2/§7.6 flagged: the retired warm-paper
 * version presented "Money green #1E7A52" + warm-paper ground as canonical, while /brand-kit showed
 * Periwinkle. Periwinkle is the LOCKED system (brand.md §4), so the swatches below are the --pw-*
 * tokens — the ones every (site) page actually renders — and the "Design" note carries the real
 * concept ("Nothing to set up"), not the retired "warm paper, serious money" line.
 */
import type { Metadata } from "next";
import { Footer } from "../../../components/site/sections/Footer";
import "../../../components/site/page.css";
import "../../../components/site/tools.css";

const TITLE = "Brand — Lumenia";
const DESCRIPTION = "A press kit and the basics for writing about us: the name, the Periwinkle palette, the design concept, and boilerplate.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/brand" },
  openGraph: {
    type: "website",
    url: "/brand",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

// The LOCKED Periwinkle palette (brand.md §4.1) — the light tokens every (site) page renders.
const COLORS: Array<{ name: string; value: string; use: string }> = [
  { name: "Paper", value: "#F5F3EF", use: "page ground — warm off-white" },
  { name: "Surface", value: "#FBFAF8", use: "raised cards" },
  { name: "Ink", value: "#1E1B22", use: "primary text" },
  { name: "Muted", value: "#67626E", use: "secondary text" },
  { name: "Periwinkle", value: "#6E5FCE", use: "actions, links, the moment money arrives" },
  { name: "Danger", value: "#C4362B", use: "errors only, never decorative" },
];

export default function Brand() {
  return (
    <div className="pg">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner" style={{ maxWidth: "760px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Brand
          </p>
          <h1 className="pg-h1">Writing about us.</h1>
          <p className="pg-lead">A press kit and the basics — the name, the colours, the idea.</p>
        </div>
      </header>

      <section className="tool-body">
        <div className="tool-inner" style={{ maxWidth: "760px" }}>
          <h2 className="brand-h2">Name</h2>
          <p className="brand-p">
            It&apos;s <strong>Lumenia</strong> — one word, capital L. Not &quot;Luminia&quot;, not
            &quot;Lumeria&quot;.
          </p>

          <h2 className="brand-h2">Colours</h2>
          <div className="brand-swatches">
            {COLORS.map((c) => (
              <div key={c.name} className="brand-swatch">
                <span className="brand-chip" style={{ background: c.value }} />
                <div>
                  <p className="brand-swatch-name">
                    {c.name} <span className="brand-hex">{c.value}</span>
                  </p>
                  <p className="brand-swatch-use">{c.use}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="tool-fine">
            Warm off-white ground, one periwinkle accent — a nod to Stellar&apos;s lavender, warmed so
            it reads friendly, never crypto. Dark mode is a system-aware alternate.
          </p>

          <h2 className="brand-h2">Design</h2>
          <p className="brand-p">
            The idea is <strong>&quot;nothing to set up.&quot;</strong> We&apos;re defined by what we
            remove — no wallet, no seed phrase, no app, no gas — until only one thing is left: tap the
            link. Calm, plain and warm; we take fear away instead of hyping. Type is a warm serif
            paired with a clean humanist sans — the fastest signal that this is for people, not for
            crypto.
          </p>

          <h2 className="brand-h2">Boilerplate</h2>
          <p className="brand-box">
            Lumenia lets you send money to anyone in Turkey with a link. The recipient taps it and
            it&apos;s theirs — no app, no account, no wallet, and nothing to pay to receive. The money
            waits in escrow on a public ledger, never in Lumenia&apos;s hands. Currently a pilot on a
            test network.
          </p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
