/**
 * HowItWorks — section 4, a pinned scroll story. Three brand illustrations (soft-3D, il-*) crossfade
 * on the right while a progress rail + step copy advance on the left. No "01/02" numeral rails
 * (brand.md §8) — just titles and the filling rail. Scroll ranges stay in [0,1].
 */
"use client";

import { useRef } from "react";
import Link from "next/link";
import { motion, useScroll, useTransform, type MotionValue } from "motion/react";
import { clamp } from "./utils";

const HIW = [
  { img: "/brand-kit-assets/il-abstract.png", t: "You send a link.", b: "Choose an amount and share it in a chat, like anything else. That’s the whole transfer." },
  { img: "/brand-kit-assets/il-phone.png", t: "They tap it.", b: "Your recipient sees the money the moment they tap — before creating anything." },
  { img: "/brand-kit-assets/il-celebrate.png", t: "It’s theirs.", b: "They claim it with their face or a password. Receiving is free. Done." },
];

function HiwFrame({ i, last, step, p }: { i: number; last: number; step: (typeof HIW)[number]; p: MotionValue<number> }) {
  const c = (i + 0.5) / HIW.length;
  const w = 0.5 / HIW.length;
  // First frame stays fully visible from the very start (no empty frame), last frame stays to the end.
  const opacity = useTransform(
    p,
    [clamp(c - w - 0.02), clamp(c - w + 0.03), clamp(c + w - 0.03), clamp(c + w + 0.02)],
    [i === 0 ? 1 : 0, 1, 1, i === last ? 1 : 0],
  );
  // Subtle zoom kept ABOVE 1 so the illustration always fully covers the frame — no gaps.
  const scale = useTransform(p, [clamp(c - w - 0.05), clamp(c + w + 0.05)], [1.06, 1.0]);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <motion.img className="hiw-fr" style={{ opacity, scale }} src={step.img} alt="" aria-hidden="true" />
  );
}

function HiwStep({ i, step, p }: { i: number; step: (typeof HIW)[number]; p: MotionValue<number> }) {
  const c = (i + 0.5) / HIW.length;
  const opacity = useTransform(p, [clamp(c - 0.16), c, clamp(c + 0.16)], [0.3, 1, 0.3]);
  return (
    <motion.div className="hiw-strow" style={{ opacity }}>
      <h3 className="hiw-stt">{step.t}</h3>
      <p className="hiw-stb">{step.b}</p>
    </motion.div>
  );
}

export function HowItWorks() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const railFill = useTransform(scrollYProgress, [0.06, 0.94], ["0%", "100%"]);
  return (
    <section className="hiw" ref={ref}>
      <div className="hiw-sticky">
        <div className="hiw-copy">
          <p className="hiw-eyebrow"><span className="hiw-dot" />How it works</p>
          <h2 className="hiw-title">A transfer, start to finish.</h2>
          <div className="hiw-list">
            <div className="hiw-rail"><motion.div className="hiw-rail-fill" style={{ height: railFill }} /></div>
            <div className="hiw-rows">
              {HIW.map((s, i) => (
                <HiwStep key={s.t} i={i} step={s} p={scrollYProgress} />
              ))}
            </div>
          </div>
          <Link href="/how-it-works" className="hiw-more">See a real transfer, verified →</Link>
        </div>
        <div className="hiw-frames">
          <div className="hiw-frwrap">
            {HIW.map((s, i) => (
              <HiwFrame key={s.t} i={i} last={HIW.length - 1} step={s} p={scrollYProgress} />
            ))}
            <div className="hiw-frglow" />
          </div>
        </div>
      </div>
    </section>
  );
}
