/**
 * Trust — section 6, "Where is my money, exactly?". Redesigned to be compact + interactive: the
 * escrow model is four soft-3D-iconed cards (shadcn <Card>, hover-lift, whileInView stagger) instead
 * of a text wall, and the questions are a proper shadcn <Accordion>. il-trust anchors the heading.
 */
"use client";

import { motion } from "motion/react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Four trust facts — condensed from the comms §6 copy for the card format; the FAQ carries the depth.
const TRUST_POINTS = [
  { icon: "/brand-kit-assets/icon-shield.webp", lead: "Not with us.", body: "Your money moves into escrow the moment you send. We never hold it, so we can’t lend it or lose it." },
  { icon: "/brand-kit-assets/icon-key.webp", lead: "Only two people can move it.", body: "Your recipient can claim it. If they don’t within 7 days, it comes back to you. Nobody else can touch it, including us." },
  { icon: "/brand-kit-assets/icon-check.webp", lead: "Every claim is checkable.", body: "Each transfer is a public record. Don’t believe this page? Open it and check for yourself." },
  { icon: "/brand-kit-assets/icon-hand.webp", lead: "Not a bank.", body: "No accounts, no balance we control, nothing with our name on it. We move money from you to someone you love, then step out of the way." },
];

const FAQ = [
  { q: "What if I lose the link, or send it to the wrong chat?", a: "Treat a money link like cash in an envelope: whoever holds it can claim it, so send it in a private message to the person it’s for. If it goes to the wrong chat, or you lose your phone, don’t panic. As long as nobody has claimed it, the money comes back to you after 7 days. Once someone claims it, though, it’s gone, exactly like handing over cash." },
  { q: "Is this a bank?", a: "No, and that’s deliberate. Banks hold your money; we never do. When you send with Lumenia, the money sits in escrow until your recipient claims it. There’s no deposit insurance because there’s no deposit, and nothing for us to hold. We’re a way to move money, not a place to keep it." },
  { q: "What does it cost?", a: "During the pilot: nothing. Receiving will always be free. Your recipient never pays to accept money, and we cover the small network cost behind the scenes. When we introduce a sending fee, it will be a single number shown to you before you confirm, never taken out of what your recipient gets." },
  { q: "What does my recipient actually need?", a: "A phone with a browser. That’s the whole list. No app, no account beforehand, no ID upload to see the money. They tap the link, see the amount, and claim it with their face or a password they choose." },
  { q: "The money is “held in dollars” — what does that mean?", a: "It means the amount doesn’t wobble with crypto markets or shrink in a volatile currency while it waits. Your recipient can hold it as dollars and send it onward whenever they like. It is not a savings product: it earns nothing, and we’d be suspicious of anyone who told you otherwise." },
  { q: "Can my recipient turn it into lira in their bank account?", a: "Not inside Lumenia yet, and we’re honest about that. Cash-out will run through licensed local partners, and we’ll ship it when it’s genuinely reliable, not a day before. Today, recipients can hold dollars and send money onward to others." },
  { q: "What happens if Lumenia disappears tomorrow?", a: "Your money doesn’t, because we never had it. It lives on a public ledger under your recipient’s control (or yours, for unclaimed links). This is the single most important design decision we made, and it’s the reason this FAQ answer can exist." },
  { q: "Is this real, or a demo?", a: "Both, honestly. The technology is live, and every claim in this page’s proof is backed by real, publicly verifiable transfers, currently on a test network with test money. We’d rather show you a working pilot and say so plainly than launch quietly with your rent money." },
];

const EASE = [0.2, 0.7, 0.2, 1] as const;

export function Trust() {
  return (
    <section className="trust">
      <div className="trust-inner">
        <div className="trust-head">
          <motion.div
            className="trust-headcopy"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.6 }}
            transition={{ duration: 0.6, ease: EASE }}
          >
            <p className="trust-eyebrow"><span className="trust-dot" />The honest answer</p>
            <h2 className="trust-h">Where is my money, exactly?</h2>
            <p className="trust-intro">Fair question. Four facts, then anything else you want to ask.</p>
            <Badge variant="secondary" className="trust-badge">
              <span className="trust-badge-star" aria-hidden="true" />
              Publicly verifiable
            </Badge>
          </motion.div>
          <motion.figure
            className="trust-il"
            initial={{ opacity: 0, scale: 0.92, rotate: -3 }}
            whileInView={{ opacity: 1, scale: 1, rotate: 0 }}
            viewport={{ once: true, amount: 0.5 }}
            transition={{ duration: 0.7, ease: EASE }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand-kit-assets/il-trust.webp" loading="lazy" decoding="async" alt="A shield of soft periwinkle light around a calm centre — your money, held safe in escrow" />
          </motion.figure>
        </div>

        <div className="trust-cards">
          {TRUST_POINTS.map((p, i) => (
            <motion.div
              key={p.lead}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ duration: 0.5, delay: i * 0.08, ease: EASE }}
            >
              <Card className="trust-card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="trust-card-icon" src={p.icon} loading="lazy" decoding="async" alt="" aria-hidden="true" />
                <h3 className="trust-card-lead">{p.lead}</h3>
                <p className="trust-card-body">{p.body}</p>
              </Card>
            </motion.div>
          ))}
        </div>

        <motion.div
          className="faq"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <h3 className="faq-h">Questions</h3>
          <Accordion type="single" collapsible className="faq-acc">
            {FAQ.map((f, i) => (
              <AccordionItem key={f.q} value={`faq-${i}`} className="faq-acc-item">
                <AccordionTrigger className="faq-acc-trigger">{f.q}</AccordionTrigger>
                <AccordionContent className="faq-acc-content">{f.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </motion.div>
      </div>
    </section>
  );
}
