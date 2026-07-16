/**
 * /claimed — a stateless explainer for the recipient wondering "what is this?" after they've
 * received money. Rebuilt on Periwinkle and moved into (site) from the root (it keeps the URL
 * /claimed — route groups don't change URLs — and now arrives with the group's chrome + dark theme).
 *
 * No account data, no key access — cheap and static. Vocabulary-law clean: money + people only.
 * The stale point is fixed: "pass it on (soon)" is gone — sending onward and asking for money both
 * ship now, so the point states them as real, not coming.
 *
 * robots index:false mirrors robots.ts (which disallows /claimed) — a recipient's own screen has no
 * business in a search index, and declaring index while robots refuses it is the contradiction the
 * /developers SEO trap taught us to avoid.
 */
import type { Metadata } from "next";
import { Footer } from "../../../components/site/sections/Footer";
import "../../../components/site/page.css";
import "../../../components/site/tools.css";

export const metadata: Metadata = {
  title: "You just received money — Lumenia",
  description: "You received money with Lumenia. Here's what that means.",
  robots: { index: false },
};

const POINTS: Array<{ title: string; body: string }> = [
  { title: "It's yours.", body: "Once you've claimed it, it's yours to keep — nobody can take it back." },
  { title: "It's held in dollars.", body: "The amount doesn't melt away or wobble. Hold it as long as you like." },
  { title: "No app, no account.", body: "You claimed it right in your browser — nothing to install." },
  { title: "You can pass it on.", body: "Send money onward with a link of your own, or ask someone to pay you — the same way this reached you." },
];

export default function Claimed() {
  return (
    <div className="pg">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner" style={{ maxWidth: "640px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            You received money
          </p>
          <h1 className="pg-h1">You just received money.</h1>
          <p className="pg-lead">Here&apos;s what that means.</p>
        </div>
      </header>

      <section className="tool-body">
        <div className="tool-inner">
          <div className="tool-rows">
            {POINTS.map((p) => (
              <div key={p.title} className="tool-row">
                <p className="tool-row-name">{p.title}</p>
                <p className="tool-row-note">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
