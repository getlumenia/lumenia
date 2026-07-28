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
  { q: "What if I lose the link, or send it to the wrong chat?", a: "Treat a money link like cash in an envelope: whoever holds it can claim it, so send it in a private message to the person it’s for. If it goes to the wrong chat, or you lose your phone, don’t panic. As long as nobody has claimed it, the money comes back to you after 7 days. Once someone claims it, though, it’s gone, exactly like handing over cash. If that worries you, add a password when you send and the link stops being enough on its own." },
  { q: "Where can I send money from, and where to?", a: "Anywhere with a phone signal, in both directions. There’s no country list, because there are no bank rails involved in the handover: you send a link, they open it. We’re building for the Europe-to-Turkey route first, so that’s where the local detail is sharpest, but a link from Berlin lands the same as a link from anywhere else. The country only starts to matter at the very end, when someone wants local cash in a bank account, and that part depends on which licensed exchange operates where they live." },
  { q: "How do I make a link only the right person can claim?", a: "Add a password when you send it. The money won’t move until someone types it, and we can’t wave it through: the password is part of the key, not a box we tick on a server. One rule decides whether it actually helps. Send the password some other way, on a call or in a different app. Put it in the same chat as the link and anyone reading that chat has both, which is the exact mistake that catches people out. Choose something a stranger wouldn’t guess, because whoever holds the link can sit there and keep trying. Forget it yourself and nothing is lost: the money comes back to you after 7 days." },
  { q: "I sent a link to the wrong person. Can I cancel it?", a: "Not instantly, and we’d rather say that than pretend. If nobody has claimed it, the money returns to you 7 days after you sent it, without you doing anything. If they already claimed it, it’s theirs, the same as if you’d handed over cash to the wrong person in the street. That’s the trade a link makes: nothing to install for them, no undo button for you. The password is how you avoid needing one." },
  { q: "Is this a bank?", a: "No, and that’s deliberate. Banks hold your money; we never do. When you send with Lumenia, the money sits in escrow until your recipient claims it. There’s no deposit insurance because there’s no deposit, and nothing for us to hold. We’re a way to move money, not a place to keep it." },
  { q: "What does it cost?", a: "Receiving is always free. Your recipient never pays to accept money, and we cover the small network cost behind the scenes. When we introduce a sending fee, it will be a single number shown to you before you confirm, never taken out of what your recipient gets. One thing that isn’t ours to waive: if your recipient later turns the dollars into local money, the exchange doing that takes its own cut. We don’t see a penny of it, and we can’t discount it either." },
  { q: "What does my recipient actually need?", a: "A phone with a browser. That’s the whole list. No app, no account beforehand, no ID upload to see the money. They tap the link and the money is theirs. Afterwards they choose a password (or their face) to lock it to their phone, so nobody who picks up that phone can spend it. That’s their own lock on their own money, and it has nothing to do with the optional password you can put on a link when you send it. Yours guards the link on its way to them; theirs guards the money once it has arrived." },
  { q: "The money is “held in dollars”. What does that mean?", a: "It means the amount doesn’t wobble with crypto markets or shrink in a volatile currency while it waits. Your recipient can hold it as dollars and send it onward whenever they like. It is not a savings product: it earns nothing, and we’d be suspicious of anyone who told you otherwise." },
  { q: "Can my recipient turn it into lira in their bank account?", a: "Yes, but not inside Lumenia, and it isn’t one tap yet. Lumenia moves the dollars out for them in a single screen, with the deposit details checked before anything leaves. The lira part happens at a licensed exchange, because turning dollars into lira and paying them to a Turkish bank is regulated work and we deliberately never touch it. Today that route takes two Binance accounts, since the Turkish one doesn’t yet accept these dollars on the network they travel on. Our cash-out guide walks through it, states the waiting periods, and names the mistake that loses money. Plenty of people skip all of it and simply hold dollars, which is a reasonable thing to do when lira keeps losing value." },
  { q: "What happens if Lumenia disappears tomorrow?", a: "Your money doesn’t, because we never had it. It lives on a public ledger under your recipient’s control (or yours, for unclaimed links). This is the single most important design decision we made, and it’s the reason this FAQ answer can exist." },
  { q: "Is any of this actually real?", a: "Yes. The technology is live, and every claim in this page’s proof is backed by real, publicly verifiable transfers. You can try the whole thing yourself, start to finish, so you don’t have to take our word for any of it." },
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
            <img src="/brand-kit-assets/il-trust.webp" loading="lazy" decoding="async" alt="A shield of soft periwinkle light around a calm centre, your money held safe in escrow" />
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
