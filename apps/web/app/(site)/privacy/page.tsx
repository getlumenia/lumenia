/**
 * /privacy — plain language: exactly what we hold and what we don't. Rebuilt on Periwinkle, moved
 * from (marketing). Copy carried over verbatim (honest, on-voice — not a redesign's business to
 * reword).
 */
import type { Metadata } from "next";
import { Footer } from "../../../components/site/sections/Footer";
import "../../../components/site/page.css";
import "../../../components/site/editorial.css";

const PAGE_TITLE = "Privacy";
const TITLE = `${PAGE_TITLE} | Lumenia`; // OG/Twitter keep the full branded form
const DESCRIPTION = "Plain language: exactly what Lumenia holds and what it doesn't. Your money lives on a public ledger, never in a Lumenia account; your password never leaves your phone.";

export const metadata: Metadata = {
  title: PAGE_TITLE, // the (site) layout template appends “ | Lumenia”
  description: DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: {
    type: "website",
    url: "/privacy",
    siteName: "Lumenia",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function Privacy() {
  return (
    <div className="pg ed">
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner">
          <p className="pg-eyebrow">
            <span className="pg-dot" aria-hidden="true" />
            Privacy
          </p>
          <h1 className="pg-h1">What we hold, and what we don&apos;t.</h1>
        </div>
      </header>

      <section className="ed-body">
        <div className="ed-prose">
          <p>Plain language. Here&apos;s exactly what we hold and what we don&apos;t.</p>

          <h2>What we never store</h2>
          <ul>
            <li>Your money. It lives on a public ledger, never in a Lumenia account.</li>
            <li>Your password. It never leaves your phone; we couldn&apos;t read it if we wanted to.</li>
            <li>The keys to your money in a form we can open. See below.</li>
          </ul>

          <h2>What we may store</h2>
          <ul>
            <li>
              If you choose to lock your money with a password, an <strong>encrypted backup</strong>{" "}
              of your key, scrambled with your password, which we don&apos;t have. To us it&apos;s
              meaningless noise; only your password unlocks it.
            </li>
            <li>
              If you join the waitlist or ask to be notified about cash-out, your{" "}
              <strong>email</strong>, kept on its own, never tied to your money or any account.
            </li>
            <li>
              Basic counts to see whether the product works (e.g. did a claim succeed). They carry short
              one-way hashes, never your address or a link&apos;s secret. Anyone who already knows an
              address could compute its hash, so they are pseudonymous rather than anonymous.
            </li>
          </ul>

          <h2>The browser extension</h2>
          <p>
            The Lumenia browser extension makes a payment link from the Lumenia account you already have,
            and shows whether it was claimed. Here is everything it sends, who gets it, what it keeps on
            your device, and what it never collects. It sends nothing until you press &quot;Agree and
            continue&quot; on its first screen.
          </p>

          <p>What it sends:</p>
          <ul>
            <li>
              <strong>To restore your account:</strong>{" "}
              your email address, then the 6-digit code we email you, to Lumenia&apos;s server
              (lumenia-sponsor.avakit.workers.dev). The server hands your address to an email delivery
              service only to send that one message, and answers with your encrypted key record, still
              locked by your password, which we can&apos;t open.
            </li>
            <li>
              <strong>To send, take back or top up:</strong>{" "}
              the transaction you signed (your public key, the amount and the link&apos;s ID), or, on
              practice money, just your public key for a practice top-up. It goes to Lumenia&apos;s sponsor
              for the network you chose: lumenia-sponsor.avakit.workers.dev for practice money,
              lumenia-sponsor-mainnet.avakit.workers.dev for real money. The sponsor relays the
              transaction and pays the network fee.
            </li>
            <li>
              <strong>To check the pilot:</strong>{" "}
              your account&apos;s public key, in the address of a request to the real-money sponsor: at
              most once a minute on its own, and again when you press Real money (never more often than
              every 10 seconds). It answers whether your account is approved for real money.
            </li>
            <li>
              <strong>Counters:</strong>{" "}
              a few counts, such as &quot;link created&quot;. Each one is an event name, two short
              one-way hashes (SHA-256, cut to 8 bytes, of your account and of the link: pseudonymous,
              since anyone who knows the address can compute the same hash) and the marker
              &quot;ext&quot;. Never a web address, never the link&apos;s secret. They go to the sponsor
              of the network you chose, and only after you agree.
            </li>
            <li>
              <strong>To read the public ledger:</strong>{" "}
              your balance and whether a link was claimed come from public Stellar servers
              (horizon.stellar.org, horizon-testnet.stellar.org, soroban-testnet.stellar.org and
              mainnet.sorobanrpc.com). They aren&apos;t ours, and like any server they see your IP address
              and the account or link you ask about.
            </li>
          </ul>
          <p>
            Our servers see the IP address of every request and use it for rate limiting. Nothing else
            leaves your device.
          </p>

          <p>What it keeps on your device:</p>
          <ul>
            <li>
              Your key record, encrypted with your password (Argon2id and AES-GCM), in the
              extension&apos;s own storage. Your password is never sent anywhere.
            </li>
            <li>Your list of links (amount, link ID, network, status) and your settings.</li>
            <li>
              Each full link with its secret, encrypted with a key derived from your account key, so it
              can be shown again only while the extension is unlocked.
            </li>
            <li>
              In the browser&apos;s memory only, gone when the browser restarts: your key while you&apos;re
              unlocked (it locks after 15 minutes without use, and you can pick 5, 15 or 60); the email
              you typed while a restore is in progress; and, for up to 10 minutes after you choose
              &quot;Paste a Lumenia link here&quot;, the name of the site you chose it on, so the
              extension can show you where the link will go.
            </li>
          </ul>

          <p>What it never collects:</p>
          <ul>
            <li>
              Your browsing history, the pages you visit, or what is on them. The &quot;Paste a Lumenia
              link here&quot; menu item only types the finished link into the text box you right-clicked.
              It never sends a message.
            </li>
            <li>No ads, no third-party analytics kit, and nothing sold.</li>
          </ul>

          <p>
            To remove it, choose &quot;Forget this account&quot; in the extension&apos;s settings, which
            erases the key record, your links and your settings from this browser, or uninstall the
            extension. If links you made are still open, it tells you first: the extension holds the
            only list of them and the only way to take them back. Your money isn&apos;t touched either
            way: it waits on the public ledger, and your backup on getlumenia.com can bring the account
            back.
          </p>

          <p>
            We don&apos;t sell your data, and we don&apos;t want to hold anything we don&apos;t need.
            If any of this changes, we&apos;ll say so here plainly.
          </p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
