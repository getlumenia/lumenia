/**
 * BootOpening — the landing's first frame. The page opens as one flat field of the colour the
 * wordmark's "i" is drawn in, then that field contracts into the "i" itself, igniting its lumen
 * spark and handing off to the greeting.
 *
 * The colour is var(--pw-accent) — NOT a hardcoded hex. That token is already the exact fill the
 * Lumenia letters carry (#6E5FCE in logo-wordmark-t.svg / #B7ACE8 in logo-wordmark-dark.svg), and
 * landing.css already flips it per data-theme, so the field is theme-correct for free.
 *
 * The focus point is MEASURED, never hardcoded. In the wordmark SVG the "i" is two pieces: a stem
 * (a path at x≈1519) and a tittle that is not a dot but the brand's lumen spark —
 * `<circle cx="1504" cy="556" r="92" fill="url(#lumen)"/>` inside viewBox "300 450 1470 460".
 * So the spark sits at a fixed FRACTION of the rendered box (81.9% across, 23.0% down); the <img>
 * is height-fixed/width-auto over a meet-fit viewBox, so no letterboxing skews that fraction. We
 * read the live rect at run time, so the point follows the logo through any responsive change.
 *
 * Phases live in data-boot on the .op wrapper so landing.css can hold the greeting's EXISTING
 * entrance animations (opfadein / opreveal / opbubble) paused rather than duplicate them:
 *   hold  → flat field; wordmark + greeting paused before their first frame
 *   focus → field contracts into the "i"; the wordmark fades in to meet the arriving light
 *   (attribute dropped) → the greeting plays exactly as it always has
 *
 * The wrapper SSRs with data-boot="hold" (see page.tsx) — that is load-bearing. Setting it from
 * this effect would land after hydration, by which point opreveal/opbubble have already played
 * under the field, and the "hold" would freeze them half-open instead of holding them shut.
 *
 * Fail-safe: the field is server-rendered so it covers from the very first paint (no flash of an
 * un-held greeting). Because that means markup can outlive its script, .op-boot also carries a
 * pure-CSS dismissal — if this component never mounts, the field still leaves.
 */
"use client";

import { useEffect, useRef, useState } from "react";

/** The lumen spark's centre as a fraction of the wordmark box — read off the SVG's own geometry. */
const SPARK_FX = (1504 - 300) / 1470; // 0.819
const SPARK_FY = (556 - 450) / 460; // 0.230

/** Never let a slow/failed wordmark hold the field up. */
const WORDMARK_TIMEOUT_MS = 1800;
const CONTRACT_MS = 900;
/** The spark's flash (.5s delay + .7s in landing.css) outlives the field — unmount only after it. */
const SPARK_TAIL_MS = 400;

/** The theme swaps the two wordmarks with display:none, so the visible one is the one with a box. */
function visibleWordmark(): HTMLImageElement | null {
  const marks = document.querySelectorAll<HTMLImageElement>(".op-brandlogo");
  for (const m of marks) if (m.getClientRects().length > 0) return m;
  return null;
}

function decoded(img: HTMLImageElement | null): Promise<void> {
  if (!img || (img.complete && img.naturalWidth > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    img.addEventListener("load", () => resolve(), { once: true });
    img.addEventListener("error", () => resolve(), { once: true });
  });
}

export function BootOpening() {
  const fieldRef = useRef<HTMLDivElement>(null);
  const sparkRef = useRef<HTMLSpanElement>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const field = fieldRef.current;
    const stage = field?.closest<HTMLElement>(".op");
    if (!field || !stage) return;

    let cancelled = false;
    let raf = 0;
    const timers: number[] = [];
    const release = () => stage.removeAttribute("data-boot");

    // Reduced motion: no contraction, no spark — the field just leaves.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      release(); // landing.css already drops these animations under reduced motion; don't hold them
      field.style.transition = "opacity .28s linear";
      field.style.opacity = "0";
      timers.push(
        window.setTimeout(() => {
          release();
          setGone(true);
        }, 300),
      );
      return () => timers.forEach(window.clearTimeout);
    }

    // An opening has to start at the opening — a reload must not resume mid-page.
    try {
      history.scrollRestoration = "manual";
    } catch {
      /* not supported — the scrollTo below still gets us to the top */
    }
    window.scrollTo(0, 0);

    const run = async () => {
      await Promise.race([
        decoded(visibleWordmark()),
        new Promise((r) => window.setTimeout(r, WORDMARK_TIMEOUT_MS)),
      ]);
      if (cancelled) return;

      const rect = visibleWordmark()?.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // If the wordmark never resolved, converge on the centre rather than trap the page.
      const x = rect?.width ? rect.left + rect.width * SPARK_FX : vw / 2;
      const y = rect?.height ? rect.top + rect.height * SPARK_FY : vh / 2;
      // Reach the farthest corner, so the field is genuinely full-bleed before it contracts.
      const radius = Math.hypot(Math.max(x, vw - x), Math.max(y, vh - y));

      const spark = sparkRef.current;
      if (spark) {
        spark.style.left = `${x}px`;
        spark.style.top = `${y}px`;
      }
      // Same units on both ends — clip-path only interpolates when the shapes match.
      field.style.clipPath = `circle(${radius}px at ${x}px ${y}px)`;

      // Two frames: one to commit the from-state, one to start the transition off it.
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => {
          if (cancelled) return;
          stage.setAttribute("data-boot", "focus");
          field.style.transition = `clip-path ${CONTRACT_MS}ms cubic-bezier(.66,0,.2,1)`;
          field.style.clipPath = `circle(0px at ${x}px ${y}px)`;
          spark?.classList.add("op-boot-spark--lit");
          // Hand the greeting its entrance the moment the light lands on the "i"...
          timers.push(window.setTimeout(release, CONTRACT_MS));
          // ...but stay mounted until the spark has finished burning out.
          timers.push(window.setTimeout(() => setGone(true), CONTRACT_MS + SPARK_TAIL_MS));
        });
      });
    };
    void run();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      timers.forEach(window.clearTimeout);
      release();
    };
  }, []);

  if (gone) return null;
  return (
    <>
      <div ref={fieldRef} className="op-boot" aria-hidden="true" />
      <span ref={sparkRef} className="op-boot-spark" aria-hidden="true" />
    </>
  );
}
