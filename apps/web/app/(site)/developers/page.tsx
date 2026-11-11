/**
 * /developers — the primitive under the product, for the people who might build on it. Rebuilt on
 * the Periwinkle system and moved here from (marketing).
 *
 * Along with /how-it-works, this is a page where the technical register is on-brand (the memory
 * note: "teknik estetik sadece how-it-works/developers"). It still does not get to overclaim: the
 * API does not exist, and the copy says so in as many words.
 *
 * The GitHub link now points at the actual repository. It used to be `https://github.com/` — a
 * button labelled "View the code on GitHub" that landed you on GitHub's homepage. The real URL is
 * the one in the git remote, and README.md and EVIDENCE.md both already publish it.
 *
 * NETWORKS. Lumenia is one product on more than one public ledger, and nowhere in the product does a
 * person pick a network: the chain is an implementation detail that shows up in a Details line, on
 * a receipt, and HERE. This is the one page that lists every rail plainly: network, the CAIP-2 style
 * id the code uses internally, the escrow or contract ids, the explorer, who pays the fees, and
 * whether it is a test network or real money.
 */
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Footer } from "../../../components/site/sections/Footer";
import { testnetConfig } from "../../../lib/network";
import { MAINNET_ESCROW_CONTRACT } from "../../../lib/public-numbers";
import { NEAR_CONTRACT_ID, NEAR_NETWORK, explorerAccountUrl as nearExplorerAccountUrl } from "../../../lib/near/config";
import "../../../components/site/page.css";
import "../../../components/site/editorial.css";

const PAGE_TITLE = "Developers: payouts by link";
const TITLE = `${PAGE_TITLE} | Lumenia`; // OG/Twitter keep the full branded form
const DESCRIPTION =
  "Pay someone who has nothing set up yet: no wallet, no account, no address. The code that powers Lumenia is public: the sponsor service, the anti-drain validator, the claim flow.";

export const metadata: Metadata = {
  title: PAGE_TITLE, // the (site) layout template appends “ | Lumenia”
  description: DESCRIPTION,
  alternates: { canonical: "/developers" },
  openGraph: {
    type: "website",
    url: "/developers",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

const REPO = "https://github.com/mericcintosun/lumenia";

/** The rails, as the code knows them. Ids come from the same modules the product reads, never retyped here. */
function rails() {
  const stellarTestnet = testnetConfig().contract;
  return [
    {
      name: "Stellar",
      id: "stellar:pubnet",
      status: "Real money. A hand-approved, capped pilot: $5 a transfer, $50 a day, a kill-switch and a watchdog.",
      escrow: (
        <>
          A link waits in the LumenDrop contract <code>{MAINNET_ESCROW_CONTRACT}</code>; money for a known address waits in a
          protocol-native Claimable Balance with the recipient and the sender's 7-day reclaim as its only claimants.
        </>
      ),
      fees: "Lumenia's sponsor service: sponsored reserves for the new account and its trustline, and a fee-bump around the claim. The recipient holds 0 XLM and pays nothing.",
      explorer: ["stellar.expert", `https://stellar.expert/explorer/public/contract/${MAINNET_ESCROW_CONTRACT}`],
      code: ["contracts/lumen-drop", `${REPO}/tree/main/contracts/lumen-drop`],
    },
    {
      name: "Stellar",
      id: "stellar:testnet",
      status: "Practice money. The link /try sends you, and the practice accounts /start opens.",
      escrow: (
        <>
          The same LumenDrop contract on the test network, <code>{stellarTestnet}</code>, and the same Claimable Balances.
        </>
      ),
      fees: "The same sponsor service, on its test deployment.",
      explorer: ["stellar.expert", `https://stellar.expert/explorer/testnet/contract/${stellarTestnet}`],
      code: ["apps/sponsor", `${REPO}/tree/main/apps/sponsor`],
    },
    {
      name: "NEAR",
      id: `near:${NEAR_NETWORK}`,
      status: "Practice money. The shared practice balance on /try/send, the /claim screen and the /ledger. Built at NEAR HACKATHON 2026; test network only until the escrow has been reviewed.",
      escrow: (
        <>
          The escrow contract <code>{NEAR_CONTRACT_ID}</code> holds the dollars (Circle's test USDC, a NEP-141 token) until the link is
          claimed or reclaimed, and keeps a public record of every link.
        </>
      ),
      fees: "The link key is a function-call key held by the escrow, so the escrow itself signs and pays the claim; a brand-new account is created in the same transaction and receives 0.05 NEAR for its first transactions. A claimed account pays a link forward through a relayer (the sponsor's /near mount) that serves only this escrow. The recipient pays no gas.",
      explorer: ["nearblocks.io", nearExplorerAccountUrl(NEAR_CONTRACT_ID)],
      code: ["contracts/lumen-drop-near", `${REPO}/tree/main/contracts/lumen-drop-near`],
    },
  ] as const;
}

export default function Developers() {
  return (
    <div className="pg ed">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner">
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Developers
          </p>
          <h1 className="pg-h1">Payouts by link.</h1>
          <p className="pg-lead">
            Pay someone who has <strong>nothing set up yet</strong>: no wallet, no seed phrase, no
            account, no address. We create the account, cover the network cost, and hand them the
            money. They tap a link.
          </p>
        </div>
      </header>

      <section className="ed-body">
        {/* il-request — an open hand cupped under a periwinkle glow: the whole primitive is "someone
            holds out their hand and receives," which is exactly what a payout-by-link is. */}
        <figure className="pg-figure" style={{ marginBottom: "clamp(32px,5vh,52px)" }}>
          <div className="pg-figure-frame">
            <Image src="/brand-kit-assets/il-request.webp" alt="" fill sizes="(max-width:760px) 92vw, 700px" />
          </div>
        </figure>
        <div className="ed-prose">
          <p>
            That primitive is useful well beyond consumer transfers. Refunds, earnings, rewards, gig
            payouts. Anywhere you owe money to someone who never signed up for the rails you happen
            to use.
          </p>
          <p>
            We&apos;re building toward a small API and SDK so any product can send a{" "}
            <strong>payout by link</strong>, without asking the person on the other end to make a
            wallet first.
          </p>
          <p>
            It&apos;s early, and it&apos;s open. The code that powers Lumenia is public today: the
            sponsor service, the anti-drain validator, the claim flow. Real API docs will land
            alongside the API itself. We won&apos;t publish a docs site for something that
            doesn&apos;t exist yet.
          </p>
        </div>

        <section className="ed-rails" aria-labelledby="ed-rails-h">
          <h2 id="ed-rails-h" className="ed-rails-h">
            Networks
          </h2>
          <p className="ed-rails-p">
            One product, more than one public ledger. People never choose a network: a link carries everything
            the claim needs, and the chain shows up only in a Details line and on the receipt. This is the one
            page that names them.
          </p>
          {rails().map((r) => (
            <article className="ed-rail" key={r.id}>
              <h3 className="ed-rail-h">
                {r.name} <code>{r.id}</code>
              </h3>
              <dl>
                <dt>Status</dt>
                <dd>{r.status}</dd>
                <dt>Escrow</dt>
                <dd>{r.escrow}</dd>
                <dt>Who pays fees</dt>
                <dd>{r.fees}</dd>
                <dt>Explorer</dt>
                <dd>
                  <a href={r.explorer[1]} target="_blank" rel="noreferrer">
                    {r.explorer[0]} ↗
                  </a>
                </dd>
                <dt>Code</dt>
                <dd>
                  <a href={r.code[1]} target="_blank" rel="noreferrer">
                    {r.code[0]} ↗
                  </a>
                </dd>
              </dl>
            </article>
          ))}
        </section>

        <div className="ed-close">
          <p className="ed-close-p">
            The mechanism is written up in plain language on{" "}
            <Link href="/how-it-works">the audit trail</Link>, with real transactions you can open.
          </p>
          <div className="pg-cta">
            <a className="pg-btn pg-btn-primary" href={REPO} target="_blank" rel="noreferrer">
              View the code on GitHub ↗
            </a>
            <Link className="pg-btn pg-btn-ghost" href="/how-it-works">
              How it works
            </Link>
          </div>
          <p className="ed-fine">Docs come with the API.</p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
