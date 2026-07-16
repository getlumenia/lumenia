/**
 * /privacy — plain language: exactly what we hold and what we don't. Rebuilt on Periwinkle, moved
 * from (marketing). Copy carried over verbatim (honest, on-voice — not a redesign's business to
 * reword).
 */
import type { Metadata } from "next";
import { Footer } from "../../../components/site/sections/Footer";
import "../../../components/site/page.css";
import "../../../components/site/editorial.css";

const TITLE = "Privacy — Lumenia";
const DESCRIPTION = "Plain language: exactly what Lumenia holds and what it doesn't. Your money lives on a public ledger, never in a Lumenia account; your password never leaves your phone.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: {
    type: "website",
    url: "/privacy",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function Privacy() {
  return (
    <div className="pg ed">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner">
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Privacy
          </p>
          <h1 className="pg-h1">What we hold, and what we don&apos;t.</h1>
        </div>
      </header>

      <section className="ed-body">
        <div className="ed-prose">
          <p>Plain language. Here&apos;s exactly what we hold and what we don&apos;t.</p>

          <h2>What we never store</h2>
          <ul>
            <li>Your money. It lives on a public ledger, never in a Lumenia account.</li>
            <li>Your password. It never leaves your phone; we couldn&apos;t read it if we wanted to.</li>
            <li>The keys to your money in a form we can open. See below.</li>
          </ul>

          <h2>What we may store</h2>
          <ul>
            <li>
              If you choose to lock your money with a password, an <strong>encrypted backup</strong>{" "}
              of your key — scrambled with your password, which we don&apos;t have. To us it&apos;s
              meaningless noise; only your password unlocks it.
            </li>
            <li>
              If you join the waitlist or ask to be notified about cash-out, your{" "}
              <strong>email</strong> — kept on its own, never tied to your money or any account.
            </li>
            <li>Basic, non-identifying counts to see whether the product works (e.g. did a claim succeed).</li>
          </ul>

          <p>
            We don&apos;t sell your data, and we don&apos;t want to hold anything we don&apos;t need.
            This is a pilot; if any of this changes, we&apos;ll say so here plainly.
          </p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
