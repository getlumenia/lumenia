/**
 * HowItWorks — section 4, a pinned scroll story. Three brand illustrations (soft-3D, il-*) crossfade
 * on the right while a progress rail + step copy advance on the left. No "01/02" numeral rails
 * (brand.md §8) — just titles and the filling rail. Scroll ranges stay in [0,1].
 */
"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { motion, useMotionValueEvent, useScroll, useTransform, type MotionValue } from "motion/react";
import { clamp } from "./utils";

const HIW = [
  { img: "/brand-kit-assets/il-abstract.webp", t: "You send a link.", b: "Choose an amount and share it in a chat, like anything else. That’s the whole transfer." },
  { img: "/brand-kit-assets/il-phone.webp", t: "They tap it.", b: "Your recipient sees the money the moment they tap, before they've made anything." },
  { img: "/brand-kit-assets/il-celebrate.webp", t: "It’s theirs.", b: "They claim it with their face or a password. Receiving is free. Done." },
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
    <motion.img className="hiw-fr" style={{ opacity, scale }} src={step.img} loading="lazy" decoding="async" alt="" aria-hidden="true" />
  );
}

/**
 * The inactive steps are quietened with COLOUR, not opacity.
 *
 * They used to fade to opacity .3, which blends the text into the paper: 2.45:1 on the title and
 * 1.72:1 on the body — both far under WCAG AA. There is no opacity floor that fixes it either;
 * --pw-muted is only 5.34:1 at FULL strength, so any fade at all drops the body under 4.5:1.
 * Swapping the colour instead keeps every state at the token's own contrast (ink 15.3:1 active,
 * muted 5.3:1 / 7.1:1 quiet) while reading the same: the live step is the black one.
 * The illustration still cross-fades on opacity — it is aria-hidden, so it owes no contrast.
 */
function HiwStep({ i, step, p }: { i: number; step: (typeof HIW)[number]; p: MotionValue<number> }) {
  const c = (i + 0.5) / HIW.length;
  const [active, setActive] = useState(i === 0);
  // Same window the opacity ramp used, so the step lights up on exactly the same beat as before.
  useMotionValueEvent(p, "change", (v) => setActive(Math.abs(v - c) < 0.16));
  return (
    <div className="hiw-strow" data-active={active}>
      <h3 className="hiw-stt">{step.t}</h3>
      <p className="hiw-stb">{step.b}</p>
    </div>
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
