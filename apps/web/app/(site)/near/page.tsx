/**
 * /near: Lumenia on NEAR, explained in the house voice. The second rail of the one product: the
 * same link, the same claim without a wallet, on NEAR testnet, built at NEAR HACKATHON 2026.
 *
 * Like /how-it-works this page may name the technology (it IS the page about the rail), but it
 * stays in plain words: what happens to the money, who pays the fee, what comes back. The live
 * numbers are read from the escrow itself on the server (so the HTML carries real figures) and
 * refreshed in the browser; a failed read is an honest empty, never a zero.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Coins, Globe, HandCoins, KeyRound, ShieldCheck, UserRoundPlus } from "lucide-react";
import { Footer } from "../../../components/site/sections/Footer";
import { Mascot } from "../../../components/brand/Mascot";
import { NearLiveNumbers } from "../../../components/near/NearLiveNumbers";
import { NEAR_CONTRACT_ID } from "../../../lib/near/config";
import { getStats } from "../../../lib/near/rpc";
import "../../../components/site/page.css";
import "../../../components/near/near.css";

const PAGE_TITLE = "Lumenia on NEAR";
const TITLE = `${PAGE_TITLE} | Lumenia`;
const DESCRIPTION =
  "Send dollars by link on NEAR. The person who opens it needs no wallet, no NEAR and no app: one tap makes them an account with the money in it, and the recipient pays no gas. Testnet, built at NEAR HACKATHON 2026.";

export const revalidate = 60;

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/near" },
  openGraph: {
    type: "website",
    url: "/near",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

const HOW = [
  {
    icon: UserRoundPlus,
    t: "The account is made at the claim.",
    s: "The person picks a name like yourname.testnet, or takes a plain address. The escrow creates the account and puts the dollars in it, in the same transaction. Nothing to install first.",
  },
  {
    icon: KeyRound,
    t: "The link key can do one thing.",
    s: "A link carries a key that only works for the escrow's claim call. The escrow holds that key as a function-call key and pays the call's fee, so the recipient pays no gas.",
  },
  {
    icon: Coins,
    t: "0.05 NEAR to start.",
    s: "A brand-new account gets a small starter of NEAR from the escrow along with the dollars, enough for its first transactions.",
  },
  {
    icon: HandCoins,
    t: "Pay it forward without holding NEAR.",
    s: "A claimed account can send part of its money on as a new link. It signs with its own key; a relayer that only serves this escrow pays the fee.",
  },
  {
    icon: Globe,
    t: "Other chains through NEAR Intents.",
    s: "At the claim, a live quote shows what the dollars would be as USDC on Stellar or on Base. Intents has no testnet, so here the claim stops at the quote and says so.",
  },
  {
    icon: ShieldCheck,
    t: "The escrow holds it, not us.",
    s: `The dollars sit in the contract ${NEAR_CONTRACT_ID} until they are claimed. Unclaimed money goes back to the sender after the link expires. Lumenia never holds it.`,
  },
] as const;

export default async function NearPage() {
  const stats = await getStats({ finality: "final", init: { next: { revalidate: 60 } } }).catch(() => null);

  return (
    <div className="pg nr">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner nr-hero-inner">
          <div>
            <p className="pg-eyebrow">
              <span className="pg-dot" aria-hidden="true" />
              Lumenia on NEAR
            </p>
            <h1 className="pg-h1">Send dollars by link. On NEAR, too.</h1>
            <p className="pg-lead">
              Make a link, share it any way you like. The person who opens it needs{" "}
              <strong>no wallet, no NEAR and no app</strong>: one tap makes them an account with the money
              already in it, and they pay no gas. Until then the money waits in an escrow on NEAR, and
              if nobody claims it, it comes back to you.
            </p>
            <div className="pg-cta">
              <Link className="pg-btn pg-btn-primary" href="/near/send">
                Send on NEAR
              </Link>
              <Link className="pg-btn pg-btn-ghost" href="/near/ledger">
                See the public ledger
              </Link>
            </div>
            <p className="nr-badge">
              <b>NEAR testnet</b> practice money, built at NEAR HACKATHON 2026
            </p>
          </div>
          <div className="nr-hero-figure">
            <Mascot pose="messenger" size="lg" priority alt="The Lumenia messenger, holding a glowing envelope" />
          </div>
        </div>
      </header>

      <section className="nr-body">
        <div className="nr-inner">
          <div className="nr-section">
            <h2 className="nr-h2">Three doors.</h2>
            <p className="nr-sub">
              The same product you know from the Stellar side, on a second network. Send, open, or look
              at everything that has ever moved through it.
            </p>
            <div className="nr-ways">
              <Link href="/near/send" className="nr-way nr-way--lead">
                <span className="nr-way-k">Send</span>
                <span className="nr-way-t">Send on NEAR</span>
                <span className="nr-way-s">
                  Make a link in a minute. A shared demo sender is ready, up to $5 a link, or bring your
                  own testnet account.
                </span>
                <span className="nr-way-go">
                  Make a link <ArrowRight className="size-4" aria-hidden="true" />
                </span>
              </Link>
              <Link href="/c/near" className="nr-way">
                <span className="nr-way-k">Open</span>
                <span className="nr-way-t">Open a link</span>
                <span className="nr-way-s">Got a link? Open it here and choose where the money goes.</span>
                <span className="nr-way-go">
                  Paste a link <ArrowRight className="size-4" aria-hidden="true" />
                </span>
              </Link>
              <Link href="/near/ledger" className="nr-way">
                <span className="nr-way-k">Check</span>
                <span className="nr-way-t">Public ledger</span>
                <span className="nr-way-s">Every link ever made through the escrow, newest first, read from the contract.</span>
                <span className="nr-way-go">
                  Open the ledger <ArrowRight className="size-4" aria-hidden="true" />
                </span>
              </Link>
            </div>
          </div>

          <div className="nr-section">
            <h2 className="nr-h2">How NEAR is used.</h2>
            <p className="nr-sub">
              In plain words. The chain does four things for the person receiving money, and the link
              key does the rest.
            </p>
            <div className="nr-how">
              {HOW.map(({ icon: Icon, t, s }) => (
                <div className="nr-how-item" key={t}>
                  <span className="nr-how-icon" aria-hidden="true">
                    <Icon />
                  </span>
                  <div>
                    <p className="nr-how-t">{t}</p>
                    <p className="nr-how-s">{s}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* No scroll-linked reveal around the numbers, on purpose: SectionReveal holds a section
              dimmed or blurred until it is scrolled to (docs/SITE_REDESIGN.md section 5), and these
              figures are the page's proof. The rhythm comes from the section spacing alone. */}
          <div className="nr-section">
            <h2 className="nr-h2">Live, from the contract.</h2>
            <p className="nr-sub">
              Nothing typed in. These are read from the escrow on NEAR testnet, where every link,
              amount and outcome is public.
            </p>
            <NearLiveNumbers initial={stats} />
          </div>

          <div className="nr-section">
            <p className="nr-p">
              <strong>Testnet.</strong> Everything on this rail runs on NEAR testnet with Circle&apos;s test
              USDC. Nothing here is real money; the Stellar side is where real dollars move today. The
              escrow, the relayer and this site are open source, and the escrow&apos;s record is the{" "}
              <Link href="/near/ledger">public ledger</Link>.
            </p>
            <p className="nr-foot" style={{ marginTop: 10 }}>
              Built at NEAR HACKATHON 2026. Prefer the other rail?{" "}
              <Link href="/send">Send on Stellar instead</Link>.
            </p>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
