/**
 * /ledger: the public ledger of every link made with practice money, read straight from the escrow.
 * The first totals come from the server (revalidated each minute); the island re-reads every 15 s.
 * Amounts and short account ids only: memos are private to the two people involved.
 *
 * ONE PRODUCT. No network badge in the header: the network is named only inside the Details
 * disclosure under the ledger's footnote and inside each row's Details (with the explorer links);
 * the title, the eyebrow and the copy speak of the ledger, the escrow and the links.
 */
import type { Metadata } from "next";
import { Footer } from "../../../components/site/sections/Footer";
import { Mascot } from "../../../components/brand/Mascot";
import { NearLedger } from "../../../components/near/NearLedger";
import { getStats } from "../../../lib/near/rpc";
import "../../../components/site/page.css";
import "../../../components/near/near.css";

const PAGE_TITLE = "Public ledger";
const TITLE = `${PAGE_TITLE} | Lumenia`;
const DESCRIPTION =
  "Every link made with practice money through Lumenia's escrow, newest first, read from the public ledger itself. Amounts and short account ids only.";

export const revalidate = 60;

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/ledger" },
  openGraph: {
    type: "website",
    url: "/ledger",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default async function LedgerPage() {
  const stats = await getStats({ finality: "final", init: { next: { revalidate: 60 } } }).catch(() => null);
  return (
    <div className="pg nr">
      <header className="pg-hero pg-glow nr-hero--short">
        <div className="pg-hero-inner nr-hero-inner">
          <div>
            <p className="pg-eyebrow">
              <span className="pg-dot" aria-hidden="true" />
              Public ledger
            </p>
            <h1 className="pg-h1">The public ledger.</h1>
            <p className="pg-lead">
              Every link made with practice money through Lumenia&apos;s escrow, newest first, read from
              the ledger itself and refreshed every 15 seconds. Amounts and short account ids only.
            </p>
          </div>
          <div className="nr-hero-figure nr-ledger-mascot">
            <Mascot pose="thumbsup" size="sm" />
          </div>
        </div>
      </header>

      <section className="nr-body">
        <div className="nr-inner">
          <NearLedger initialStats={stats} />
        </div>
      </section>

      <Footer />
    </div>
  );
}
