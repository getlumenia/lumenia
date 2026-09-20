/**
 * /event: the judge board for the Rise In x Stellar Pro Hackathon (Istanbul, 19-20 Sept 2026),
 * decision register D27 item 2.2. Real data only, never a mock tile: the sponsor's own event
 * counters for both networks, the lira rail's last round trip on this device, the partner proofs
 * with their hashes, and a fresh practice link to scan. See EventBoard.tsx for what each tile
 * reads and how it says "nothing yet" instead of inventing a number.
 */
import type { Metadata } from "next";
import { Footer } from "../../../components/site/sections/Footer";
import { EventBoard } from "./EventBoard";
import "../../../components/site/page.css";
import "../stats/stats.css";
import "./event.css";

export const metadata: Metadata = {
  title: "Event board",
  description: "Live counters from the Lumenia sponsor, the lira rail and the Circle CCTP proof, for the Stellar Pro Hackathon.",
  robots: { index: false, follow: false },
};

export default function EventPage() {
  return (
    <div className="pg">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner" style={{ maxWidth: "720px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Stellar Pro Hackathon, Istanbul, 19-20 Sept 2026
          </p>
          <h1 className="pg-h1">Send dollars by link. No wallet, no app, no fee for the person who gets them.</h1>
          <p className="pg-lead">
            Everything on this board is read live: our sponsor&apos;s event counters, the public
            ledger and the bank rail. Scan the code to receive practice dollars yourself.
          </p>
        </div>
      </header>
      <EventBoard />
      <Footer />
    </div>
  );
}
