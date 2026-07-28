/**
 * Beats — the four technical beats of /how-it-works, as an audit trail that draws itself.
 *
 * Each beat carries a soft-3D icon from the brand-kit set, and the connector between one mark and
 * the next DRAWS DOWN as that beat arrives — the trail being written as you read it. The numerals
 * are the page's own register: brand.md §8 bans mono rails and "01/02/03" numerals on CONSUMER
 * sections (which is why the landing's own how-it-works section has none), and this is the one page
 * whose job is to look like an audit.
 *
 * The icon semantics follow the ones the landing already established in Fears:
 *   check → it's real / publicly checkable · key → who can open it · hand → receiving, free
 *   shield → safe, we never hold it
 *
 * MOTION RULE, learned twice in this codebase and not to be relearned: only aria-hidden decoration
 * animates on opacity. Fading text to make it appear costs contrast at every frame it is faded —
 * the landing's HowItWorks quietens its steps with COLOUR for exactly this reason, and a dissolve
 * wrapped around this page's CTA already failed Lighthouse once (a11y 96). Every heading, paragraph
 * and chip below paints at full strength immediately; the icons and the rail are the only things
 * that move, and they owe no contrast because they carry no information.
 */
"use client";

import { useRef } from "react";
import { useInView } from "motion/react";

const BEATS = [
  {
    icon: "/brand-kit-assets/icon-check.webp",
    h: "The money sits on a public ledger, not with us.",
    body: (
      <>
        Lumenia is built on <strong>Stellar</strong>, a fast, low-cost public ledger, and the money is{" "}
        <strong>USDC</strong>, a dollar-denominated asset. Lumenia never takes custody. There is no
        Lumenia account holding your money on your behalf; it sits on the ledger, in a balance we
        have no power to move.
      </>
    ),
    chips: [
      ["network", "Stellar"],
      ["asset", "USDC"],
    ],
  },
  {
    icon: "/brand-kit-assets/icon-key.webp",
    h: "It waits in a Claimable Balance.",
    body: (
      <>
        When you send, the amount is locked into a <strong>Claimable Balance</strong> with exactly
        two claimants: your recipient, who can claim it at any time, and you, who can reclaim it
        after 7 days if they never do. Nobody else is on that list, Lumenia included.
      </>
    ),
    chips: [
      ["claimants", "2"],
      ["recipient", "unconditional"],
      ["sender", "after 7 days"],
    ],
  },
  {
    icon: "/brand-kit-assets/icon-hand.webp",
    h: "Your recipient pays no gas.",
    body: (
      <>
        A new Stellar account normally needs a reserve of the network&apos;s native asset (XLM)
        before it can hold anything, plus a fee for every transaction. Lumenia&apos;s sponsor
        service covers both: <strong>sponsored reserves</strong> for the account and its trustline,
        and a <strong>fee-bump</strong> wrapped around the claim. The recipient ends up holding 0 XLM
        and pays nothing to receive.
      </>
    ),
    chips: [
      ["sponsored", "reserves"],
      ["fee", "bumped by sponsor"],
      ["recipient XLM", "0"],
    ],
  },
  {
    icon: "/brand-kit-assets/icon-shield.webp",
    h: "The sponsor cannot reach your money.",
    body: (
      <>
        {/* The space after </strong> is explicit because JSX dropped it here — measured: the
            source had a plain space and the rendered HTML came out "refuses</strong>to sign". */}
        The sponsor signs, so the question worth asking is what it <strong>refuses</strong>{" "}
        to sign. An allowlist validator checks every transaction against the source and the parameters of each
        operation, not just its type: the sponsor may only source the sponsorship and
        account-creation operations, a created account must start at zero, and anything that would
        move value is rejected outright. A constraint it cannot verify is a rejection, not an
        exception. The sponsor is never a signer on a user&apos;s account.
      </>
    ),
    chips: [
      ["policy", "strict by default"],
      ["payment", "rejected"],
      ["user account signer", "never"],
    ],
  },
];

function Beat({ beat, i }: { beat: (typeof BEATS)[number]; i: number }) {
  const ref = useRef<HTMLElement>(null);
  // `once` so the trail stays drawn behind you — a connector that un-draws on the way back up reads
  // as a glitch, not a transition.
  const inView = useInView(ref, { once: true, amount: 0.4 });
  return (
    <article className="hw-beat" data-in={inView} ref={ref}>
      <span className="hw-beat-mark" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="hw-beat-icon" src={beat.icon} alt="" loading="lazy" decoding="async" />
      </span>
      <h3 className="hw-beat-h">
        <span className="hw-beat-n" aria-hidden="true">
          {String(i + 1).padStart(2, "0")}
        </span>
        {beat.h}
      </h3>
      <div className="hw-beat-body">
        <p className="hw-beat-p">{beat.body}</p>
        <ul className="hw-chips">
          {beat.chips.map(([k, v]) => (
            <li className="hw-chip" key={k}>
              {k} <b>{v}</b>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

export function Beats() {
  return (
    <section className="hw-beats" aria-labelledby="hw-mechanism">
      <div className="hw-beats-inner">
        <h2 id="hw-mechanism" className="sr-only">
          The mechanism
        </h2>
        {BEATS.map((b, i) => (
          <Beat beat={b} i={i} key={b.h} />
        ))}
      </div>
    </section>
  );
}
