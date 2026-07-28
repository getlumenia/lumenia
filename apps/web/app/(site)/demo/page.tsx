/**
 * /demo — the product's best salesman is the claim page itself (FRONTEND_PLAN §1b). One tap mints
 * a REAL testnet claim link and drops the visitor straight onto the claim screen to meet the hero
 * moment alone. Real on-chain data — no fiction.
 *
 * Rebuilt on the Periwinkle system and moved here from (marketing). This is the landing's CTA
 * target, so it has to feel like the next frame of it rather than a different site: the same hero
 * shape as /how-it-works, and the three steps below are the landing's own how-it-works beats
 * ("You send a link · They tap it · It's theirs") retold in the second person, because here YOU are
 * the recipient.
 *
 * REGISTER: this is a CONSUMER surface, so brand.md §8 applies in full — no numerals, no mono rails,
 * no parameter chips. /how-it-works earns those by being the one page that names the technology;
 * this page does not get them. The only tech word here is "test network", which the house treats as
 * an honesty term (see TestnetBanner), and the "no wallet, no signup, no gas" subtraction line,
 * which is the landing's CloseCTA promise repeated verbatim — it names what you DON'T need.
 *
 * NO ANALYTICS, deliberately: there is no demo event in lib/events.ts's allowlist, and adding one
 * client-side without the matching entry in the sponsor's ALLOWED_EVENTS is exactly the silent-drop
 * drift that file documents. The funnel's id-space problem is the owner's call (SITE_REDESIGN §8).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { AmbientVideo } from "../../../components/site/AmbientVideo";
import { Footer } from "../../../components/site/sections/Footer";
import { MintButton } from "./MintButton";
import "../../../components/site/page.css";
import "./demo.css";

const PAGE_TITLE = "See it work: send yourself a link";
const TITLE = `${PAGE_TITLE} — Lumenia`; // OG/Twitter keep the full branded form
const DESCRIPTION =
  "Tap once and we'll send you a real money link on the test network — the exact thing your recipient would get. Claim it in your browser, no wallet and no signup.";

export const metadata: Metadata = {
  title: PAGE_TITLE, // the (site) layout template appends “ — Lumenia”
  description: DESCRIPTION,
  alternates: { canonical: "/demo" },
  openGraph: {
    type: "website",
    url: "/demo",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

/** The landing's three beats, in the second person — you are the recipient this time. */
const STEPS = [
  {
    t: "We make you a link.",
    b: "The same link a real sender would create, made the moment you tap. Nothing here is staged for you.",
  },
  {
    t: "You tap it.",
    b: "You land on the screen your recipient would see. The money is already waiting there, before you set anything up.",
  },
  {
    t: "It's yours.",
    b: "Claim it with a password you choose, and check it on the public record afterwards. No wallet, no signup, no gas.",
  },
];

export default function Demo() {
  return (
    <div className="pg">
      {/* Nothing in the hero fades in: Chrome will not make an element an LCP candidate if its
          content paints at opacity 0, and never reconsiders once it does. */}
      <header className="pg-hero dm-hero">
        {/* The living lavender drift the landing uses under its own paper sections. AmbientVideo
            keeps the loop off phones (poster only) — the gate cannot be done in CSS. */}
        <AmbientVideo
          className="dm-hero-bg"
          poster="/brand-kit-assets/bg-soft.webp"
          sources={["/brand-kit-assets/video/bg-soft.webm", "/brand-kit-assets/video/bg-soft.mp4"]}
        />
        <div className="dm-hero-scrim" aria-hidden="true" />
        <div className="dm-hero-inner">
          <div className="dm-hero-copy">
            <p className="pg-eyebrow">
              <span className="pg-dot" aria-hidden="true" />
              The live demo
            </p>
            <h1 className="pg-h1">Send yourself money.</h1>
            <p className="pg-lead">
              Tap once and we&apos;ll send <strong>you</strong> a real money link — the exact thing
              your recipient would get. See the money. Claim it right here in your browser, then
              check it on the public record afterwards. We target about 30 seconds.
            </p>
            <MintButton />
            <p className="dm-note">
              Lumenia is in <strong>pilot on a test network</strong> — real technology, test money.
              Nothing you claim here is worth anything.
            </p>
          </div>
          {/* The brand's own soft-3D tap — the same illustration the landing's how-it-works story
              uses for "They tap it.", which is exactly the moment this page is selling. Empty on
              purpose: CSS paints it, from inside a min-width:1024 media query, so phones never
              download it and /how-it-works never does either just because it links here. */}
          <div className="dm-il" aria-hidden="true" />
        </div>
      </header>

      <section className="dm-steps" aria-labelledby="dm-steps-h">
        <div className="dm-steps-inner">
          <h2 id="dm-steps-h" className="dm-steps-h">
            What&apos;s about to happen.
          </h2>
          <div className="dm-steps-grid">
            {STEPS.map((s) => (
              <div className="dm-step" key={s.t}>
                <h3 className="dm-step-t">{s.t}</h3>
                <p className="dm-step-b">{s.b}</p>
              </div>
            ))}
          </div>
          <p className="dm-steps-foot">
            Want the technical account first?{" "}
            <Link href="/how-it-works">See how it works, and how to check it.</Link>
          </p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
