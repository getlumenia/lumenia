/**
 * /near/ledger: the NEAR rail's public ledger, read straight from the escrow contract. The first
 * totals come from the server (revalidated each minute); the island re-reads every 15 s. Amounts
 * and account ids only: memos are private to the two people involved.
 */
import type { Metadata } from "next";
import { Footer } from "../../../../components/site/sections/Footer";
import { Mascot } from "../../../../components/brand/Mascot";
import { NearLedger } from "../../../../components/near/NearLedger";
import { getStats } from "../../../../lib/near/rpc";
import "../../../../components/site/page.css";
import "../../../../components/near/near.css";

const PAGE_TITLE = "The NEAR ledger";
const TITLE = `${PAGE_TITLE} | Lumenia`;
const DESCRIPTION = "Every link ever made through Lumenia's escrow on NEAR testnet, newest first, read from the contract itself. Amounts and account ids only.";

export const revalidate = 60;

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/near/ledger" },
  openGraph: {
    type: "website",
    url: "/near/ledger",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default async function NearLedgerPage() {
  const stats = await getStats({ finality: "final", init: { next: { revalidate: 60 } } }).catch(() => null);
  return (
    <div className="pg nr">
      <header className="pg-hero pg-glow nr-hero--short">
        <div className="pg-hero-inner nr-hero-inner">
          <div>
            <p className="pg-eyebrow">
              <span className="pg-dot" aria-hidden="true" />
              Lumenia on NEAR
            </p>
            <h1 className="pg-h1">The public ledger.</h1>
            <p className="pg-lead">
              Every link ever made through the escrow on NEAR testnet, newest first, read from the
              contract and refreshed every 15 seconds. Amounts and account ids only.
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
