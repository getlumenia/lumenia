/**
 * /near/send: the sender screen of the NEAR rail. Server shell, client island (components/near/
 * NearSend.tsx); the island holds a session key and signs, so nothing about a send is rendered on
 * the server. Not indexed: a money surface, like /send.
 */
import type { Metadata } from "next";
import { Footer } from "../../../../components/site/sections/Footer";
import { NearSend } from "../../../../components/near/NearSend";
import "../../../../components/site/page.css";
import "../../../../components/near/near.css";

const PAGE_TITLE = "Send on NEAR";
const DESCRIPTION = "Send dollars by link on NEAR testnet. The person who opens it needs no wallet, no NEAR and no app, and pays no gas.";

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: DESCRIPTION,
  robots: { index: false, follow: false },
  openGraph: { type: "website", url: "/near/send", siteName: "Lumenia", title: `${PAGE_TITLE} | Lumenia`, description: DESCRIPTION, locale: "en_US" },
};

export default function NearSendPage() {
  return (
    <div className="pg nr">
      <header className="pg-hero pg-glow nr-hero--short">
        <div className="pg-hero-inner" style={{ maxWidth: "620px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Lumenia on NEAR
          </p>
          <h1 className="pg-h1">Send money on NEAR.</h1>
          <p className="pg-lead">
            The link carries a one-time key; whoever opens it can claim the money. Share it the way you
            would hand over cash. NEAR testnet, practice money only.
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
