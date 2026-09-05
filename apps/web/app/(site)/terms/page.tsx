/**
 * /terms — the short, honest version; a full legal document comes with launch. Rebuilt on
 * Periwinkle, moved from (marketing).
 *
 * CORRECTED 2026-09-06. This page used to open with "the money here isn't real", which was
 * written when everything was on the test network and stayed after a capped mainnet pilot began
 * moving actual dollars. Pilot participants were reading it while holding real money. It now
 * names both kinds, says which is which, and states the three things a reader most needs: we take
 * no custody, we touch no cash, and the step into local currency is theirs at a licensed provider.
 */
import type { Metadata } from "next";
import { Footer } from "../../../components/site/sections/Footer";
import "../../../components/site/page.css";
import "../../../components/site/editorial.css";

const PAGE_TITLE = "Terms";
const TITLE = `${PAGE_TITLE} | Lumenia`; // OG/Twitter keep the full branded form
const DESCRIPTION = "The short, honest version: practice money and real money, not a bank, money on a public ledger, a link is like cash, and your password is yours alone.";

export const metadata: Metadata = {
  title: PAGE_TITLE, // the (site) layout template appends “ | Lumenia”
  description: DESCRIPTION,
  alternates: { canonical: "/terms" },
  openGraph: {
    type: "website",
    url: "/terms",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function Terms() {
  return (
    <div className="pg ed">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner">
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Terms
          </p>
          <h1 className="pg-h1">The short, honest version.</h1>
        </div>
      </header>

      <section className="ed-body">
        <div className="ed-prose">
          <p>The short, honest version. A full legal document comes with launch.</p>
          <p>
            <strong>Two kinds of money live here, and the difference matters.</strong> Practice money
            is free, has no value, and exists only to show how receiving works. Real money is real:
            a small, invited pilot moves actual dollars, capped at $5 a transfer and $50 a day. The
            app tells you which one you are looking at, every time. If you were not invited to the
            pilot, everything you see is practice.
          </p>
          <p>
            <strong>We are not a bank or a money-transfer business.</strong> Lumenia doesn&apos;t hold
            your money and cannot move it. It sits on a public ledger, released by a signature only
            you or the person holding your link can make. We provide the software that sets up
            accounts and covers network costs. We never take custody, we never touch cash or bank
            transfers, and we charge nothing.
          </p>
          <p>
            <strong>A money link is like cash.</strong> Whoever holds the link can claim it. Keep it
            private and share it only with the person it&apos;s for. Once claimed, it&apos;s claimed.
          </p>
          <p>
            <strong>Your password is yours alone.</strong> If you lock your money with a password and
            forget it, nobody can recover it, Lumenia included.
          </p>
          <p>
            <strong>Getting dollars out is your own step.</strong> Turning dollars into your local
            currency happens at a licensed exchange or provider you choose and hold an account with.
            Lumenia does not do it for you, is not their agent, and never receives your local
            currency. Their rules, limits and waiting periods are theirs, not ours.
          </p>
          <p>
            <strong>No guarantees yet.</strong> We build carefully and verify in public, but this is
            early software, provided as-is. It has not been reviewed by an outside security firm.
          </p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
