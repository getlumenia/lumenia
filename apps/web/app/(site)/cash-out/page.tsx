/**
 * /cash-out — the honest cash-out GUIDE (built per the analyst/PM roundtable).
 *
 * WHY it exists: Lumenia does not run an off-ramp, and on Stellar there is no TRY
 * anchor today (even BiLira's TRYB left Stellar). So instead of dumping a recipient
 * with a raw address and "go figure it out", this page is honest HELP: it says the
 * dollars are valuable held as-is (dollarization), and — when someone wants local
 * money — describes the real path and, above all, the wrong-network warning that
 * saves people from losing funds. It is CONTENT, not integration: Lumenia has no
 * in-app "send to an exchange" flow, so this describes the path honestly rather
 * than claiming a one-tap feature it doesn't have.
 *
 * VOCABULARY: this is a sanctioned tech-help surface (like /how-it-works). The
 * consumer framing (hold dollars, local money, your bank) stays plain; the named
 * tools (a licensed exchange, "the network the dollars travel on") appear only in
 * the steps, where naming them is the honest, money-saving thing to do.
 */
import type { Metadata } from "next";
import { Footer } from "../../../components/site/sections/Footer";
import { EmailCapture } from "../../../components/site/EmailCapture";
import "../../../components/site/page.css";
import "./cashout.css";

const PAGE_TITLE = "Turning dollars into lira";
const TITLE = `${PAGE_TITLE} — Lumenia`;
const DESCRIPTION =
  "You're holding real dollars — you don't have to cash out. When you want Turkish lira in your bank, here's the honest path, what to watch for, and the one mistake that loses money.";

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/cash-out" },
  openGraph: {
    type: "website",
    url: "/cash-out",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function CashOut() {
  return (
    <div className="pg">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner" style={{ maxWidth: "640px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Turning it into cash
          </p>
          <h1 className="pg-h1">You&apos;re holding dollars. That&apos;s the point.</h1>
          <p className="pg-lead">
            When your local money loses value, holding dollars <strong>is</strong> the win — a lot of
            people keep them exactly as they are. So you don&apos;t have to cash out. But when you
            want Turkish lira in your bank, here&apos;s the honest path, and the one mistake to avoid.
          </p>
        </div>
      </header>

      <section className="co-body">
        <div className="co-inner">
          {/* 1 — you don't have to */}
          <div className="co-block">
            <h2>You don&apos;t have to cash out</h2>
            <p>
              Your dollars sit safely, ready to send onward with a link whenever you want. In a place
              where prices climb month to month, keeping money in dollars is protection, not a
              chore. Cash out only when you actually need local money in hand.
            </p>
          </div>

          {/* 2 — the honest path (this is the tech-help part) */}
          <div className="co-block">
            <h2>When you want lira, here&apos;s how it works</h2>
            <p>
              Lumenia doesn&apos;t turn dollars into lira itself — a <strong>licensed exchange</strong>{" "}
              does. In Turkey the confirmed path today is <strong>Binance TR</strong>:
            </p>
            <ol className="co-steps">
              <li>Move your dollars from Lumenia to your account on the exchange.</li>
              <li>On the exchange, sell your dollars for Turkish lira.</li>
              <li>Withdraw the lira to your own bank account — fast, and usually free.</li>
            </ol>
            <div className="co-warn" style={{ marginTop: "14px" }}>
              {/* explicit {" "} — JSX eats the trailing space after </strong> (SITE_REDESIGN §5) */}
              <strong>The one mistake that loses money:</strong>{" "}when the dollars move to the
              exchange, you pick the network they travel on. It must be the same network on both
              sides. Send on the wrong one and the money is gone for good — there is no undo. If
              you&apos;re unsure, move a small amount first.
            </div>
          </div>

          {/* 3 — honest caveats */}
          <div className="co-block">
            <h2>What to expect</h2>
            <ul className="co-caveats">
              <li><strong>An ID check.</strong> By law, the exchange verifies who you are before it pays out.</li>
              <li><strong>Limits and a first-time wait.</strong> There are daily caps, and a first withdrawal can be held for up to ~72 hours.</li>
              <li><strong>Your own bank only.</strong> You can send lira to a bank account in your own name.</li>
              <li><strong>Lumenia takes nothing.</strong> We don&apos;t run this step and charge no fee for it; the exchange has its own small fees.</li>
            </ul>
          </div>

          {/* 4 — cleaner elsewhere (the one-line global story) */}
          <div className="co-elsewhere">
            In many countries this is already smoother: through <strong>MoneyGram</strong>, dollars
            held on Lumenia&apos;s rails can be picked up as cash at physical locations in 180+
            markets. Turkey isn&apos;t one of the easy ones yet — which is exactly what we&apos;re
            working to change.
          </div>

          {/* 5 — a smoother way is coming */}
          <div className="co-capture">
            <p className="co-capture-lead">
              We&apos;re building a smoother way to reach local cash, and we won&apos;t promise a date
              we can&apos;t keep. Want to know the moment it&apos;s ready?
            </p>
            <EmailCapture list="cashout" cta="Notify me" />
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
