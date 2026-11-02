/**
 * The eight slides of /pitch, as data: a title (for the bar and screen readers), a tone (light or
 * dark Periwinkle), the presenter's notes, and the slide itself.
 *
 * Every number here is measured and dated, and its source sits in the slide's footnote. Market
 * figures were read from the primary source on 2 November 2026. The honesty rules hold here as on
 * every surface: a transfer count never appears without its dollar value, the claim time is a
 * target, there is no third-party audit, and the recipient "pays no gas" (the sponsor covers it).
 * The open testnet funnel on /events/summary is deliberately NOT quoted: the nightly live-claim
 * regression runs against production and its claims are counted there, so it is not user traction.
 *
 * The screenshots in /public/pitch are real product screens, cropped from evidence/sow2-screenshots
 * (the link's key is blurred in the source). The notes ship in the client bundle: they are public.
 */
import type { CSSProperties, ReactNode } from "react";
import QRCode from "react-qr-code";
import { Mascot } from "../../components/brand/Mascot";

export type PitchTone = "light" | "dark";

export interface PitchSlide {
  id: string;
  title: string;
  tone: PitchTone;
  notes: string[];
  body: ReactNode;
}

/** Entrance order of a piece on its slide (pitch.css, .pk-in). */
const d = (n: number) => ({ "--d": n }) as CSSProperties;

const TRY_URL = "https://getlumenia.com/try";
const ICONS = "/brand-kit-assets";

/** A brand icon. Decorative: the words beside it always say the same thing. */
function Icon({ name }: { name: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="pk-icon" src={`${ICONS}/icon-${name}.webp`} alt="" aria-hidden="true" />;
}

/** A source in a footnote. */
function Src({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export const SLIDES: PitchSlide[] = [
  {
    id: "cover",
    title: "Send dollars by link",
    tone: "light",
    notes: [
      "One sentence: Lumenia lets you send US dollars (USDC) as a link, and the person who opens it needs nothing set up.",
      "It runs on Stellar mainnet as a small capped pilot and is open to everyone on the test network today.",
      "In the next few minutes: the problem, why now, how it works, where we are, and how we can work together.",
    ],
    body: (
      <>
        <div className="pk-cover">
          <div className="pk-cover-main">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="pk-cover-mark pk-in" style={d(0)} src={`${ICONS}/logo-wordmark-t.svg`} alt="Lumenia" width={460} height={144} />
            <h1 className="pk-display pk-in" style={d(1)}>
              Send dollars by link.
              <br />
              <span className="pk-accent">They need nothing else.</span>
            </h1>
            <p className="pk-lead pk-cover-lead pk-in" style={d(2)}>
              The person you pay opens the link in any browser and the money is theirs. No app, no wallet, no seed
              phrase, and they pay no gas.
            </p>
            <div className="pk-cover-chips pk-in" style={d(3)}>
              <span className="pk-chip">
                <span className="pk-dot-live" aria-hidden="true" />
                Running on Stellar mainnet as a capped pilot
              </span>
              <span className="pk-chip">Extension for Chrome and Firefox</span>
            </div>
          </div>
          <div className="pk-cover-art pk-fade" style={d(2)}>
            <Mascot pose="messenger" size="hero" enter="none" priority className="pk-mascot" />
          </div>
        </div>
        <p className="pk-foot">Partner deck &middot; November 2026 &middot; getlumenia.com</p>
      </>
    ),
  },
  {
    id: "problem",
    title: "The problem",
    tone: "light",
    notes: [
      "Two roads today, and both lose people. The old road works for anyone with a bank or an agent nearby, and it costs 6.36% on average, 14.99% through a bank.",
      "The new road is cheap and fast, and it asks a stranger to install an app, keep twelve secret words safe and buy a coin for fees before a dollar arrives.",
      "We are not claiming a total cost below the old road yet: cash-out is a licensed partner's step and has its own price. The problem we solve first is the second one.",
    ],
    body: (
      <>
        <p className="pk-eyebrow pk-in" style={d(0)}>
          The problem
        </p>
        <h2 className="pk-h1 pk-problem-title pk-in" style={d(1)}>
          Getting dollars to someone abroad is either expensive or asks too much of them.
        </h2>
        <div className="pk-problem">
          <div className="pk-problem-stat pk-card pk-in" style={d(2)}>
            <p className="pk-h3">The old road</p>
            <p className="pk-num">6.36%</p>
            <p className="pk-body pk-ink">
              the average cost of sending $200 abroad, and <b>14.99%</b> through a bank
            </p>
          </div>
          <div className="pk-problem-steps pk-in" style={d(3)}>
            <p className="pk-h3">The new road</p>
            <ol className="pk-steps-struck">
              <li>
                <span className="pk-strike" style={d(0)}>Install an app</span>
              </li>
              <li>
                <span className="pk-strike" style={d(1)}>Save twelve secret words</span>
              </li>
              <li>
                <span className="pk-strike" style={d(2)}>Buy a coin to pay the fee</span>
              </li>
            </ol>
            <p className="pk-lead pk-ink">Only then does the first dollar arrive.</p>
          </div>
          <div className="pk-problem-art pk-fade" style={d(4)}>
            <Mascot pose="phone" size="lg" enter="none" className="pk-mascot" />
          </div>
        </div>
        <p className="pk-foot">
          Source:{" "}
          <Src href="https://remittanceprices.worldbank.org/">World Bank, Remittance Prices Worldwide, Issue 54</Src>{" "}
          (Q3 2025 data).
        </p>
      </>
    ),
  },
  {
    id: "why-now",
    title: "Why now",
    tone: "light",
    notes: [
      "The money is already moving: stablecoin payments grew 45% to $482B in the first nine months of 2026 while supply barely moved. That is usage, not speculation.",
      "The rails reach everywhere that matters: USDC is natively issued on 38 blockchains, and Circle CCTP moves it between more than 30 of them. Rules exist now too: the GENIUS Act in the US, MiCA in the EU.",
      "Our first corridor is Europe to Türkiye. Legal position: Lumenia is non-custodial software, and we are getting a written opinion from Turkish counsel before real money opens beyond the pilot.",
    ],
    body: (
      <>
        <p className="pk-eyebrow pk-in" style={d(0)}>
          Why now
        </p>
        <h2 className="pk-h1 pk-in" style={d(1)}>
          The dollars are already moving.
          <br />
          The last step to a person is missing.
        </h2>
        <div className="pk-market">
          <div className="pk-market-stat pk-in" style={d(2)}>
            <p className="pk-num pk-num-sm">$482B</p>
            <p className="pk-body pk-ink">stablecoin payments, January to September 2026: up 45% while supply grew 0.4%</p>
          </div>
          <div className="pk-market-stat pk-in" style={d(3)}>
            <p className="pk-num pk-num-sm">$926B</p>
            <p className="pk-body pk-ink">in personal remittances received worldwide in 2025</p>
          </div>
          <div className="pk-market-stat pk-in" style={d(4)}>
            <p className="pk-num pk-num-sm">$70B</p>
            <p className="pk-body pk-ink">of USDC in circulation, natively issued on 38 blockchains</p>
          </div>
          <div className="pk-market-stat pk-in" style={d(5)}>
            <p className="pk-num pk-num-sm">30+</p>
            <p className="pk-body pk-ink">chains joined by Circle CCTP, with Stellar among them since May 2026</p>
          </div>
        </div>
        <div className="pk-cards">
          <div className="pk-corridor pk-in" style={d(6)}>
            <p className="pk-h3">Our first corridor: Europe to T&uuml;rkiye</p>
            <p className="pk-body">
              2.6 million people with Turkish roots live in Germany alone. In T&uuml;rkiye, annual inflation is 29.73%, and
              the peer-to-peer crypto economy grew fivefold in a year to $3.56B.
            </p>
          </div>
          <div className="pk-corridor pk-in" style={d(7)}>
            <p className="pk-h3">The rules now exist</p>
            <p className="pk-body">
              The US GENIUS Act (July 2025) and the EU&apos;s MiCA (June 2024) set rules for dollar stablecoins.
            </p>
          </div>
        </div>
        <p className="pk-foot">
          Sources: <Src href="https://www.allium.so/reports/state-of-stablecoins-and-payments-q3-2026">Allium, Q3 2026</Src>;{" "}
          <Src href="https://data.worldbank.org/indicator/BX.TRF.PWKR.CD.DT">World Bank</Src>;{" "}
          <Src href="https://www.circle.com/usdc">Circle, 29 Oct 2026</Src>;{" "}
          <Src href="https://developers.circle.com/cctp/concepts/supported-chains-and-domains">Circle CCTP docs</Src>;{" "}
          <Src href="https://www.destatis.de/DE/Presse/Pressemitteilungen/2026/10/PD26_377_122.html">Destatis, Oct 2026</Src>;{" "}
          TurkStat via the <Src href="https://www.tcmb.gov.tr/wps/wcm/connect/EN/TCMB+EN/Main+Menu/Statistics/Inflation+Data">CBRT, Sept 2026</Src>;{" "}
          <Src href="https://www.chainalysis.com/blog/middle-east-north-africa-crypto-adoption-2026/">Chainalysis, Oct 2026</Src>.
        </p>
      </>
    ),
  },
  {
    id: "how",
    title: "How it works",
    tone: "light",
    notes: [
      "Walk the three steps on the real screens. These are the test network's screens, which is why the badge says practice money.",
      "The link is private by default: a chat preview shows the Lumenia name and nothing else, no amount and no sender.",
      "Why a link and not an IBAN or a phone number: those only reach someone who already has an account somewhere. The link carries the money and opens the account at the moment it arrives.",
      "If asked about others: Beans prompts the recipient to download its app. Morse asks for identity verification and has Türkiye in closed beta. TipLink's link is the wallet, on Solana. Felix shows the demand for remittances over WhatsApp.",
    ],
    body: (
      <>
        <div className="pk-how">
          <div className="pk-how-main">
            <p className="pk-eyebrow pk-in" style={d(0)}>
              How it works
            </p>
            <h2 className="pk-h1 pk-in" style={d(1)}>
              Three steps. The link carries the money.
            </h2>
            <ol className="pk-flow">
              <li className="pk-flow-step pk-in" style={d(2)}>
                <Icon name="send" />
                <div>
                  <p className="pk-h3">Send</p>
                  <p className="pk-small">Pick an amount. The dollars wait in an escrow contract on the ledger.</p>
                </div>
              </li>
              <li className="pk-flow-step pk-in" style={d(3)}>
                <Icon name="contacts" />
                <div>
                  <p className="pk-h3">Share</p>
                  <p className="pk-small">Paste it in any chat. The preview shows no amount and no name.</p>
                </div>
              </li>
              <li className="pk-flow-step pk-in" style={d(4)}>
                <Icon name="check" />
                <div>
                  <p className="pk-h3">Claim</p>
                  <p className="pk-small">One tap opens an account and the dollars land. Target: about 30 seconds.</p>
                </div>
              </li>
            </ol>
            <div className="pk-why pk-in" style={d(5)}>
              <p className="pk-h3">Why a link, not an IBAN or a phone number?</p>
              <p className="pk-body">
                Those reach people who already have an account. <b>A link opens the account at the moment the money
                arrives.</b>
              </p>
            </div>
          </div>
          <div className="pk-shots pk-fade" style={d(3)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="pk-shot pk-shot--chat" src="/pitch/link-in-chat.webp" width={1560} height={430} alt="A payment link pasted into a chat box. The link shows no amount and no name." />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="pk-shot pk-shot--claim" src="/pitch/claim-before.webp" width={1140} height={845} alt="The claim screen: Someone sent you money, $0.50, verified on the ledger, no app, no wallet, you pay nothing, with a button that says Take $0.50." />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="pk-shot pk-shot--done" src="/pitch/claim-after.webp" width={992} height={1134} alt="After claiming: It's yours. Network fee $0.00, covered by Lumenia. The account was just created on Stellar." />
          </div>
        </div>
        <p className="pk-foot">
          Real product screens, on the test network. A one-to-one link can be taken back by the sender after 7 days. Claim
          time is a target, not yet a published measurement.
        </p>
      </>
    ),
  },
  {
    id: "engine",
    title: "Under the hood",
    tone: "dark",
    notes: [
      "The contract is the escrow. It releases a drop only to the account that the link's key signed for, so the relayer that submits the claim and pays the fee can refuse but never redirect.",
      "The same contract runs group links (one link, equal shares for the first N people) and the sender's take-back after expiry.",
      "We compose on what exists: Circle's USDC, Soroban contracts, Stellar's sponsored reserves, Circle CCTP, OpenZeppelin's contract libraries.",
      "Be plain about the stage: the contract is upgradeable by a 2-of-3 multisig and has no third-party audit yet. It is prepared for one, and the upgrade key is the one owner power its invariants cannot bind.",
    ],
    body: (
      <>
        <p className="pk-eyebrow pk-in" style={d(0)}>
          Under the hood
        </p>
        <h2 className="pk-h1 pk-in" style={d(1)}>
          The contract decides who gets paid.
          <br />
          Our server can only say no.
        </h2>
        <div className="pk-engine">
          <div className="pk-diagram pk-in" style={d(2)}>
            <div className="pk-node">
              <p className="pk-micro">From</p>
              <p className="pk-h3">The sender</p>
            </div>
            <span className="pk-arrow" aria-hidden="true" />
            <div className="pk-node pk-node--escrow">
              <p className="pk-micro">Held by</p>
              <p className="pk-h3">An escrow contract on the ledger</p>
              <p className="pk-small">Pays only the account the link&apos;s key signed for</p>
            </div>
            <span className="pk-arrow" aria-hidden="true" />
            <div className="pk-node">
              <p className="pk-micro">To</p>
              <p className="pk-h3">The recipient&apos;s account</p>
            </div>
            <div className="pk-relayer">
              <p className="pk-small">
                <b>Lumenia&apos;s relayer</b> pays the fee and submits the claim. It can refuse one. It cannot send the
                money anywhere else. Unclaimed after the deadline, the money goes back to the sender.
              </p>
            </div>
          </div>
          <ul className="pk-built pk-in" style={d(3)}>
            <li>
              <b>Private links</b> no amount or name in a chat preview
            </li>
            <li>
              <b>Group links</b> one link, equal shares for a whole room
            </li>
            <li>
              <b>Request money</b> ask, and get paid by link
            </li>
            <li>
              <b>Guard rails</b> caps that fail closed, a kill switch, a 15-minute watchdog
            </li>
          </ul>
        </div>
        <div className="pk-composes pk-in" style={d(4)}>
          <span className="pk-micro">Built on</span>
          <span className="pk-chip">Circle USDC</span>
          <span className="pk-chip">Soroban contracts</span>
          <span className="pk-chip">Sponsored reserves</span>
          <span className="pk-chip">Circle CCTP</span>
          <span className="pk-chip">OpenZeppelin for Stellar</span>
        </div>
        <p className="pk-foot">
          Escrow contract CAC5JYQ2&hellip;WGR4 on Stellar mainnet. Upgrades need 2 of 3 owner keys. Audit-ready, not
          audited.
        </p>
      </>
    ),
  },
  {
    id: "proof",
    title: "Where we are",
    tone: "light",
    notes: [
      "Say the size out loud: 109 transfers, about $4.40 in total, in a hand-approved pilot capped at $5 per transfer. It proves the plumbing with real money. It is not demand, and most of it came from one scripted test run.",
      "If asked: there have been no new mainnet transfers since 30 August 2026. The next cohort is exactly what we are asking partners for.",
      "The product is open to anyone on the test network: send, share, claim, group links, request money, take-back.",
      "The escrow is engineered for an audit: 29 contract tests, 99% line coverage, 51 of 52 mutants caught, a 2-of-3 multisig owner. The extension is live in both browser stores.",
      "The open question we want partners for: does a person who receives a link go on to send one? We count that, not addresses.",
    ],
    body: (
      <>
        <p className="pk-eyebrow pk-in" style={d(0)}>
          Where we are
        </p>
        <h2 className="pk-h1 pk-in" style={d(1)}>
          Working with real money.
          <br />
          Early, capped, and reported at real size.
        </h2>
        <dl className="pk-stats">
          <div className="pk-stat pk-in" style={d(2)}>
            <dt className="pk-small">Real USDC transfers on mainnet</dt>
            <dd>
              <span className="pk-num">109</span>
              <span className="pk-body pk-ink">about $4.40 in total, median $0.002</span>
            </dd>
          </div>
          <div className="pk-stat pk-in" style={d(3)}>
            <dt className="pk-small">USDC from Base, minted on Stellar</dt>
            <dd>
              <span className="pk-num">16&nbsp;s</span>
              <span className="pk-body pk-ink">through Circle CCTP, on testnet</span>
            </dd>
          </div>
          <div className="pk-stat pk-in" style={d(4)}>
            <dt className="pk-small">Line coverage of the escrow contract</dt>
            <dd>
              <span className="pk-num">99%</span>
              <span className="pk-body pk-ink">29 tests, 51 of 52 mutants caught</span>
            </dd>
          </div>
        </dl>
        <div className="pk-proof-rows pk-in" style={d(5)}>
          <p className="pk-body">
            <b>In two browser stores</b> The extension (0.1.4) is on the Chrome Web Store and Firefox Add-ons.
          </p>
          <p className="pk-body">
            <b>Open on testnet</b> Anyone can run the whole loop: send, claim, group links, request money, take-back.
          </p>
          <p className="pk-body">
            <b>Funded by Stellar Instawards</b> Two awards in 2026, via the Stellar T&uuml;rkiye chapter.
          </p>
        </div>
        <p className="pk-next pk-in" style={d(6)}>
          What we measure next: <b>how many people who receive a link go on to send one.</b>
        </p>
        <p className="pk-foot">
          Mainnet pilot, July to August 2026: hand-approved wallets, $5 cap per transfer, largest transfer $1.00, most
          transfers from one scripted test run, so read it as a working proof, not as demand. CCTP: Base Sepolia to Stellar
          testnet, 19 Sept 2026, 16 to 26 s in test runs. No third-party audit yet.
        </p>
      </>
    ),
  },
  {
    id: "partners",
    title: "Work with us",
    tone: "light",
    notes: [
      "Every claim opens a funded account for someone who had none. The question for a partner is where that person goes next.",
      "Wallets and exchanges: the escrow can pay a claim to any account the recipient picks, so your app can be the place it lands. The contract already allows it; we build that button with you.",
      "Cash-out providers: recipients who want local money. Lumenia does not take custody, so the licensed step stays yours.",
      "Chains, ecosystems, communities: one group link pays a whole room, each person into an account of their own, and USDC can arrive from other chains through Circle CCTP.",
    ],
    body: (
      <>
        <div className="pk-partners-head">
          <div>
            <p className="pk-eyebrow pk-in" style={d(0)}>
              Work with us
            </p>
            <h2 className="pk-h1 pk-in" style={d(1)}>
              Every claim opens a funded account. You decide where it goes next.
            </h2>
          </div>
          <div className="pk-partners-art pk-fade" style={d(1)}>
            <Mascot pose="thumbsup" size="md" enter="none" className="pk-mascot" />
          </div>
        </div>
        <div className="pk-partners" role="table" aria-label="Ways to work together">
          <div className="pk-partner pk-partner--head" role="row">
            <span role="columnheader">If you are</span>
            <span role="columnheader">You get</span>
            <span role="columnheader">Together we build</span>
          </div>
          <div className="pk-partner pk-in" style={d(2)} role="row">
            <span role="cell" className="pk-partner-who">
              <Icon name="key" />
              <span className="pk-h3">A wallet or an exchange</span>
            </span>
            <span role="cell" className="pk-body">New users who arrive already holding dollars</span>
            <span role="cell" className="pk-body pk-muted">A claim that pays straight into your app</span>
          </div>
          <div className="pk-partner pk-in" style={d(3)} role="row">
            <span role="cell" className="pk-partner-who">
              <Icon name="hand" />
              <span className="pk-h3">A cash-out provider</span>
            </span>
            <span role="cell" className="pk-body">Recipients who want local money, the moment they claim</span>
            <span role="cell" className="pk-body pk-muted">A licensed exit, offered inside the claim</span>
          </div>
          <div className="pk-partner pk-in" style={d(4)} role="row">
            <span role="cell" className="pk-partner-who">
              <Icon name="shield" />
              <span className="pk-h3">A chain or an ecosystem</span>
            </span>
            <span role="cell" className="pk-body">Onboarding with nothing to install</span>
            <span role="cell" className="pk-body pk-muted">Campaigns paid by group links, with USDC in through Circle CCTP</span>
          </div>
          <div className="pk-partner pk-in" style={d(5)} role="row">
            <span role="cell" className="pk-partner-who">
              <Icon name="contacts" />
              <span className="pk-h3">A community or an event</span>
            </span>
            <span role="cell" className="pk-body">A whole room paid with one link</span>
            <span role="cell" className="pk-body pk-muted">Equal shares for each person, leftovers back to the organiser</span>
          </div>
        </div>
        <p className="pk-foot">
          Money waits in the escrow contract on the ledger, not in an account of ours, until it is claimed or taken back.
          Group links run on mainnet inside the pilot caps. USDC in through CCTP is proven on testnet. Integrations are
          built with each partner.
        </p>
      </>
    ),
  },
  {
    id: "ask",
    title: "What we are asking for",
    tone: "dark",
    notes: [
      "Close on the three concrete asks, not on a vision.",
      "A pilot cohort is the one that moves the open question: we need real people paying real people.",
      "Scan the code: the practice version runs in any phone's browser in under a minute, nothing to install.",
    ],
    body: (
      <>
        <div className="pk-ask">
          <div className="pk-ask-main">
            <p className="pk-eyebrow pk-in" style={d(0)}>
              What we are asking for
            </p>
            <h2 className="pk-h1 pk-in" style={d(1)}>
              Three things would move this fastest.
            </h2>
            <ol className="pk-asks">
              <li className="pk-in" style={d(2)}>
                <p className="pk-h3">A pilot cohort</p>
                <p className="pk-small">A community, an app or an event with real people to pay.</p>
              </li>
              <li className="pk-in" style={d(3)}>
                <p className="pk-h3">A licensed cash-out partner</p>
                <p className="pk-small">Starting with T&uuml;rkiye, our first corridor.</p>
              </li>
              <li className="pk-in" style={d(4)}>
                <p className="pk-h3">An integration</p>
                <p className="pk-small">Your app as a place a claim can land.</p>
              </li>
            </ol>
            <div className="pk-team pk-in" style={d(5)}>
              <p className="pk-h3">Meri&ccedil; Cintosun, founder</p>
              <p className="pk-small">
                Stellar T&uuml;rkiye ambassador. Built the escrow contract, the relayer, the web app and the extension.
              </p>
            </div>
          </div>
          <div className="pk-ask-side pk-fade" style={d(3)}>
            <div className="pk-qr">
              <QRCode value={TRY_URL} size={256} bgColor="transparent" fgColor="currentColor" level="M" title="getlumenia.com/try" />
            </div>
            <p className="pk-body pk-ink pk-qr-label">Try it now, with practice money</p>
            <p className="pk-small">
              <a href={TRY_URL} target="_blank" rel="noreferrer">getlumenia.com/try</a>
            </p>
            <Mascot pose="wave" size="md" enter="none" className="pk-mascot pk-ask-mascot" />
          </div>
        </div>
        <p className="pk-foot">
          <a href="https://getlumenia.com" target="_blank" rel="noreferrer">getlumenia.com</a> &middot;{" "}
          <a href="https://github.com/getlumenia/lumenia" target="_blank" rel="noreferrer">github.com/getlumenia/lumenia</a> &middot; Funded by Stellar
          Instawards, via the Stellar T&uuml;rkiye chapter
        </p>
      </>
    ),
  },
];
