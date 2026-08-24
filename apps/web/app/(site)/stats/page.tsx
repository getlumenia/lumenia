/**
 * /stats — live numbers, read straight off the public ledger (lib/stats.ts),
 * aggregated SERVER-SIDE so no recipient address ever reaches the client. This is
 * a proof-of-liveness page, NOT a traction claim: the honesty rule (and the
 * project's own north-star note that a raw account count is sybil-gameable) means
 * we frame these as "what the system has done", never as a user count we can't
 * prove. Real data only; on an upstream hiccup it shows an
 * honest "refreshing" state, never fabricated zeros.
 *
 * Vocabulary law: this lives in (site), not /how-it-works, so labels stay in
 * money-and-people language (no wallet/crypto/USDC/Stellar/gas). "Public record"
 * is approved.
 */
import type { Metadata } from "next";
import { Footer } from "../../../components/site/sections/Footer";
import { loadStats } from "../../../lib/stats";
import "../../../components/site/page.css";
import "./stats.css";

const PAGE_TITLE = "Live numbers";
const TITLE = `${PAGE_TITLE} | Lumenia`;
const DESCRIPTION =
  "Real, verifiable numbers read straight from the public record: accounts created and payment links sent so far.";

// Re-read the ledger at most once every 5 minutes, regardless of traffic.
export const revalidate = 300;

export const metadata: Metadata = {
  title: PAGE_TITLE, // the (site) layout template appends “ | Lumenia”
  description: DESCRIPTION,
  alternates: { canonical: "/stats" },
  openGraph: {
    type: "website",
    url: "/stats",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

const nf = new Intl.NumberFormat("en-US");

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return "moments ago";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default async function StatsPage() {
  const { real, practice } = await loadStats();
  const nothingYet = real === null && practice === null;

  return (
    <div className="pg">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner" style={{ maxWidth: "620px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Live from the public record
          </p>
          <h1 className="pg-h1">Read off the record, not typed in.</h1>
          <p className="pg-lead">
            Two sets of numbers, kept apart: what has moved in{" "}<strong>real money</strong>, and
            what has moved in{" "}<strong>practice</strong>. They are never added together, because
            they are not the same thing. Open any transfer and check it yourself.
          </p>
        </div>
      </header>

      <section className="stat-body">
        <div className="stat-inner">
          {nothingYet ? (
            <p className="stat-refreshing">
              The live numbers are refreshing. Check back in a moment. We only show what we can read
              from the public record, so this space stays empty rather than guessing.
            </p>
          ) : (
            <>
              <h2 className="stat-section-h">Real money</h2>
              <p className="stat-section-sub">
                Actual dollars, on the main public record. This is a small, capped pilot — the
                numbers are meant to be checkable, not impressive.
              </p>
              {real === null ? (
                <p className="stat-refreshing">Refreshing the real-money numbers.</p>
              ) : (
                <div className="stat-grid">
                  <div className="stat-tile">
                    <span className="stat-num stat-num-accent">{nf.format(real.accountsCreated)}</span>
                    <span className="stat-label">Accounts created</span>
                    <span className="stat-sub">funded by the system, no setup for the person</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-num">{nf.format(real.linksSent)}</span>
                    <span className="stat-label">Payment links sent</span>
                    <span className="stat-sub">each one a real transfer, on the record</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-num">{real.lastActivityAt ? ago(real.lastActivityAt) : "not yet"}</span>
                    <span className="stat-label">Last activity</span>
                    <span className="stat-sub">when real money last moved</span>
                  </div>
                </div>
              )}

              <h2 className="stat-section-h">Practice</h2>
              <p className="stat-section-sub">
                The same system on a test record, where the money is not real. This is where we and
                anyone trying the product spend most of our time, so the count is much larger and
                means much less.
              </p>
              {practice === null ? (
                <p className="stat-refreshing">Refreshing the practice numbers.</p>
              ) : (
                <div className="stat-grid">
                  <div className="stat-tile">
                    <span className="stat-num">{nf.format(practice.accountsCreated)}</span>
                    <span className="stat-label">Accounts created</span>
                    <span className="stat-sub">mostly our own testing</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-num">{nf.format(practice.linksSent)}</span>
                    <span className="stat-label">Payment links sent</span>
                    <span className="stat-sub">practice transfers, no real money</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-num">{practice.lastActivityAt ? ago(practice.lastActivityAt) : "not yet"}</span>
                    <span className="stat-label">Last activity</span>
                    <span className="stat-sub">the system is live and running</span>
                  </div>
                </div>
              )}

              <p className="stat-note">
                {/* explicit {" "} at each </strong> boundary — JSX eats the trailing space (SITE_REDESIGN §5) */}
                <strong>What these do and don&apos;t say.</strong>{" "}&ldquo;Accounts created&rdquo;
                counts every account the system has funded, including our own
                testing, and{" "}<strong>not</strong>{" "}unique people. We don&apos;t track who you are,
                so we can&apos;t claim a user count we&apos;d be unable to prove, and we won&apos;t.
                Most of the practice number is us. What we can prove is that the money moves, and
                that every number here is on the record.
              </p>

              <p className="stat-meta">
                Read live from the public record.{" "}
                <a href="/tools/verify">Check a transfer yourself &rarr;</a>
              </p>
            </>
          )}
        </div>
      </section>

      <Footer />
    </div>
  );
}
