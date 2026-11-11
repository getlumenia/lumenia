/**
 * The eight slides of /pitch, as data: a title (for the bar and screen readers), a tone (light or
 * dark Periwinkle), the presenter's notes, and the slide itself.
 *
 * Every number here is measured and dated, and its source sits in the slide's footnote. Market
 * figures were read from the primary source on 2 November 2026. The honesty rules hold here as on
 * every surface: a transfer count never appears without its dollar value, the claim time is a
 * target, nothing is called audited, and the recipient "pays no gas" (the sponsor covers it). Money
 * never "comes back" by itself: the sender takes it back. The open testnet funnel on /events/summary
 * is deliberately NOT quoted: the nightly live-claim regression runs against production and its
 * claims are counted there, so it is not user traction.
 *
 * The deck goes to readers on other chains, and this page is public. It says what is true today: the
 * recipient's account is on Stellar, and USDC can arrive through Circle CCTP (proven from Base, on
 * testnet). It announces nothing beyond that.
 *
 * The screens in /public/pitch come from evidence/sow2-screenshots and the demo video in
 * /public/media: the same $0.50 link from start to finish, on the test network, with the link's key
 * blurred in the source. The notes ship in the client bundle and open with the N key: they are public.
 */
import type { CSSProperties, ReactNode } from "react";
import QRCode from "react-qr-code";
import { Mascot } from "../../components/brand/Mascot";
import {
  EXTENSION_VERSION,
  GROUP_SHARES_MAINNET,
  GROUP_SHARES_TESTNET,
  MAINNET_ESCROW_CONTRACT,
  PILOT,
  TAKE_BACK_DAYS,
  TRY_URL,
  shortId,
} from "../../lib/public-numbers";

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

const ICONS = "/brand-kit-assets";
const CONTACT = "mericcintosunn@gmail.com";

/** A brand icon. Decorative: the words beside it always say the same thing. */
function Icon({ src }: { src: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="pk-icon" src={src} alt="" aria-hidden="true" width={120} height={120} />;
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
      "One sentence: Lumenia lets you send US dollars (USDC) as a link, and the person who opens it installs nothing.",
      `It is deployed on Stellar mainnet as a small capped pilot, idle since ${PILOT.lastTransfer}, and open to everyone on the test network today.`,
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
              <span className="pk-accent">They install nothing.</span>
            </h1>
            <p className="pk-lead pk-cover-lead pk-in" style={d(2)}>
              The person you send it to opens the link in their browser and claims into a new account. No app, no seed
              phrase, and they pay no gas.
            </p>
            <div className="pk-cover-chips pk-in" style={d(3)}>
              <span className="pk-chip">Open on testnet, capped pilot on mainnet</span>
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
      "The usual wallet road is cheap and fast, and many wallets still ask a stranger to install an app, keep twelve secret words safe and buy a coin for fees before a dollar arrives.",
      "We make no total-cost claim yet: cash-out is a licensed partner's step and has its own price. The problem we solve first is the second road.",
    ],
    body: (
      <>
        <p className="pk-eyebrow pk-in" style={d(0)}>
          The problem
        </p>
        <h2 className="pk-h1 pk-in" style={d(1)}>
          Getting dollars to someone abroad either costs too much or asks too much of them.
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
            <p className="pk-h3">The usual wallet road</p>
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
            <p className="pk-lead pk-ink">Lumenia removes all three.</p>
          </div>
        </div>
        <p className="pk-foot">
          Source:{" "}
          <Src href="https://remittanceprices.worldbank.org/">World Bank, Remittance Prices Worldwide, Issue 54</Src>{" "}
          (Q3 2025 data). Lumenia makes no total-cost claim yet: cash-out is a licensed partner&apos;s step, with its own
          price.
        </p>
      </>
    ),
  },
  {
    id: "why-now",
    title: "Why now",
    tone: "light",
    notes: [
      "The money is already moving: stablecoin payments grew 45% to $482B in the first nine months of 2026 while supply barely moved. That is usage, mostly business payments so far; Allium does not break out remittances.",
      "USDC is natively issued on 38 blockchains, and it arrives on Stellar from other chains through Circle CCTP. Rules exist now too: the GENIUS Act in the US, MiCA in the EU.",
      "Our target first corridor is Europe to Türkiye. Official remittances to Türkiye were $761M in 2025, and the route costs about 4% from Germany, so our case there is reach, not price. Its peer-to-peer crypto economy grew fivefold in a year to $3.56B, and its central bank bars paying for goods and services in crypto.",
      "Our own reading, not yet a legal opinion: Lumenia is non-custodial software, with the asterisk on the engine slide: an upgrade key without a timelock, and Circle's power as the issuer to freeze USDC. A brief for Turkish counsel is written and, as of this deck, not yet sent; real money stays invite-only until we have a written opinion.",
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
            <p className="pk-num pk-num-sm">30</p>
            <p className="pk-body pk-ink">chains on Circle CCTP, which added Stellar in May 2026</p>
          </div>
        </div>
        <div className="pk-cards">
          <div className="pk-corridor pk-in" style={d(5)}>
            <p className="pk-h3">Our target first corridor: Europe to T&uuml;rkiye</p>
            <p className="pk-body">
              2.6 million people with Turkish roots live in Germany alone, and annual inflation in T&uuml;rkiye was 29.73%
              in September 2026. The route costs about 4% from Germany, so our case is reach, not price. Cash-out needs a
              licensed partner.
            </p>
          </div>
          <div className="pk-corridor pk-in" style={d(6)}>
            <p className="pk-h3">The rules are arriving</p>
            <p className="pk-body">
              The US GENIUS Act (July 2025) and the EU&apos;s MiCA (June 2024) set rules for dollar stablecoins. T&uuml;rkiye
              is the open question: a written legal opinion comes before anything beyond the invite-only pilot.
            </p>
          </div>
        </div>
        <p className="pk-foot">
          Sources: <Src href="https://www.allium.so/reports/state-of-stablecoins-and-payments-q3-2026">Allium, Q3 2026</Src>;{" "}
          <Src href="https://data.worldbank.org/indicator/BX.TRF.PWKR.CD.DT">World Bank</Src>;{" "}
          <Src href="https://developers.circle.com/cctp/concepts/supported-chains-and-domains">Circle CCTP docs</Src>;{" "}
          <Src href="https://www.destatis.de/DE/Presse/Pressemitteilungen/2026/10/PD26_377_122.html">Destatis, Oct 2026</Src>;{" "}
          TurkStat via the <Src href="https://www.tcmb.gov.tr/wps/wcm/connect/EN/TCMB+EN/Main+Menu/Statistics/Inflation+Data">CBRT</Src>;{" "}
          <Src href="https://datacatalog.worldbank.org/search/dataset/0037898/remittance-prices-worldwide">World Bank RPW dataset, Q3 2025</Src>.
        </p>
      </>
    ),
  },
  {
    id: "how",
    title: "How it works",
    tone: "light",
    notes: [
      "Walk the three steps. The claim screens are the test network's, which is why the badge says practice money.",
      "The link is private by default: a chat preview says someone sent dollars by link, with no amount and no sender. A sender can choose a rich preview instead, which shows their name and the amount. The amount is public on the ledger either way.",
      "Why a link and not an IBAN or a phone number: those only reach someone who already has an account somewhere. The link unlocks the money and opens the account at the moment it arrives.",
      "Others ask the recipient to install an app, pass an identity check or already hold a wallet before the money is theirs. Lumenia asks for none of that first.",
    ],
    body: (
      <>
        <div className="pk-how">
          <div className="pk-how-main">
            <p className="pk-eyebrow pk-in" style={d(0)}>
              How it works
            </p>
            <h2 className="pk-h1 pk-in" style={d(1)}>
              Three steps. The link unlocks the money.
            </h2>
            <ol className="pk-flow">
              <li className="pk-flow-step pk-in" style={d(2)}>
                <Icon src="/pitch/icon-send.webp" />
                <div>
                  <p className="pk-h3">Send</p>
                  <p className="pk-small">Pick an amount. The dollars wait in an escrow contract on the ledger.</p>
                </div>
              </li>
              <li className="pk-flow-step pk-in" style={d(3)}>
                <Icon src={`${ICONS}/icon-contacts.webp`} />
                <div>
                  <p className="pk-h3">Share</p>
                  <p className="pk-small">Paste the link in any chat. By default the preview shows no amount and no name.</p>
                </div>
              </li>
              <li className="pk-flow-step pk-in" style={d(4)}>
                <Icon src={`${ICONS}/icon-check.webp`} />
                <div>
                  <p className="pk-h3">Claim</p>
                  <p className="pk-small">One tap opens an account and the dollars land. Target: about 30 s.</p>
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
            <img className="pk-shot pk-shot--chat" src="/pitch/link-in-chat.webp" width={1560} height={430} alt="A payment link pasted into a chat box. By default the link shows no amount and no name." />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="pk-shot pk-shot--claim" src="/pitch/claim-before.webp" width={1140} height={845} alt="The claim screen: Someone sent you money, $0.50, verified on the ledger, no app, no wallet, you pay nothing, with a button that says Take $0.50." />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="pk-shot pk-shot--done" src="/pitch/claim-after.webp" width={900} height={852} alt="After claiming: $0.50. It's yours. Network fee $0.00, covered by Lumenia." />
          </div>
        </div>
        <p className="pk-foot">
          Claim screens are real product screens on the test network; the chat is a test page, not a chat app. A link is
          like cash: whoever opens it first can claim it, so real-money links carry a password by default. After {TAKE_BACK_DAYS}{" "}
          days the sender can take back an unclaimed link. Claim time is a target, not yet a published measurement.
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
      "The same contract runs group links (one link, a pot of N equal shares) and the sender's take-back after expiry. Nothing returns by itself: the sender has to take it back.",
      "We compose on what exists: Circle's USDC, Stellar smart contracts, Stellar's account sponsorship, Circle CCTP, OpenZeppelin's contract libraries.",
      "Be plain about the stage: the contract is upgradeable by a 2-of-3 multisig whose three keys the founder holds today, with no timelock yet, and it has no third-party audit. We are preparing the package for one. The upgrade key is the one owner power the contract's own rules cannot limit.",
      "The other asterisk is the dollar itself: Circle, as the regulated issuer, can freeze USDC for compliance. It cannot seize it, because clawback is off on USDC.",
    ],
    body: (
      <>
        <p className="pk-eyebrow pk-in" style={d(0)}>
          Under the hood
        </p>
        <h2 className="pk-h1 pk-in" style={d(1)}>
          The contract decides who gets paid.
          <br />
          Our relayer can only say no.
        </h2>
        <div className="pk-diagram pk-in" style={d(2)}>
          <div className="pk-node">
            <p className="pk-micro">From</p>
            <p className="pk-h3">The sender</p>
            <p className="pk-small">Locks the dollars and gets a link</p>
          </div>
          <span className="pk-arrow" aria-hidden="true" />
          <div className="pk-node pk-node--escrow">
            <p className="pk-micro">Held by</p>
            <p className="pk-h3">An escrow contract on the ledger</p>
            <p className="pk-small">Pays only the account the link holder chose</p>
          </div>
          <span className="pk-arrow" aria-hidden="true" />
          <div className="pk-node">
            <p className="pk-micro">To</p>
            <p className="pk-h3">The recipient&apos;s account</p>
            <p className="pk-small">Opened at the claim, with no gas to pay</p>
          </div>
          <div className="pk-relayer">
            <p className="pk-small">
              <b>Lumenia&apos;s relayer</b> pays the fee and submits the claim. It can refuse one. It cannot send the money
              anywhere else. After the deadline the sender can take back an unclaimed link; it does not return by itself.
              Spending caps, a kill switch and a 15-minute watchdog sit on top.
            </p>
          </div>
        </div>
        <div className="pk-composes pk-in" style={d(3)}>
          <span className="pk-micro">Built on</span>
          <span className="pk-chip">Circle USDC</span>
          <span className="pk-chip">Stellar smart contracts</span>
          <span className="pk-chip">Stellar account sponsorship</span>
          <span className="pk-chip">Circle CCTP</span>
          <span className="pk-chip">OpenZeppelin for Stellar</span>
        </div>
        <p className="pk-foot">
          Escrow contract{" "}
          <Src href={`https://stellar.expert/explorer/public/contract/${MAINNET_ESCROW_CONTRACT}`}>{shortId(MAINNET_ESCROW_CONTRACT)}</Src>{" "}
          on Stellar mainnet. Upgrades need 2 of 3 owner keys, all held by the founder today, with no timelock yet: an
          upgrade takes effect at once and new code could move escrowed funds. Not audited. Circle, as the regulated
          issuer, can freeze USDC for compliance; it cannot seize it, because clawback is off on USDC.
        </p>
      </>
    ),
  },
  {
    id: "proof",
    title: "Where we are",
    tone: "light",
    notes: [
      `Say the size out loud: ${PILOT.transfers} transfers, ${PILOT.totalUsd} in total, in a hand-approved pilot capped at ${PILOT.capPerLinkUsd} per link. It proves the plumbing with real money. It is not demand: most transfers by count, though only ${PILOT.scriptedRunValueUsd} by value, were direct payments from one scripted test run, and only ${PILOT.escrowOperations} of the ${PILOT.usdcOperations} USDC operations touched the escrow.`,
      `No sponsor-paid mainnet transfer since ${PILOT.lastTransfer}. The ledger does show inbound activity after that: a top-up, dust, and a few unsolicited sub-cent claimable balances sent to the sponsor from outside accounts in early September (four of them on 7 and 8 September). None of it is a pilot transfer. The next cohort is exactly what we are asking partners for.`,
      "The product is open to anyone on the test network: send, claim, group links, request money, take-back.",
      "The escrow's test evidence so far: 29 contract tests, 97% of its lines run, 51 of 52 injected bugs caught. The owner is a 2-of-3 multisig, all keys founder-held. The extension is available in both browser stores.",
      "The open question we want partners for: does a person who receives a link go on to send one? We count that, not addresses.",
    ],
    body: (
      <>
        <p className="pk-eyebrow pk-in" style={d(0)}>
          Where we are
        </p>
        <h2 className="pk-h1 pk-in" style={d(1)}>
          Proven with real money.
          <br />
          Early, capped, and reported at real size.
        </h2>
        <dl className="pk-stats">
          <div className="pk-stat pk-in" style={d(2)}>
            <dt className="pk-small">Real USDC transfers on mainnet</dt>
            <dd>
              <span className="pk-num">{PILOT.transfers}</span>
              <span className="pk-body pk-ink">{PILOT.totalUsd} in total, median payment {PILOT.medianUsd}</span>
            </dd>
          </div>
          <div className="pk-stat pk-in" style={d(3)}>
            <dt className="pk-small">USDC arriving on Stellar from Base</dt>
            <dd>
              <span className="pk-num">16-26&nbsp;s</span>
              <span className="pk-body pk-ink">through Circle CCTP Fast Transfer, on testnet</span>
            </dd>
          </div>
          <div className="pk-stat pk-in" style={d(4)}>
            <dt className="pk-small">Escrow contract code run by its 29 tests</dt>
            <dd>
              <span className="pk-num">97%</span>
              <span className="pk-body pk-ink">51 of 52 injected bugs caught</span>
            </dd>
          </div>
        </dl>
        <div className="pk-proof-rows pk-in" style={d(5)}>
          <p className="pk-body">
            <b>In two browser stores</b> The extension ({EXTENSION_VERSION}) is on the Chrome Web Store and Firefox Add-ons.
          </p>
          <p className="pk-body">
            <b>Open on testnet</b> Anyone can run the whole loop: send, claim, group links, request money, take-back.
          </p>
        </div>
        <p className="pk-next pk-in" style={d(6)}>
          What we measure next: <b>how many people who receive a link go on to send one.</b>
        </p>
        <p className="pk-foot">
          Mainnet pilot, July to August 2026: hand-approved wallets, {PILOT.capPerLinkUsd} cap per link, largest transfer{" "}
          {PILOT.maxUsd}. No sponsor-paid transfer since {PILOT.lastTransfer}; what the ledger shows after that is inbound
          only (a top-up, dust and a few unsolicited sub-cent claimable balances from outside accounts). Count from our own
          records on {PILOT.transfersCountedOn}; {PILOT.usdcOperations} sponsor-paid USDC operations can be re-counted on
          Horizon, and the value comes from a Horizon recount on {PILOT.valueRecountedOn}. Most transfers by count, only{" "}
          {PILOT.scriptedRunValueUsd} by value, were direct payments from one scripted test run; {PILOT.escrowOperations} of
          the {PILOT.usdcOperations} operations touched the escrow contract. A working proof, not demand. CCTP: Base Sepolia
          to Stellar testnet, 19 Sept 2026, three test runs (16, 18 and 26 s). No third-party audit yet.
        </p>
      </>
    ),
  },
  {
    id: "partners",
    title: "Work with us",
    tone: "light",
    notes: [
      "Every claim opens a funded account, and for a new recipient it is their first. The question for a partner is where that person goes next.",
      "Wallets: the escrow can pay a claim to any Stellar account with a USDC trustline that the recipient picks, so your app can be the place it lands. The contract already allows it; we build that button with you. Exchanges that credit by memo need a second step, because a contract call cannot carry a memo: claim into the new account, then a payment with your memo.",
      "Cash-out providers: recipients who want local money. Lumenia does not take custody (with the engine slide's asterisk: the upgrade key, and Circle's power as the issuer to freeze USDC), so the licensed step stays yours, and the recipient chooses it.",
      "Chains and ecosystems: USDC can arrive through Circle CCTP, proven from Base on testnet, and the recipient lands on Stellar. Communities and events: one group link holds a pot of equal shares, per address rather than per person.",
    ],
    body: (
      <>
        <div className="pk-partners-head">
          <div>
            <p className="pk-eyebrow pk-in" style={d(0)}>
              Work with us
            </p>
            <h2 className="pk-h1 pk-in" style={d(1)}>
              Every claim opens a funded account. Give that person a next step.
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
              <Icon src={`${ICONS}/icon-key.webp`} />
              <span className="pk-h3">A wallet or an exchange</span>
            </span>
            <span role="cell" className="pk-body">New users who arrive already holding dollars</span>
            <span role="cell" className="pk-body pk-muted">A claim straight into your wallet. For an exchange, a claim, then a payment with your memo</span>
          </div>
          <div className="pk-partner pk-in" style={d(3)} role="row">
            <span role="cell" className="pk-partner-who">
              <Icon src={`${ICONS}/icon-hand.webp`} />
              <span className="pk-h3">A cash-out provider</span>
            </span>
            <span role="cell" className="pk-body">Recipients who want local money, the moment they claim</span>
            <span role="cell" className="pk-body pk-muted">Licensed cash-out the recipient can choose after claiming, once counsel confirms the model</span>
          </div>
          <div className="pk-partner pk-in" style={d(4)} role="row">
            <span role="cell" className="pk-partner-who">
              <Icon src={`${ICONS}/icon-shield.webp`} />
              <span className="pk-h3">A chain or an ecosystem</span>
            </span>
            <span role="cell" className="pk-body">Your USDC holders pay anyone by link. The recipient&apos;s account is on Stellar</span>
            <span role="cell" className="pk-body pk-muted">Campaigns funded with USDC through Circle CCTP, proven from Base on testnet</span>
          </div>
          <div className="pk-partner pk-in" style={d(5)} role="row">
            <span role="cell" className="pk-partner-who">
              <Icon src={`${ICONS}/icon-contacts.webp`} />
              <span className="pk-h3">A community or an event</span>
            </span>
            <span role="cell" className="pk-body">A small group paid with one link</span>
            <span role="cell" className="pk-body pk-muted">Equal shares from one pot. The organiser can take back what is left after the link closes</span>
          </div>
        </div>
        <p className="pk-foot">
          Money waits in the escrow contract on the ledger, not in an account of ours, until it is claimed or taken back.
          During the pilot a group link on mainnet holds at most {PILOT.capPerLinkUsd} across {GROUP_SHARES_MAINNET} shares ({GROUP_SHARES_TESTNET}{" "}
          shares on testnet), and it counts addresses, not people. Integrations are built with each partner.
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
      "Scan the code: a practice link opens in your phone's browser, nothing to install, and we target about 30 seconds. This demo uses our simpler Claimable Balance link, not the escrow on the earlier slides.",
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
                <p className="pk-small">40 to 60 real people to pay, from a community, an app, an event or an ecosystem.</p>
              </li>
              <li className="pk-in" style={d(3)}>
                <p className="pk-h3">A cash-out partner</p>
                <p className="pk-small">Licensed, starting with T&uuml;rkiye, our target first corridor.</p>
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
              <p className="pk-body pk-ink">
                Which one fits you? Write to <a className="pk-contact" href={`mailto:${CONTACT}`}>{CONTACT}</a>
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
          <a href="https://github.com/getlumenia/lumenia" target="_blank" rel="noreferrer">github.com/getlumenia/lumenia</a>
        </p>
      </>
    ),
  },
];
