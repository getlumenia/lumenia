"use client";

/**
 * The deck itself: eight slides, one on screen at a time, driven by the keyboard, a swipe, the
 * dots or the two click zones. Only the active slide is animated, and only its direct children,
 * which keeps the entrance reading as one movement rather than eight things arriving at once.
 *
 * Everything here is static text. No counter on this page reads an endpoint: a projector on a
 * venue network is the worst place to discover that a fetch is slow, and the live numbers already
 * have a home on /event, which the deck points at instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Slide = { id: string; label: string; body: React.ReactNode };

const WORDMARK = "/brand-kit-assets/logo-wordmark-dark.svg";

/** A row of label plus sentence, the shape most of the deck repeats. */
function Row({ k, v, accent }: { k: string; v: React.ReactNode; accent?: boolean }) {
  return (
    <div className="dk-row">
      <h3 className={accent ? "dk-row-k dk-accent" : "dk-row-k"}>{k}</h3>
      <p className="dk-row-v">{v}</p>
    </div>
  );
}

const SLIDES: Slide[] = [
  {
    id: "cover",
    label: "Lumenia",
    body: (
      <div className="dk-cover">
        <div className="dk-cover-main">
          <p className="dk-eyebrow">Rise In x Stellar Pro Hackathon &middot; Scale Track</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="dk-wordmark" src={WORDMARK} alt="Lumenia" />
          <p className="dk-lead">
            Send dollars by link. The person receiving needs{" "}
            <b>no wallet, no app and no XLM</b>.
          </p>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="dk-mascot"
          src="/brand-kit-assets/mascot-wave-cut.webp"
          alt=""
          aria-hidden="true"
        />
      </div>
    ),
  },
  {
    id: "solution",
    label: "The solution",
    body: (
      <>
        <p className="dk-eyebrow">The solution</p>
        <h2 className="dk-h2">
          The sender locks the money.
          <br />
          The link travels.
          <br />
          The ledger releases it.
        </h2>
        <div className="dk-rows">
          <Row k="Before it moves" v="the USDC sits in an on-ledger escrow, a Soroban contract, never on our server" />
          <Row k="The limits" v="per-transfer cap, per-day cap, kill switch, caps that fail closed" />
          <Row k="Not a promise" v="the payout address is inside the signed message the contract checks" />
        </div>
        <p className="dk-kicker">An unclaimed payment comes back to the sender.</p>
      </>
    ),
  },
  {
    id: "why-now",
    label: "Why now",
    body: (
      <>
        <p className="dk-eyebrow">Why now</p>
        <h2 className="dk-h2 dk-h2-tight">
          Stablecoins became cheap and fast.
          <br />
          The person receiving them still has to become a crypto user.
        </h2>
        <p className="dk-pain">
          Every alternative asks the recipient to install an app, save twelve words and buy a coin
          for gas, before the first dollar arrives.
        </p>
        <div className="dk-cards dk-cards-3">
          <div className="dk-card">
            <h3>People sending home</h3>
            <p>Europe to Turkey, and they end up walking the other side through a wallet on the phone</p>
          </div>
          <div className="dk-card">
            <h3>People receiving</h3>
            <p>No wallet, no seed phrase, no XLM, and a lira balance that keeps shrinking</p>
          </div>
          <div className="dk-card">
            <h3>Anchors and PSPs</h3>
            <p>The same question at the fiat edge: the balance is fine, the wallet is missing</p>
          </div>
        </div>
        <p className="dk-foot">USDC settles on Stellar in seconds. The wall is the wallet, not the rail.</p>
      </>
    ),
  },
  {
    id: "escrow-gate",
    label: "The escrow gate",
    body: (
      <>
        <h2 className="dk-h2">The escrow gate</h2>
        <p className="dk-sub">Who may be paid is fixed by a signature on the device, not by our server.</p>
        <div className="dk-cards dk-cards-3">
          <div className="dk-card">
            <span className="dk-num">1</span>
            <h3>The link key signs</h3>
            <p>on the phone, over the contract, the network, the link and the payout account</p>
          </div>
          <div className="dk-card">
            <span className="dk-num">2</span>
            <h3>The sponsor submits</h3>
            <p>it opens the account, pays the reserves and the fee, and sources the call</p>
          </div>
          <div className="dk-card">
            <span className="dk-num">3</span>
            <h3>The contract verifies</h3>
            <p>and pays the address that was already inside the signed bytes</p>
          </div>
        </div>
        <div className="dk-rows">
          <Row accent k="It can decline" v="caps, rate limits, the allowlist and the kill switch all live in the relayer" />
          <Row k="It can never redirect" v="the payout is bound by the signature, so the only power left is refusal" />
        </div>
        <p className="dk-foot dk-mono">
          LumenDrop &middot; CAMCI5VP...CY2TN3HP3 (testnet) &middot; CAC5JYQ2...CU5UTEIWGR4 (mainnet)
        </p>
      </>
    ),
  },
  {
    id: "technical",
    label: "Technical workflow",
    body: (
      <>
        <p className="dk-eyebrow">Technical workflow</p>
        <h2 className="dk-code">ed25519_verify(link, message, sig)</h2>
        <p className="dk-sub dk-sub-wide">
          The person claiming has no account, so the claim cannot use <b>require_auth</b>. The
          contract verifies a signature over the contract, the network, the link and the payout, and
          pays that payout. Because the address is inside the signed bytes, the relayer that sources
          the call can submit it or refuse it, and nothing else.
        </p>
        <p className="dk-eyebrow">Why Stellar</p>
        <div className="dk-rows">
          <Row
            k="Sponsored reserves"
            v="CAP-33 opens a 0-XLM account with a USDC trustline in one sandwich, about 1.5 XLM of reserves that we pay"
          />
          <Row
            k="The anchor rail"
            v="SEP-1, SEP-10 and SEP-6 turn that balance into Turkish lira and back, without leaving the app"
          />
          <Row
            k="Native USDC"
            v="Circle's own asset as a Stellar Asset Contract, with no wrapper anywhere in the path"
          />
        </div>
        <p className="dk-foot">
          Built on Circle CCTP, the TR anchor over SEP-6, Stellar&apos;s built-in DEX and Soroban
          &middot; skills cited by path in the README &middot; 20 offline suites, 776 assertions
        </p>
      </>
    ),
  },
  {
    id: "see-it-work",
    label: "See it work",
    body: (
      <>
        <h2 className="dk-h2">See it work</h2>
        <p className="dk-sub">
          Two things a judge can do on their own phone, on the test network, in under a minute.
        </p>
        <div className="dk-cards dk-cards-2">
          <div className="dk-card dk-card-lg">
            <h3>One link, many people</h3>
            <p>
              A school trip, six seats at $15.00. Every person who opens the same link takes one
              share into an account that did not exist a moment ago.
            </p>
            <p className="dk-dim">
              The pot can never pay more than its seats, one phone takes one share, and the leftover
              goes back to the organiser when the link closes.
            </p>
          </div>
          <div className="dk-card dk-card-lg">
            <h3>Lira in, lira out</h3>
            <p>
              Through the organisers&apos; sandbox anchor over SEP-6, measured through the product
              itself: 100.00 TRY paid <b>2.0396090 USDC in 27.4 s</b>.
            </p>
            <p className="dk-dim">
              Cash out runs the same rail backwards, and the anchor&apos;s own rate, deadline and
              payout account are shown exactly as it returns them.
            </p>
          </div>
        </div>
        <div className="dk-rows">
          <Row
            accent
            k="Dollars from Base"
            v={
              <>
                Circle CCTP, burned on Base Sepolia and minted on Stellar by our relay in{" "}
                <b>16 s</b>, then straight out again as a link
              </>
            }
          />
        </div>
        <p className="dk-foot">
          Try it yourself at getlumenia.com &middot; the live board is at getlumenia.com/event
        </p>
      </>
    ),
  },
  {
    id: "traction",
    label: "Traction",
    body: (
      <>
        <h2 className="dk-h2">Traction</h2>
        <p className="dk-sub">Small numbers, all of them real, each one with its dollar value beside it.</p>
        <div className="dk-table" role="table" aria-label="What has happened so far">
          <div className="dk-tr dk-th" role="row">
            <span role="columnheader">Where</span>
            <span role="columnheader">What happened</span>
            <span role="columnheader">Read it as</span>
          </div>
          <div className="dk-tr" role="row">
            <span role="cell">Mainnet, hand-approved pilot</span>
            <span role="cell">69 accounts opened, 109 real transfers, about $4.4 moved in total</span>
            <span role="cell" className="dk-dim">
              A plumbing proof with real money, not demand. Median $0.002, maximum $1.00.
            </span>
          </div>
          <div className="dk-tr" role="row">
            <span role="cell">Testnet, the open product</span>
            <span role="cell">The whole loop, both lira legs and the bridge in</span>
            <span role="cell" className="dk-dim">
              What a judge can reproduce today without asking us for anything.
            </span>
          </div>
          <div className="dk-tr" role="row">
            <span role="cell">This weekend, seeded</span>
            <span role="cell">links we funded ourselves, counted on their own line</span>
            <span role="cell" className="dk-dim">
              Seeded links never count as someone adopting us.
            </span>
          </div>
          <div className="dk-tr" role="row">
            <span role="cell">This weekend, organic</span>
            <span role="cell">claims by people who are not us, and who then sent a link</span>
            <span role="cell" className="dk-dim">
              The number that matters: a recipient who becomes a sender. Live on /event.
            </span>
          </div>
        </div>
        <div className="dk-rows">
          <Row
            accent
            k="Next step"
            v="Two Instawards received in 2026, the follow-on running to 17 October, then the SCF Build Integration Track with a referral from this room"
          />
        </div>
        <p className="dk-foot">
          Mainnet is a capped, hand-approved pilot, not a launch. The lira rail is a sandbox anchor.
          Not audited.
        </p>
      </>
    ),
  },
  {
    id: "team",
    label: "The team",
    body: (
      <>
        <h2 className="dk-h2">The team</h2>
        <div className="dk-team">
          <div className="dk-team-main">
            <h3 className="dk-name">Meric Cintosun</h3>
            <p className="dk-sub">Stellar Turkiye ambassador. Product, protocol and the whole build.</p>
            <div className="dk-rows dk-rows-sm">
              <Row accent k="Instawards" v="two received in 2026, the follow-on runs to 17 October" />
              <Row accent k="Shipped" v="a Soroban escrow, a sponsored-account relayer and a live anchor rail" />
              <Row accent k="Measured" v="a capped mainnet pilot with real USDC, reported at its real size" />
            </div>
          </div>
          <div className="dk-card dk-ask">
            <h3>What we are asking for</h3>
            <p>
              A referral into the SCF Build Integration Track, one introduction to a licensed Turkish
              payout partner, and tester cohorts for the question we have not answered yet: does a
              sender adopt this?
            </p>
          </div>
        </div>
        <p className="dk-kicker dk-kicker-serif">
          Every claim opens a new Stellar account.
          <br />
          The number we count is how many of them act again.
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="dk-mascot dk-mascot-sm"
          src="/brand-kit-assets/mascot-celebrate-cut.webp"
          alt=""
          aria-hidden="true"
        />
        <p className="dk-foot">github.com/getlumenia/lumenia &middot; getlumenia.com</p>
      </>
    ),
  },
];

export function Deck() {
  const [i, setI] = useState(0);
  const [entered, setEntered] = useState(0); // bumped on every move, so the animation replays
  const touchX = useRef<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  // The keyboard handler is bound once, so it reads the index from here rather than from a stale
  // closure. Setting state from inside a state updater would double-fire under StrictMode.
  const iRef = useRef(0);

  const go = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(SLIDES.length - 1, next));
    if (clamped === iRef.current) return;
    iRef.current = clamped;
    setI(clamped);
    setEntered((n) => n + 1);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
          e.preventDefault();
          go(iRef.current + 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          go(iRef.current - 1);
          break;
        case "Home":
          e.preventDefault();
          go(0);
          break;
        case "End":
          e.preventDefault();
          go(SLIDES.length - 1);
          break;
        case "f":
        case "F":
          if (document.fullscreenElement) document.exitFullscreen();
          else stage.current?.requestFullscreen?.().catch(() => {});
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const slide = SLIDES[i];

  return (
    <div className="dk" ref={stage}>
      <div className="dk-progress" aria-hidden="true">
        <span style={{ width: `${((i + 1) / SLIDES.length) * 100}%` }} />
      </div>

      <div
        className="dk-stage"
        onTouchStart={(e) => {
          touchX.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e) => {
          const start = touchX.current;
          const end = e.changedTouches[0]?.clientX ?? null;
          touchX.current = null;
          if (start == null || end == null) return;
          const dx = end - start;
          if (Math.abs(dx) > 60) go(dx < 0 ? i + 1 : i - 1);
        }}
      >
        {/* The key forces a remount, which is what replays the entrance animation. */}
        <section key={`${slide.id}-${entered}`} className={`dk-slide dk-slide-${slide.id}`} aria-live="polite">
          {slide.body}
        </section>
      </div>

      <button className="dk-zone dk-zone-prev" onClick={() => go(i - 1)} aria-label="Previous slide" disabled={i === 0} />
      <button
        className="dk-zone dk-zone-next"
        onClick={() => go(i + 1)}
        aria-label="Next slide"
        disabled={i === SLIDES.length - 1}
      />

      {/* Stellar's own mark, on every slide: the product is built on Stellar and the room is a
          Stellar room. The file is the official white lockup from stellar/stellar-docs, copied
          into public/deck so the deck never depends on a remote asset on venue wifi. */}
      <div className="dk-stellar">
        <span>Built on</span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/deck/stellar-logo-white.svg" alt="Stellar" />
      </div>

      <nav className="dk-dots" aria-label="Slides">
        {SLIDES.map((s, n) => (
          <button
            key={s.id}
            className={n === i ? "dk-dot dk-dot-on" : "dk-dot"}
            onClick={() => go(n)}
            aria-label={`${n + 1}. ${s.label}`}
            aria-current={n === i ? "true" : undefined}
          />
        ))}
        <span className="dk-count">
          {i + 1} / {SLIDES.length}
        </span>
      </nav>

      {/* Printing gives a PDF of the whole deck, one slide per page, which is what a submission
          portal usually wants. The live view only ever shows the active slide. */}
      <div className="dk-print" aria-hidden="true">
        {SLIDES.map((s) => (
          <section key={s.id} className={`dk-slide dk-slide-${s.id}`}>
            {s.body}
          </section>
        ))}
      </div>
    </div>
  );
}
