/**
 * Proof — section 5, proof + Stellar (brand.md §12.4 / §4.4). The ONE strip where the chain is
 * named with pride, on the Stellar-dark palette (navy + Stellar yellow + lavender). A real,
 * tappable on-chain receipt (real Stellar tx from /how-it-works) + the SCF trust seal. No mock
 * data (§8) — the tx hash resolves on stellar.expert.
 */
"use client";

import { motion } from "motion/react";
import { Badge } from "@/components/ui/badge";

const PROOF_TX = "b9ef1844c6ca2df732648b965a2f991ba0197643057b2c9e2a60ab52c3e23746";
const PROOF_URL = `https://stellar.expert/explorer/testnet/tx/${PROOF_TX}`;
const PROOF_SHORT = "b9ef1844…c3e23746";

export function Proof() {
  return (
    <section className="proof">
      <div className="proof-inner">
        <motion.div
          className="proof-copy"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.6, ease: [0.2, 0.7, 0.2, 1] }}
        >
          <p className="proof-eyebrow">Proof, not promises</p>
          <h2 className="proof-h">Don’t take our word for it.</h2>
          <p className="proof-p">
            Every transfer is written to <strong>Stellar</strong>, a public ledger no single
            company owns. We can’t hide it or quietly change it. Open any transfer and check it
            against the record yourself.
          </p>
          <Badge className="proof-seal">
            <span className="proof-seal-star" aria-hidden="true" />
            Backed by the Stellar Community Fund
          </Badge>
        </motion.div>

        <motion.a
          className="proof-receipt"
          href={PROOF_URL}
          target="_blank"
          rel="noreferrer"
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.6, delay: 0.12, ease: [0.2, 0.7, 0.2, 1] }}
        >
          <div className="proof-rc-top">
            <span className="proof-rc-label">Public receipt</span>
            <span className="proof-rc-net">Stellar</span>
          </div>
          <p className="proof-rc-what">
            20 USDC landed in a brand-new account holding 0 XLM. It was claimed walletless, and the
            recipient paid no gas.
          </p>
          <div className="proof-rc-hash">
            <span className="proof-rc-k">tx</span>
            <span className="proof-rc-v">{PROOF_SHORT}</span>
          </div>
          <span className="proof-rc-cta">
            Verify on Stellar <span className="proof-rc-arrow">→</span>
          </span>
        </motion.a>
      </div>
    </section>
  );
}
