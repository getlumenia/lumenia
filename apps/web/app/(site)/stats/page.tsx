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
const TITLE = `${PAGE_TITLE} — Lumenia`;
const DESCRIPTION =
  "Real, verifiable numbers read straight from the public record — accounts created and payment links sent so far.";

// Re-read the ledger at most once every 5 minutes, regardless of traffic.
export const revalidate = 300;

export const metadata: Metadata = {
  title: PAGE_TITLE, // the (site) layout template appends “ — Lumenia”
  description: DESCRIPTION,
  alternates: { canonical: "/stats" },
  openGraph: {
    type: "website",
    url: "/stats",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia — money home, in a link." }],
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
  const stats = await loadStats();

  return (
    <div className="pg">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner" style={{ maxWidth: "620px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Live from the public record
          </p>
          <h1 className="pg-h1">Every number here is real.</h1>
          <p className="pg-lead">
            These come straight off the public record and refresh continuously. Nothing is typed in
            by hand — open any transfer and check it yourself.
          </p>
        </div>
      </header>

      <section className="stat-body">
        <div className="stat-inner">
          {stats === null ? (
            <p className="stat-refreshing">
              The live numbers are refreshing — check back in a moment. We only show what we can read
              from the public record, so this space stays empty rather than guessing.
            </p>
          ) : (
            <>
              <div className="stat-grid">
                <div className="stat-tile">
                  <span className="stat-num stat-num-accent">{nf.format(stats.accountsCreated)}</span>
                  <span className="stat-label">Accounts created</span>
                  <span className="stat-sub">funded by the system, no setup for the person</span>
                </div>
                <div className="stat-tile">
                  <span className="stat-num">{nf.format(stats.linksSent)}</span>
                  <span className="stat-label">Payment links sent</span>
                  <span className="stat-sub">each one a real transfer, on the record</span>
                </div>
                {/* No "dollars moved" tile: every transfer so far is our own testing, so a dollar
                    figure would imply economic volume that doesn't exist. It returns with real
                    money, where it means something. */}
                <div className="stat-tile">
                  <span className="stat-num">{stats.lastActivityAt ? ago(stats.lastActivityAt) : "—"}</span>
                  <span className="stat-label">Last activity</span>
                  <span className="stat-sub">the system is live and running</span>
                </div>
              </div>

              <p className="stat-note">
                {/* explicit {" "} at each </strong> boundary — JSX eats the trailing space (SITE_REDESIGN §5) */}
                <strong>What these do and don&apos;t say.</strong>{" "}&ldquo;Accounts created&rdquo;
                counts every account the system has funded — including our own
                testing —{" "}<strong>not</strong>{" "}unique people. We don&apos;t track who you are,
                so we can&apos;t claim a user count we&apos;d be unable to prove, and we won&apos;t.
                What we can prove is that the money moves, and that every number here is on the record.
              </p>

              <p className="stat-meta">
                Read live from the public record{stats.lastActivityAt ? `, last active ${ago(stats.lastActivityAt)}` : ""}.{" "}
                <a href="/tools/verify">Check a transfer yourself →</a>
              </p>
            </>
          )}
        </div>
      </section>

      <Footer />
    </div>
  );
}
