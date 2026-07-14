/**
 * SectionReveal — a scroll-linked entry transition wrapper so every landing section hands off with
 * motion (the brand-kit transition feel, adapted to real variable-height content). It only animates
 * FLOW-SAFE properties (opacity / clip-path / filter) — never transform — so it can wrap sections
 * that contain `position:sticky` internals (the scrub reel, the pinned how-it-works) without breaking
 * their pinning. Sticky sections must use `dissolve` (opacity only); clip/filter can trap sticky.
 *
 * Kinds:
 *   dissolve — opacity fade (the sticky-safe default)
 *   curtain  — a top-down clip-path reveal (no bg show-through; good for paper sections)
 *   iris     — an expanding circular clip-path reveal (dramatic; the Stellar strip)
 *   focus    — a blur→sharp "focus pull" (opacity kept high so no dark tint)
 */
"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform, useReducedMotion } from "motion/react";

type Kind = "dissolve" | "curtain" | "iris" | "focus";

export function SectionReveal({
  kind = "dissolve",
  className,
  children,
}: {
  kind?: Kind;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  // Span the entry so the transition is actually visible: from the section just peeking in (92%
  // down) to mostly in view (32% down).
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 92%", "start 32%"] });

  const opacity = useTransform(scrollYProgress, [0, 0.8], [0.45, 1]);
  const opacityHigh = useTransform(scrollYProgress, [0, 0.7], [0.65, 1]);
  const blur = useTransform(scrollYProgress, [0, 0.7], ["blur(6px)", "blur(0px)"]);
  const curtain = useTransform(scrollYProgress, [0, 0.85], ["inset(0% 0% 100% 0%)", "inset(0% 0% 0% 0%)"]);
  const iris = useTransform(scrollYProgress, [0, 0.95], ["circle(32% at 50% 46%)", "circle(150% at 50% 50%)"]);

  if (reduce) return <div className={className}>{children}</div>;

  const style =
    kind === "curtain"
      ? { clipPath: curtain, WebkitClipPath: curtain }
      : kind === "iris"
        ? { opacity: opacityHigh, clipPath: iris, WebkitClipPath: iris }
        : kind === "focus"
          ? { opacity: opacityHigh, filter: blur }
          : { opacity };

  return (
    <motion.div ref={ref} className={className} style={style}>
      {children}
    </motion.div>
  );
}
