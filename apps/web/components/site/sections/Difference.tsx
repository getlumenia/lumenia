/**
 * Difference — a short beat between the fears and the moment. Everything else in this space puts
 * the work on the person RECEIVING: install an app, open an account, keep a secret phrase, buy
 * coins before they can accept a cent. Lumenia moves all of that onto the sender's side, where the
 * motivation already is. That asymmetry is the product, so it gets one plain statement of its own
 * rather than being left for the reader to infer from the how-it-works reel.
 *
 * No competitor is named and nothing technical appears: this beat has to land on someone who has
 * never installed a wallet. The struck-through list borrows the subtraction motif the Fears section
 * establishes (name the thing, then take it away).
 */
"use client";

import { motion } from "motion/react";

const EASE = [0.2, 0.7, 0.2, 1] as const;

// What everyone else asks the RECEIVER to do first. Struck through as they scroll in.
const ASKS = ["An app to install", "An account to open", "A secret phrase to keep safe", "Coins to buy first"];

export function Difference() {
  return (
    <section className="diff">
      <div className="diff-inner">
        <motion.div
          className="diff-copy"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.6, ease: EASE }}
        >
          <p className="diff-eyebrow">
            <span className="diff-dot" aria-hidden="true" />
            The difference
          </p>
          <h2 className="diff-h">You send. They just tap.</h2>
          <p className="diff-p">
            Everywhere else, the person receiving does the hard part. Lumenia takes all of that off
            them. Send a link, they tap it, and the dollars are theirs. Nothing to set up, and
            receiving is free.
          </p>
        </motion.div>

        <ul className="diff-list">
          {/* Labelled, because four struck-through lines on their own read as OUR list of
              requirements rather than the one we're taking away. */}
          <motion.li
            className="diff-label"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, amount: 0.6 }}
            transition={{ duration: 0.4, ease: EASE }}
          >
            What they&apos;d need anywhere else
          </motion.li>
          {ASKS.map((ask, i) => (
            <motion.li
              key={ask}
              className="diff-ask"
              initial={{ opacity: 0, x: -12 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ duration: 0.45, delay: i * 0.09, ease: EASE }}
            >
              <span className="diff-ask-text">{ask}</span>
            </motion.li>
          ))}
          <motion.li
            className="diff-answer"
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.6 }}
            transition={{ duration: 0.5, delay: ASKS.length * 0.09 + 0.1, ease: EASE }}
          >
            None of it. They open a link.
          </motion.li>
        </ul>
      </div>
    </section>
  );
}
