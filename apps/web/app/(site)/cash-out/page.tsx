/**
 * /cash-out — the honest cash-out GUIDE (built per the analyst/PM roundtable).
 *
 * WHY it exists: Lumenia does not run an off-ramp, and on Stellar there is no TRY
 * anchor today (even BiLira's TRYB left Stellar). So instead of dumping a recipient
 * with a raw address and "go figure it out", this page is honest HELP: it says the
 * dollars are valuable held as-is (dollarization), describes the least-risky real
 * route, states the rules people will actually hit, and above all carries the
 * wrong-network warning that saves them from losing funds.
 *
 * The product now has an in-app "Send to an exchange" step (/send-out), so this page
 * is no longer describing something the app can't do. It is still a GUIDE, not an
 * integration: Lumenia never touches lira and never holds anyone's money, which is
 * the whole de-risk. Cashing out is a licensed exchange's job.
 *
 * VOCABULARY: this is a sanctioned tech-help surface (like /how-it-works). The
 * consumer framing (hold dollars, local money, your bank) stays plain. Two things are
 * named outright anyway, because leaving them vague is what costs people money: the
 * network the dollars travel on (Stellar) at the moment someone has to pick it from a
 * dropdown, and the reference tag an exchange matches the deposit against.
 *
 * HONESTY: the route below is the best one we can describe today, not a solved
 * problem. The load-bearing fact, confirmed by the owner: Binance TR (the entity
 * licensed to pay Turkish lira into a bank account) does NOT accept these dollars on
 * this network. Binance's global platform does. So the honest route is two accounts
 * plus an internal Binance TRansfer, which has no waiting period in the Global → TR
 * direction (the 48h/72h holds apply the other way). Saying "deposit to Binance TR"
 * would have sent people's money nowhere. The regulatory numbers are MASAK's General
 * Communiqué No. 29 (in force 28 June 2025); rules move, so the page says to check.
 *
 * The real fix is not more instructions. It is removing the network question: bridge
 * the dollars to whichever network the user's exchange already accepts (CCTP is live
 * on Stellar — Spike #4 proved the Stellar-side burn interface). Until that ships,
 * this page is the honest workaround, labelled as one.
 */
import type { Metadata } from "next";
import { Footer } from "../../../components/site/sections/Footer";
import { EmailCapture } from "../../../components/site/EmailCapture";
import "../../../components/site/page.css";
import "./cashout.css";

const PAGE_TITLE = "Turning dollars into lira";
const TITLE = `${PAGE_TITLE} | Lumenia`;
const DESCRIPTION =
  "You're holding real dollars, so you don't have to cash out. When you want Turkish lira in your bank, here's the honest path, what to watch for, and the one mistake that loses money.";

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/cash-out" },
  openGraph: {
    type: "website",
    url: "/cash-out",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function CashOut() {
  return (
    <div className="pg">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner" style={{ maxWidth: "640px" }}>
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Turning it into cash
          </p>
          <h1 className="pg-h1">You&apos;re holding dollars. That&apos;s the point.</h1>
          <p className="pg-lead">
            When your local money loses value, holding dollars <strong>is</strong>{" "}the win. Plenty of
            people keep them exactly as they are. So you don&apos;t have to cash out. But when you
            want Turkish lira in your bank, here&apos;s the honest path, and the one mistake to avoid.
          </p>
        </div>
      </header>

      <section className="co-body">
        <div className="co-inner">
          {/* 1 — you don't have to */}
          <div className="co-block">
            <h2>You don&apos;t have to cash out</h2>
            <p>
              Your dollars sit safely, ready to send onward with a link whenever you want. In a place
              where prices climb month to month, keeping money in dollars is protection, not a
              chore. Cash out only when you actually need local money in hand.
            </p>
          </div>

          {/* 2 — who does this part, and who doesn't */}
          <div className="co-block">
            <h2>Lumenia doesn&apos;t do this part</h2>
            <p>
              We never hold your money and we never touch lira. Turning dollars into lira and paying
              them into a bank account is regulated work, and in Turkey only a licensed exchange can
              do it. That&apos;s deliberate. Because we never sit between you and your cash, there is
              no Lumenia balance to freeze and no float of ours to lose. Nobody at our end can hold
              up your withdrawal, because nobody at our end is in the way.
            </p>
            <p>
              The trade is that the last step happens somewhere else, under someone else&apos;s rules
              and someone else&apos;s ID checks. Here is what that looks like.
            </p>
          </div>

          {/* 3 — the honest path (the tech-help part) */}
          <div className="co-block">
            <h2>The route that works today</h2>
            <p>
              It takes two accounts, and there is a reason for that. The company licensed to pay
              Turkish lira into a Turkish bank account, <strong>Binance TR</strong>, does not accept
              these dollars on the network they travel on. Binance&apos;s global platform does. So
              the dollars arrive at the global side, move across to the Turkish side inside Binance,
              and become lira there.
            </p>
            <p>
              Read all five steps before you start the first one. Step three is where money gets lost.
            </p>
            <ol className="co-steps">
              <li>
                Open a <strong>Binance</strong>{" "}account (the global one, binance.com) and finish its
                ID check.
              </li>
              <li>
                Open a <strong>Binance TR</strong>{" "}account too, with the same identity. This is the
                one allowed to send lira to your bank.
              </li>
              <li>
                On the global account, go to Deposit, choose USDC, and pick <strong>Stellar</strong>{" "}
                as the network. It gives you a deposit address and a reference tag. Copy both, then
                open <strong>Send to an exchange</strong>{" "}in Lumenia and paste them there. That screen
                makes you confirm the tag before anything moves.
              </li>
              <li>
                Once the dollars land, use <strong>Binance TRansfer</strong>{" "}to move them from the
                global account to your Binance TR account. Moving in that direction is free and has
                no waiting period.
              </li>
              <li>
                On Binance TR, sell the dollars for lira and withdraw to your own bank account. Bank
                transfers in Turkey usually land the same day.
              </li>
            </ol>
            <div className="co-warn" style={{ marginTop: "14px" }}>
              {/* Every space after a bold run on this page is an explicit {" "}. The trap is
                  sharper than "JSX eats trailing spaces": `<b>x</b> text` normally survives, but
                  the same line LOSES its space once the following text block contains an HTML
                  entity (&apos;, &ldquo;) — the entity splits the text into fragments and the
                  leading space goes with the split. Two bullets below rendered as "period.After"
                  and "transfers.Transfers" until this was made explicit. */}
              <strong>The two mistakes that lose money:</strong>{" "}the wrong network, and the wrong
              reference tag. Your dollars travel on Stellar, so Stellar has to be selected on both
              sides. Pick Ethereum or Tron on the deposit screen and the money is gone for good. The
              tag is how the exchange tells your deposit apart from thousands of others arriving at
              the same address; leave it out and your money lands in their common pot with nothing
              to prove it was yours. Neither of these has an undo. Send a couple of dollars first,
              wait for them to appear, then send the rest.
            </div>
          </div>

          {/* 4 — the honest unknown, stated plainly rather than glossed */}
          <div className="co-block">
            <h2>Why not straight to a Turkish exchange?</h2>
            <p>
              Because none of them takes these dollars on this network yet. Turkish exchanges list
              USDC on the networks their customers already use, and Stellar isn&apos;t one of them.
              Send to a Turkish exchange&apos;s USDC address anyway and the transfer simply will not
              arrive, because there is nothing at that address able to hold it.
            </p>
            <p>
              Lumenia checks this for you before you sign anything: paste an address that can&apos;t
              hold these dollars and the screen stops you rather than letting the money leave. That
              check is the reason to paste the address into Lumenia instead of guessing.
            </p>
            <p>
              Whichever exchange you use, send a small amount first. Two dollars tells you the truth
              in five minutes. Exchanges change which networks they accept without warning, and we
              would rather you found that out with two dollars than with your rent.
            </p>
          </div>

          {/* 5 — the rules people actually hit */}
          <div className="co-block">
            <h2>The rules you&apos;ll run into</h2>
            <p>
              Turkish exchanges follow MASAK rules that came into force in June 2025. None of them
              are Lumenia&apos;s, and none of them are optional for the exchange. The ones that
              affect you:
            </p>
            <ul className="co-caveats">
              <li>
                <strong>An ID check, always.</strong>{" "}The exchange verifies who you are before it
                pays anything out. Your bank account has to be in your own name.
              </li>
              <li>
                <strong>A waiting period.</strong>{" "}After you deposit, buy or swap, crypto
                withdrawals are held for about 48 hours. On your first transaction with a platform
                it&apos;s about 72. Moving from the global account into Binance TR is the one step
                this doesn&apos;t apply to; it&apos;s the other direction that waits.
              </li>
              <li>
                <strong>Limits on moving stablecoins out.</strong>{" "}Roughly $3,000 a day and $50,000
                a month for sending stablecoins on to another platform. Exchanges that collect full
                sender and recipient details can double both.
              </li>
              <li>
                <strong>A description on transfers.</strong>{" "}Transfers need a written explanation of
                at least 20 characters. &ldquo;Money from family&rdquo; is fine; a single letter isn&apos;t.
              </li>
              <li>
                <strong>Fees at their end, not ours.</strong>{" "}The exchange charges its own trading
                and withdrawal fees. Lumenia charges nothing for this and earns nothing from it.
              </li>
            </ul>
            <p>
              Rules like these change, sometimes at short notice. Check the exchange&apos;s own page
              before you move a large amount.
            </p>
          </div>

          {/* 6 — the honest label on the whole thing */}
          <div className="co-block">
            <h2>This isn&apos;t solved yet</h2>
            <p>
              Two accounts and a waiting period is not what anyone would design. No Turkish provider
              today lets you take dollars from a link straight to lira in one step. What you&apos;ve
              just read is the least-risky real route we know, not a finished product. Cards that
              spend dollars directly, and services that promise instant lira, mostly can&apos;t be
              funded from here, so we&apos;re not going to recommend them.
            </p>
            <p>
              The fix we&apos;re working on removes the network question entirely, so your dollars
              can arrive on whichever network your exchange already accepts. That would collapse
              this page to one step. We&apos;ll say so here when it works, and not before.
            </p>
          </div>

          {/* 7 — cleaner elsewhere (the one-line global story) */}
          <div className="co-elsewhere">
            In other countries this last step is already smoother. <strong>MoneyGram</strong>{" "}lets
            dollars held on the same rails be picked up as cash at retail counters across most of the
            world, and it keeps expanding. Turkey isn&apos;t one of the easy ones yet, which is
            exactly what we&apos;re working to change.
          </div>

          {/* 8 — a smoother way is coming */}
          <div className="co-capture">
            <p className="co-capture-lead">
              We&apos;re building a smoother way to reach local cash, and we won&apos;t promise a date
              we can&apos;t keep. Want to know the moment it&apos;s ready?
            </p>
            <EmailCapture list="cashout" cta="Notify me" />
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
