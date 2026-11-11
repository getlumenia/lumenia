/**
 * /try/send: send a link with practice money. Server shell, client island (components/near/
 * NearSend.tsx): the island either asks the sponsor Worker to make a link from the shared practice
 * balance (only the link's public key leaves the tab) or signs with an account key pasted for this
 * tab's session, so nothing about a send is rendered on the server. Not indexed: a money surface,
 * like /send.
 *
 * ONE PRODUCT. The network this practice balance lives on is an implementation detail: it is named
 * only in the "Details" line under the form (components/near/primitives.tsx NetworkDetails), on
 * receipts and explorer links, and on /developers. Headings, buttons and the lead say "account",
 * "balance", "network fee" and "practice money".
 */
import type { Metadata } from "next";
import { Footer } from "../../../../components/site/sections/Footer";
import { NearSend } from "../../../../components/near/NearSend";
import "../../../../components/site/page.css";
import "../../../../components/near/near.css";

const PAGE_TITLE = "Send a link with practice money";
const DESCRIPTION =
  "Make a money link from a shared practice balance. Whoever opens it needs no wallet and no app, and pays no gas. Practice money only.";

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: DESCRIPTION,
  robots: { index: false, follow: false },
  openGraph: { type: "website", url: "/try/send", siteName: "Lumenia", title: `${PAGE_TITLE} | Lumenia`, description: DESCRIPTION, locale: "en_US" },
};

export default function TrySendPage() {
  return (
    <div className="pg nr">
      <header className="pg-hero pg-glow nr-hero--short">
        <div className="pg-hero-inner" style={{ maxWidth: "620px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Practice money
          </p>
          <h1 className="pg-h1">Send a link with practice money.</h1>
          <p className="pg-lead">
            The link carries a one-time key; whoever opens it can claim the money. Share it the way you
            would hand over cash. Practice money only: nothing here is real.
          </p>
        </div>
      </header>

      <section className="nr-body">
        <div className="nr-inner">
          <NearSend />
        </div>
      </section>

      <Footer />
    </div>
  );
}
