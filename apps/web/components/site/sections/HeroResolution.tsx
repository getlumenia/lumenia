/**
 * HeroResolution — the hero's payoff: the subtraction settles into the promise + the real demo.
 * Rendered right after the scrub hero, still inside .op-over (z1) so it scrolls up over the pinned
 * greeting (the overlay-reveal transition). A living bg-hero-bloom backdrop sits behind; the copy
 * staggers in on view. Copy is the comms-approved §6 headline.
 */
"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { AmbientVideo } from "../AmbientVideo";

const EASE = [0.2, 0.7, 0.2, 1] as const;
const rise = (delay: number) => ({
  initial: { opacity: 0, y: 22 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.6 },
  transition: { duration: 0.6, delay, ease: EASE },
});

export function HeroResolution() {
  return (
    <section className="op-after">
      {/* Living hero backdrop (brand-kit bg-hero-bloom) — a soft periwinkle bloom behind the promise.
          Muted by a paper scrim so the headline stays crisp; reduced-motion falls back to the still. */}
      <AmbientVideo className="op-after-bg" poster="/brand-kit-assets/bg-hero.webp"
        sources={["/brand-kit-assets/video/bg-hero-bloom.webm", "/brand-kit-assets/video/bg-hero-bloom.mp4"]} />
      <div className="op-after-scrim" aria-hidden="true" />
      <motion.p className="op-after-eyebrow" {...rise(0)}>Nothing to set up.</motion.p>
      <motion.h1 className="op-after-h" {...rise(0.08)}>Money home, in a link.</motion.h1>
      <motion.p className="op-after-p" {...rise(0.16)}>
        Send money by link. They tap it and it&rsquo;s theirs — no wallet, no seed phrase, no app.
        Held in dollars until they need it.
      </motion.p>
      <motion.div className="op-after-cta" {...rise(0.24)}>
        <Link href="/demo" className="op-btn op-btn-primary">Try the live demo</Link>
        <Link href="/how-it-works" className="op-btn op-btn-ghost">See how it works →</Link>
      </motion.div>
    </section>
  );
}
