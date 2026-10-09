/**
 * /extension: the one place to install Lumenia for your browser (apps/extension). The footer, the
 * app's settings and the sitemap all point here, so this is where the extension and the site meet.
 *
 * Short on purpose: what it does, the two install buttons, three steps, one honest line. It is a
 * CONSUMER surface (brand.md section 8): no numerals, no mono rails, nothing that looks like code. The
 * messenger is the hero because it is also the first thing the extension shows when it opens, so
 * the page and the popup start on the same beat.
 *
 * Both stores list it publicly (the Chrome Web Store and addons.mozilla.org, checked 2026-10-09), so
 * both buttons are links, and nothing here says "coming soon". The addresses come from
 * lib/extension-install.ts: "Add to Chrome" is NEXT_PUBLIC_EXTENSION_CHROME_URL, or the public listing
 * when it is unset; "Add to Firefox" is NEXT_PUBLIC_EXTENSION_FIREFOX_URL (the AMO listing, where
 * updates come from), and only when that is unset the AMO-signed file committed at
 * public/extension/lumenia-firefox.xpi (served as application/x-xpinstall by next.config.ts), and
 * failing that the AMO listing itself. Both values are read at build time: the page is static.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Mascot } from "../../../components/brand/Mascot";
import { Footer } from "../../../components/site/sections/Footer";
import { AMO_LISTING_URL, extensionInstallLinks } from "../../../lib/extension-install";
import { realMoneyOpen } from "../../../lib/real-money";
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
 * One install button. A plain <a>, not next/link: the Firefox target may be a file that Firefox
 * installs, and a store page is another site, neither a route to navigate to.
 */
function Install({ label, href, primary }: { label: string; href: string; primary: boolean }) {
  const cls = `pg-btn ${primary ? "pg-btn-primary" : "pg-btn-ghost"}`;
  return (
    <div className="ex-install">
      <a className={cls} href={href}>
        {label}
      </a>
    </div>
  );
}

/** The signed Firefox add-on, self-hosted. Read at build time: the page is static. */
const HOSTED_XPI = "/extension/lumenia-firefox.xpi";
const hostedXpi = (): string | null => (existsSync(path.join(process.cwd(), "public", HOSTED_XPI)) ? HOSTED_XPI : null);

export default function ExtensionPage() {
  const env = extensionInstallLinks();
  const links = { chrome: env.chrome, firefox: env.firefox ?? hostedXpi() ?? AMO_LISTING_URL };
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
              <Install label="Add to Chrome" href={links.chrome} primary />
              <Install label="Add to Firefox" href={links.firefox} primary={false} />
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
              It starts on practice money.{" "}
              {realMoneyOpen() ? "Real money is open to everyone." : "Real money is invite-only for now."}{" "}
              <Link href="/privacy#extension">What it sends, what it keeps, and what it never collects.</Link>
            </p>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
