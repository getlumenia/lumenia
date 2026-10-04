/**
 * /extension: the one place to install Lumenia for your browser (apps/extension). The footer, the
 * app's settings and the sitemap all point here, so this is where the extension and the site meet.
 *
 * Short on purpose: what it does, the two install buttons, three steps, one honest line. It is a
 * CONSUMER surface (brand.md section 8): no numerals, no mono rails, nothing that looks like code. The
 * messenger is the hero because it is also the first thing the extension shows when it opens, so
 * the page and the popup start on the same beat.
 *
 * A button is a link only once its listing exists. Neither does yet, so by default both render
 * disabled with a plain line saying so. The addresses come from lib/extension-install.ts, the one
 * source for them, and nothing here guesses one.
 */
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Mascot } from "../../../components/brand/Mascot";
import { Footer } from "../../../components/site/sections/Footer";
import { extensionInstallLinks } from "../../../lib/extension-install";
import "../../../components/site/page.css";
import "./extension.css";

// The name already carries the brand, so it opts out of the group's " | Lumenia" template, as the
// landing does, rather than reading "Lumenia for your browser | Lumenia".
const TITLE = "Lumenia for your browser";
const DESCRIPTION =
  "Send money from any page. Make a payment link without leaving the chat you're in. The person you send it to needs no app and pays no gas.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/extension" },
  openGraph: {
    type: "website",
    url: "/extension",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

/** In the extension's own words: "Get started" and the menu item are what the person will see. */
const STEPS: Array<{ key: string; t: ReactNode; b: string }> = [
  { key: "add", t: "Add it to your browser.", b: "Chrome or Firefox, on your computer." },
  {
    key: "open",
    // The button's name stays on one line: broken as "Get / started." it reads as two words.
    t: (
      <>
        Open it and tap <span className="ex-keep">Get started</span>.
      </>
    ),
    b: "Make an account there, or bring the Lumenia account you already have.",
  },
  { key: "paste", t: "Right-click any text box.", b: "Choose \"Paste a Lumenia link here\". It only types the link. You press Send." },
];

/**
 * One install button. With no listing to send anyone to, it is a disabled button rather than a link
 * to nowhere, and the line under it says why. A plain <a> when live, not next/link: the Firefox
 * target is a file that Firefox installs, not a route to navigate to.
 */
function Install({ id, label, href, pending, primary }: { id: string; label: string; href: string | null; pending: string; primary: boolean }) {
  const cls = `pg-btn ${primary ? "pg-btn-primary" : "pg-btn-ghost"}`;
  if (href) {
    return (
      <div className="ex-install">
        <a className={cls} href={href}>
          {label}
        </a>
      </div>
    );
  }
  return (
    <div className="ex-install">
      <button type="button" className={cls} disabled aria-describedby={id}>
        {label}
      </button>
      <p id={id} className="ex-status">
        {pending}
      </p>
    </div>
  );
}

export default function ExtensionPage() {
  const links = extensionInstallLinks();
  return (
    <div className="pg">
      {/* Nothing in the hero fades in: Chrome will not make an element an LCP candidate if its
          content paints at opacity 0, and never reconsiders once it does. The messenger's own
          arrival moves it, it does not fade it. */}
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner ex-hero-inner">
          <div className="ex-hero-copy">
            <p className="pg-eyebrow">
              <span className="pg-dot" aria-hidden="true" />
              For your browser
            </p>
            <h1 className="pg-h1">Send money from any page.</h1>
            <p className="pg-lead">
              Make a payment link without leaving the chat you&apos;re in. The person you send it to
              needs no app and pays no gas.
            </p>
            <div className="ex-installs">
              <Install id="ex-chrome" label="Add to Chrome" href={links.chrome} pending="Coming to Chrome soon." primary />
              <Install id="ex-firefox" label="Add to Firefox" href={links.firefox} pending="Coming to Firefox soon." primary={false} />
            </div>
          </div>
          <div className="ex-hero-art">
            <Mascot pose="messenger" size="hero" priority />
          </div>
        </div>
      </header>

      <section className="ex-steps" aria-labelledby="ex-steps-h">
        <div className="ex-steps-inner">
          <h2 id="ex-steps-h" className="ex-steps-h">
            Three steps to your first link.
          </h2>
          <ol className="ex-steps-list">
            {STEPS.map((s) => (
              <li className="ex-step" key={s.key}>
                <h3 className="ex-step-t">{s.t}</h3>
                <p className="ex-step-b">{s.b}</p>
              </li>
            ))}
          </ol>
          <div className="ex-close">
            <p>
              It starts on practice money. Real money is invite-only for now.{" "}
              <Link href="/privacy#extension">What it sends, what it keeps, and what it never collects.</Link>
            </p>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
