/**
 * /privacy - plain language: what a link carries, what the public ledger shows, and what our
 * servers see and keep. Rewritten for SOW D2 (T-D2-07), brought up to date with D3 on 2026-10-09
 * (the sponsor's new two-day records, the per-sender day total, no name in a link by default).
 * This URL is the Chrome Web Store listing's privacy policy, and the addons.mozilla.org listing
 * links to it.
 *
 * Every sentence here was checked against the code that does the thing it describes, and each one
 * names a fact, not an intention. When the code changes (a retention, a log line, a new store),
 * this page changes in the same commit, or it starts lying to the people it is written for.
 *
 * "What a link carries" describes the PRIVATE link shape (key, then a name only if the sender typed
 * one, share count and lock marker after the #; only non-personal markers in the query; no amount
 * anywhere). The claim pages, lib/link-fragment.ts and the send screens must keep matching it.
 *
 * Keep id="extension": the Chrome Web Store and addons.mozilla.org listings link to #extension.
 */
import type { Metadata } from "next";
import { Footer } from "../../../components/site/sections/Footer";
import "../../../components/site/page.css";
import "../../../components/site/editorial.css";

const PAGE_TITLE = "Privacy";
const TITLE = `${PAGE_TITLE} | Lumenia`; // OG/Twitter keep the full branded form
const DESCRIPTION = "Plain language: what a Lumenia link carries, what the public ledger shows, and what our servers see and keep. Your money lives on a public ledger, never in a Lumenia account.";

export const metadata: Metadata = {
  title: PAGE_TITLE, // the (site) layout template appends " | Lumenia"
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
          <h1 className="pg-h1">Who can see what, said plainly.</h1>
        </div>
      </header>

      <section className="ed-body">
        <div className="ed-prose">
          <p>
            Here is what a Lumenia link carries, what the public ledger shows, and what our servers see
            and keep.
          </p>
          <p>
            Last updated: <time dateTime="2026-10-09">9 October 2026</time>.
          </p>

          <h2 id="link">What a link carries</h2>
          <p>A money link has three parts, and each one travels differently.</p>
          <ul>
            <li>
              <strong>After the #</strong>, at the end of the link: the key that opens the money, the
              sender&apos;s name only if they typed one, the number of shares in a group link, and a
              marker if the link needs a password. Browsers never send this part to a website, and
              neither does a chat app when it fetches a preview. Our claim page reads it inside your
              browser, then removes it from the address bar.
            </li>
            <li>
              <strong>The path</strong>: the link&apos;s id. It is a public code, and the public ledger
              shows the same id next to the money.
            </li>
            <li>
              <strong>After the ?</strong>, only when they apply: markers that are not personal. n=public
              means real money, g= is the number of shares in a group link, seeded=1 means the Lumenia
              team funded the link, and src=ext means it was made in our browser extension.
            </li>
          </ul>
          <p>
            Everything before the # is an ordinary web address. Our website&apos;s host sees it when the
            link is opened, and so does a chat app that builds a preview.
          </p>
          <p>
            <strong>No name unless the sender adds one.</strong> Since 9 October 2026 our website fills
            in no name for you: a link you make carries none, and the person who opens it sees
            &quot;Someone sent you money&quot;. If you type a name, it travels inside the link, after the
            #, so anyone who can read the chat can read it. (Before that date the website filled in
            your @name, if you had one, unless you changed it.)
          </p>
          <p>
            <strong>By default, the amount is not in the link at all.</strong> The claim page reads it
            from the ledger, so a link that has been edited to show a bigger number cannot fool the page.
            The other side of that: the ledger is public, so anyone who has the link&apos;s id can look
            the amount up the same way.
          </p>
          <p>
            <strong>The link&apos;s id leads to the sender.</strong> The id is public on the ledger,
            next to the amount and the sender&apos;s account. If that account has a @name, anyone who
            has the id can look the name up too. So the part after the # keeps a name out of previews
            and logs, not out of reach.
          </p>
          <p>
            <strong>Older links carry more.</strong> Links made on our website before 7 October 2026, and
            links made by our browser extension up to version 0.1.2 (what the stores serve until version
            0.1.3 passes their review), also carry the amount and the sender&apos;s name after the ?, where our website&apos;s
            host and a chat app that builds a preview can read them. The claim page still ignores that
            amount and reads the real one from the ledger, and keeps the chat preview plain.
          </p>
          <p>
            <strong>For a money link, chat previews stay plain unless the sender chooses otherwise.</strong>{" "}
            By default a preview shows only Lumenia and a general line. If the sender picks the rich
            preview, the amount, their name and the password marker go into the address, and the chat
            preview shows the amount and the name.
          </p>
          <p>
            <strong>A password-locked link carries only half the key.</strong> The other half is the
            password, which the sender tells you some other way and which never goes into the link.
            Pick one that is hard to guess: anyone holding the link can try guesses on their own
            computer, with no limit.
          </p>
          <p>
            <strong>A link is like cash.</strong> Anyone who has the whole link can take the money,
            unless it has a password. The whole link, # and all, sits in the chat message itself, so
            whoever can read that chat can read the key.
          </p>
          <p>
            <strong>Two other kinds of link.</strong> A request link (getlumenia.com/r/...), which asks
            someone to pay you, holds no money, and it is not private, by design: its address carries
            the amount you ask for, your name and, if you already have an account, your account address,
            because the payer&apos;s app needs them, and its chat preview shows your name and the
            amount. Everything said above about private links is about money links only. Practice
            links from our try-it page and event page use an older shape, whose address also carries the practice
            money&apos;s id on the ledger (practice money sits in a claimable balance, not the escrow
            contract).
          </p>
          <p>
            <strong>On those practice links, the key is also an account&apos;s key.</strong> Our server
            makes the key in a practice link, and the money first lands in the account that key opens.
            The app then moves it into an account whose key is made on your device, and closes the
            link&apos;s account, so a key that was in a link never becomes your home account. A device
            that claimed a practice link before 7 October 2026 may still use that link&apos;s account as
            its home: do not receive real money into it.
          </p>

          <h2 id="ledger">What the ledger shows, forever</h2>
          <p>
            Stellar is a public ledger. Anyone can read it on a public explorer such as stellar.expert,
            and nothing Lumenia does can remove what is written there. For every link it shows:
          </p>
          <ul>
            <li>
              the account that sent it, the contract that holds the money until it is claimed (the
              escrow), the amount, the time, and the date after which the sender can take it back. For a
              group link, also how many shares it holds.
            </li>
            <li>when it is claimed: the brand-new account that received the money, and when.</li>
            <li>
              our sponsor account, as the one that paid the network fees and the small reserve the new
              account needs to exist.
            </li>
            <li>
              later, if the recipient already had a home account, the move from that new account into
              it. Both hops are public.
            </li>
            <li>if nobody claims it and the sender takes it back: that return, too.</li>
          </ul>
          <p>
            The link&apos;s id is written next to both the sender and the account that claimed it, so
            anyone reading the ledger can connect the two. Paying an account directly is just as public,
            and so is sending money out to an exchange: the ledger shows your account, the
            exchange&apos;s address, the amount and the reference code (memo) the exchange gave you.
          </p>

          <h2 id="sponsor">What our sponsor sees</h2>
          <p>
            Our sponsor is the Lumenia server that pays the network fees, which is why the recipient pays
            no gas. There are two: one for practice money (lumenia-sponsor.avakit.workers.dev) and one
            for real money (lumenia-sponsor-mainnet.avakit.workers.dev). Both run on Cloudflare and keep
            their records in a database hosted by Upstash. Here is what reaches them, and what they keep.
          </p>
          <ul>
            <li>
              <strong>Your IP address</strong>, with every request, and the account the request is about.
              We use them to stop floods, and the counts they feed expire after about a minute. When a
              new account is opened, your IP address (or the block of addresses it belongs to) also goes
              into that day&apos;s count of new accounts, which is deleted two days after the last
              account opened from that address that day. If the same new account is asked for again
              that day (a retry), the repeat is counted under that account&apos;s address together with
              your IP address or its block, so that one address cannot use up somebody else&apos;s
              retries; that count is deleted two days after the last repeat. If the database cannot be
              reached, the server counts in its own memory instead, which empties when it restarts.
            </li>
            <li>
              <strong>When you send a link:</strong> the transaction you signed. It names your account,
              the link&apos;s id, the amount and the date you can take it back. The sponsor reads the
              amount to hold its limits. On real money those are $5 a link and up to $25 a day from you
              ($50 a day across the whole pilot), and the transfer also counts against your pilot
              allowance. To hold the daily limit for each sender, both servers keep a running total of
              what your account sent that day, filed under your account&apos;s address and deleted two
              days after your last send that day. These are running totals, not a list of transfers.
              Paying an account directly, or sending money out to an exchange, works the same way: the
              sponsor sees what that transaction names.
            </li>
            <li>
              <strong>When someone claims:</strong> the link&apos;s id and the brand-new account that
              receives the money. The ledger already shows anyone which account claimed which link, so
              the sponsor learns nothing new about who claimed what, apart from the IP address of the
              moment. Each time it opens a new account, for a claim or for anyone starting out, it keeps
              that account&apos;s address for two days as a marker that the account was already opened,
              so a retry costs nothing. Beyond those markers and the hashed counters below, it keeps no
              record of claims.
            </li>
            <li>
              <strong>When your app moves money home</strong> (see Fresh accounts below): the claim
              account, your home account and the amount. The ledger shows that move too.
            </li>
            <li>
              <strong>Bringing dollars from Base</strong> (practice money only): the id of your Base
              transaction. The sponsor asks Circle for its attestation and pays the fee. Both public
              ledgers show your Base address and your Lumenia account.
            </li>
            <li>
              <strong>Counters:</strong> a few named events, such as &quot;claim succeeded&quot; or
              &quot;link created&quot;. Each carries short one-way hashes (SHA-256, cut to 8 bytes, made
              on your device) of the link, account or request involved, and the public markers above
              (team-funded, made in the extension). A finished claim also sends how many seconds it took,
              which we keep only as a rough band. Never a web address, and never a link&apos;s key. A
              hash is no disguise from someone who already knows the address: they can compute the same
              hash. Daily counts are kept for 180 days. All-time totals, and the sets of hashed accounts
              that tell us whether people who claimed went on to send, moved money, or came back, have no
              end date.
            </li>
            <li>
              <strong>Your backup, if you make one:</strong> your key, locked with your password, which
              we cannot open. It is filed under a one-way hash of your email address, and normally
              carries a one-way hash of your account&apos;s address, so that only your account can
              replace it. If you add Face ID, a second copy is filed under an id that only your passkey
              can produce. Your email address itself is used only to send you a 6-digit code, through our
              email provider, Resend, and is not kept. The code is kept, hashed, for 10 minutes, and a
              count of codes asked for and tried, under the same hash, for an hour. The backup has no end
              date: it is your way back if you lose your phone. It brings back your account, not the
              list of links you sent (see Our website below). Backup and restore always go to the
              practice-money server, for both kinds of money, so one backup serves both.
            </li>
            <li>
              <strong>Ways back in, if you connect one</strong> (a passkey, an email address, or an
              account such as Google, GitHub or X where we offer it): a copy of the same locked backup,
              filed under a one-way hash of that identity, next to your account address, until you
              disconnect it. While you connect Google, GitHub or X, we hold the id and the name or email
              it sends us for up to five minutes. After that, only the hash.
            </li>
            <li>
              <strong>A @name, if you pick one:</strong> the name and the account it points to are
              public, because that is how people pay you by name. Anyone can look it up, and it ties that
              account&apos;s whole history on the ledger to the name, including every link it sends:
              anyone who has a link&apos;s id can find its sender&apos;s @name. If you release it, nobody can take
              it for 30 days, and for those 30 days we keep the record of which account held it.
            </li>
            <li>
              <strong>The real-money pilot:</strong> while the app is open on your screen, it asks the
              real-money server about once a minute, and again when you come back to the tab, whether
              your account is approved, with your account address in the request. It does this on
              practice money too. If you apply, we keep your
              email address next to your wallet address for 90 days, or less if we take you off the
              pilot, so we can tell you the answer. We also keep a one-way hash of your email next to that
              wallet, so one email cannot apply twice, plus your application&apos;s state and how many
              real-money transfers you have made. Those have no end date. Each application is emailed to
              us, and if that email cannot be sent, the server writes your wallet address and email
              address into its log instead, so the application is not lost. Our answer, approve or
              decline, is emailed to you through Resend; if that email fails, the server logs the wallet
              address, and your email address too if the mail service is not set up.
            </li>
            <li>
              <strong>The waitlist:</strong> if you ask us to tell you when real money or cash-out opens,
              your email address, on its own list, never next to a wallet or any money. It has no end date
              and no remove button yet: ask us through Report a problem and we will take it off. If you
              ask for real money before you have an account, we also email that address to ourselves, or
              write it into our log if that email cannot be sent.
            </li>
            <li>
              <strong>Report a problem:</strong> what you write, the topic you pick, the time, and a way
              to reach you only if you leave one. We do not attach your account to it. We keep the newest
              2,000 reports, and each one can also be emailed to us through Resend.
            </li>
            <li>
              <strong>Log lines:</strong> our servers print short lines for us to read. A counter line
              carries only the hashed ids above. On the real-money server, an error line names the part of
              the server that failed, with a short reference and the reason. The reason is one line,
              every account or contract address in it is cut to its first four characters, and a refused
              deposit, claim, take-back, payout or sweep is logged without its amount. If the database cannot be
              reached, a waitlist sign-up or a report goes into the log instead, so it is not lost.
              Cloudflare, which runs these servers, stores log lines only if its log storage (Workers
              Logs) is switched on for them, and then deletes them after 3 days, or 7 on a paid plan.
            </li>
          </ul>
          <p>
            <strong>Servers we do not run.</strong> Your balance, your activity and the state of a link
            are read straight from public Stellar servers. Like any server, they see your IP address and
            the account or link you ask about.
          </p>

          <h2 id="fresh-accounts">Fresh accounts</h2>
          <p>
            Every money link you claim lands in a brand-new account, made for that claim and never used
            for another claim. Nobody needs your address to pay you, and the claim never touches an
            account you already have. (Money paid to an address you gave out, such as the one a request
            link can carry, goes to that account instead.)
          </p>
          <p>
            If it is the first claim on your device, that new account becomes your home account (for a
            practice link, a second new account does, made from a key your device generates, and the
            money is moved into it straight away). If you already have one, the app moves the money into
            it by itself the next time you open your home screen, then closes the claim account. That move is a transaction too, so it is on the
            ledger: anyone who follows the money can see where it went. A fresh account keeps each claim
            apart when it happens. It does not hide the money afterwards.
          </p>

          <h2 id="never-stored">What we never store</h2>
          <ul>
            <li>
              Your money. It sits on the public ledger, in the escrow or in your own account, never in a
              Lumenia account.
            </li>
            <li>Your password. It never leaves your device, so we couldn&apos;t read it if we wanted to.</li>
            <li>The keys to your money in a form we can open.</li>
            <li>
              The key in a link, the part after the #. One exception: a practice link that our try-it or
              event page hands you is made by our server. It keeps a few ready-made ones, key included,
              until someone asks for one, never hands out one more than 40 minutes old, and throws older
              ones away when the next one is asked for. Once it hands a link out, it keeps no copy.
            </li>
            <li>
              The people you pay. Your contacts are worked out on your device, from your own history, and
              never sent to us.
            </li>
          </ul>

          <h2 id="extension">The browser extension</h2>
          <p>
            The Lumenia browser extension makes a payment link from a Lumenia account, one you make in
            the extension or one you already have, and shows whether it was claimed. Here is everything it sends, who gets it, what it keeps on
            your device, and what it never collects. It sends nothing until you press &quot;Agree and
            continue&quot; on its first screen.
          </p>
          <p>
            Version 0.1.2 and earlier put the amount and your sender name in the link&apos;s address,
            after the ?. Version 0.1.3, which reaches each store after that store&apos;s review, makes the
            same links as the website: no amount anywhere in the link, and a name only if you type one,
            after the #.
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
              <strong>To back up an account made in the extension:</strong>{" "}
              your email address and the 6-digit code we email you, then your backup, to Lumenia&apos;s
              server. The backup is your key locked with your password; we can&apos;t open it. It is
              signed by your account, so nobody who can only read your email can replace it.
            </li>
            <li>
              <strong>To add practice dollars (practice money only):</strong>{" "}
              your public key, and for a new account the transaction that opens it on the practice
              network, which Lumenia builds and pays for and your extension checks and signs.
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
              one-way hashes (SHA-256, cut to 8 bytes, of your account and, for a shared link, of the
              link: pseudonymous, since anyone who knows the address can compute the same hash) and the
              marker &quot;ext&quot;. Never a web address, never the link&apos;s secret. They go to the
              sponsor of the network you chose, only after you agree, and in Firefox only while you keep
              its optional technical and interaction data permission on.
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
            <li>
              For an account made in the extension, until you back it up: its backup, locked with your
              password, so it can be stored the moment you give an email.
            </li>
            <li>
              Your list of links (for each: the amount, the sender name you used if any, its link ID,
              network, dates, transaction IDs and status) and your settings. Version 0.1.2 also keeps the
              last sender name you used and fills it in next time; version 0.1.3 deletes that saved name and
              starts with no name every time.
            </li>
            <li>
              Each full link with its secret, encrypted with a key derived from your account key, so it
              can be shown again only while the extension is unlocked.
            </li>
            <li>
              In the browser&apos;s memory only, gone when the browser restarts: your key while you&apos;re
              unlocked (it locks after 15 minutes without use, and you can pick 5, 15 or 60); the email
              you typed while a restore or a backup is in progress; and, for up to 10 minutes after you
              choose &quot;Paste a Lumenia link here&quot;, the name of the site you chose it on, so the
              extension can show you where the link will go.
            </li>
          </ul>

          <p>What it never collects:</p>
          <ul>
            <li>
              Your browsing history, the pages you visit, or what is on them. The &quot;Paste a Lumenia
              link here&quot; menu item only types the finished link into the text box you right-clicked.
              It never sends a message. Once the link is in that box, that website can read all of it,
              key included, as if you had pasted it yourself.
            </li>
            <li>No ads, no third-party analytics kit, and nothing sold.</li>
          </ul>

          <p>
            To remove it, choose &quot;Forget this account&quot; in the extension&apos;s settings, which
            erases the key record, your links and your settings from this browser, or uninstall the
            extension. If the account was made in the extension and never backed up, it tells you first
            that forgetting it deletes the account and any money in it for good. If links you made are
            still open, it tells you that too: the extension holds the only list of them and the only
            way to take them back. Forgetting never moves your money: it waits on the public ledger, and
            if the account is backed up, your backup on Lumenia&apos;s server can bring it back, on
            getlumenia.com or in the extension.
          </p>

          <h2 id="website">Our website</h2>
          <p>
            <strong>The links you send are listed only in the browser you sent them from.</strong> The
            list (amount, name and link id) sits in that browser&apos;s storage, and each full link, key
            included, is kept there encrypted, so the page can show it again. Nothing of it is on our
            servers. Your backup brings back your account, not that list: if nobody claims a link in 7
            days, take it back from the browser you sent it from. It does not come back by itself.
          </p>
          <p>
            Our website runs on Vercel. Like any web host, it sees your IP address and the address of each
            page you open, up to the #, and keeps those request logs for a short time (one hour to one
            day, depending on the plan). Before 7 October 2026 a claim page&apos;s address carried the
            amount and the sender&apos;s name, so those logs did too. The claim pages tell your browser
            never to pass their address on to another site.
          </p>
          <p>
            Our public pages count visits with Vercel Web Analytics: this one, the try-it page, the event
            board and the tools, never the claim pages or the app&apos;s screens. It counts page views;
            it does not read what a page shows. Vercel&apos;s documentation says
            it uses no cookies and tells visitors apart by a hash of the request that resets every day.
            For each page view it may record the time, the page address (with query details filtered),
            the page you came from, your rough location (country, region and city), and your device
            type, operating system and browser. How long Vercel keeps those records is not stated in
            that documentation.
          </p>

          <p>
            We don&apos;t sell your data, and we don&apos;t want to hold anything we don&apos;t need.
            If any of this changes, we&apos;ll say so here plainly.
          </p>
          <p>
            To ask a question, or to ask us to remove something we hold, use Report a problem at the
            bottom of this page. Leave an email address in it if you want an answer.
          </p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
