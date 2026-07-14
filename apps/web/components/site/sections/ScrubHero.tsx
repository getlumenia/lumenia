/**
 * ScrubHero — the Apple-style scroll-scrub hero (section 1 of the §12 narrative). A 536-frame
 * WebP image sequence is drawn to <canvas> as you scroll (zero decode jank; 60fps
 * motion-interpolated) while the subtraction beats ("No wallet. / No seed phrase. / No app. /
 * Just a link.") fade over it. The frame preload is DEFERRED (requestIdleCallback + first-scroll)
 * so it never blocks first paint. Reduced-motion falls back to the looping reel video.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { clamp } from "./utils";

const N = 536; // frame count (f_001..f_536) — reel motion-interpolated to 60fps
export const SCRUB_VH = 560; // pinned section height; scrollable = SCRUB_VH - 100
const framePath = (i: number) => `/brand-kit-assets/opening-frames/f_${String(i).padStart(3, "0")}.webp`;

// Headline beats — the "subtraction". {a,b,c,d} = progress ramp: 0→1 over [a,b], hold [b,c], 1→0 over [c,d].
const BEATS = [
  { text: "No wallet.", a: 0.05, b: 0.11, c: 0.18, d: 0.24 },
  { text: "No seed phrase.", a: 0.25, b: 0.31, c: 0.38, d: 0.44 },
  { text: "No app.", a: 0.45, b: 0.51, c: 0.57, d: 0.63 },
  { text: "Just a link.", a: 0.66, b: 0.73, c: 0.80, d: 0.86 },
];

function beatOpacity(p: number, b: (typeof BEATS)[number]) {
  if (p < b.a || p > b.d) return 0;
  if (p < b.b) return (p - b.a) / (b.b - b.a);
  if (p > b.c) return 1 - (p - b.c) / (b.d - b.c);
  return 1;
}

export function ScrubHero() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const cueRef = useRef<HTMLDivElement>(null);
  const beatRefs = useRef<(HTMLHeadingElement | null)[]>([]);
  const framesRef = useRef<HTMLImageElement[]>([]);
  const [pct, setPct] = useState(0);
  const [ready, setReady] = useState(false);
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    setReduce(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  // preload + decode all frames — DEFERRED. The 536 frames are only needed once you reach the
  // scrub, so we let the hero/greeting paint first, then stream them in on browser idle (or on
  // the first scroll intent, whichever comes first) so they never block first paint.
  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    let started = false;
    const imgs: HTMLImageElement[] = new Array(N);
    let done = 0;
    const bump = () => {
      done += 1;
      if (!cancelled) setPct(Math.round((done / N) * 100));
      if (done === N && !cancelled) setReady(true);
    };
    const startLoad = () => {
      if (started || cancelled) return;
      started = true;
      window.removeEventListener("scroll", startLoad);
      for (let i = 0; i < N; i++) {
        const img = new Image();
        img.decoding = "async";
        img.src = framePath(i + 1);
        const finish = () => {
          if (typeof img.decode === "function") img.decode().then(bump, bump);
          else bump();
        };
        if (img.complete) finish();
        else {
          img.onload = finish;
          img.onerror = bump;
        }
        imgs[i] = img;
      }
      framesRef.current = imgs;
    };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const idleId = ric ? ric(startLoad, { timeout: 2500 }) : window.setTimeout(startLoad, 1000);
    window.addEventListener("scroll", startLoad, { passive: true });
    return () => {
      cancelled = true;
      window.removeEventListener("scroll", startLoad);
      if (ric && "cancelIdleCallback" in window) (window as Window & { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(idleId);
    };
  }, [reduce]);

  // scrub loop
  useEffect(() => {
    if (reduce || !ready) return;
    const canvas = canvasRef.current!;
    const section = sectionRef.current!;
    const ctx = canvas.getContext("2d", { alpha: false })!;
    let raf = 0;
    let lastIdx = -1;
    let cssW = 0;
    let cssH = 0;

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cssW = canvas.clientWidth;
      cssH = canvas.clientHeight;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lastIdx = -1;
    };

    const draw = (idx: number) => {
      const img = framesRef.current[idx];
      if (!img || !img.width) return;
      const ir = img.width / img.height;
      const cr = cssW / cssH;
      let dw: number, dh: number, dx: number, dy: number;
      if (cr > ir) {
        dw = cssW;
        dh = cssW / ir;
        dx = 0;
        dy = (cssH - dh) / 2;
      } else {
        dh = cssH;
        dw = cssH * ir;
        dx = (cssW - dw) / 2;
        dy = 0;
      }
      ctx.drawImage(img, dx, dy, dw, dh);
    };

    const tick = () => {
      const vh = window.innerHeight;
      const total = section.offsetHeight - vh;
      const top = section.getBoundingClientRect().top;
      const p = clamp(total > 0 ? -top / total : 0);
      const idx = Math.round(p * (N - 1));
      if (idx !== lastIdx) {
        draw(idx);
        lastIdx = idx;
      }
      let maxBeat = 0;
      for (let k = 0; k < BEATS.length; k++) {
        const o = beatOpacity(p, BEATS[k]);
        const el = beatRefs.current[k];
        if (el) {
          el.style.opacity = String(o);
          el.style.transform = `translateY(${(1 - o) * 14}px)`;
        }
        if (o > maxBeat) maxBeat = o;
      }
      if (scrimRef.current) scrimRef.current.style.opacity = String(maxBeat * 0.42);
      if (cueRef.current) cueRef.current.style.opacity = String(clamp(1 - p / 0.04));
      raf = requestAnimationFrame(tick);
    };

    size();
    draw(0);
    raf = requestAnimationFrame(tick);
    window.addEventListener("resize", size);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
    };
  }, [ready, reduce]);

  if (reduce) {
    return (
      <section className="op-reduce">
        <video poster="/brand-kit-assets/bg-hero.png" autoPlay loop muted playsInline className="op-reduce-v">
          <source src="/brand-kit-assets/video/bg-hero-bloom.webm" type="video/webm" />
          <source src="/brand-kit-assets/video/bg-hero-bloom.mp4" type="video/mp4" />
        </video>
        <div className="op-reduce-copy">
          <h1>No wallet. No seed phrase. No app.</h1>
          <p>Just a link.</p>
        </div>
      </section>
    );
  }

  return (
    <section ref={sectionRef} className="op-scrub" style={{ height: `${SCRUB_VH}vh` }}>
      <div className="op-sticky">
        <canvas ref={canvasRef} className="op-canvas" />
        <div className="op-overlays" aria-hidden="true">
          <div ref={scrimRef} className="op-scrim" style={{ opacity: 0 }} />
          {BEATS.map((b, i) => (
            <h2
              key={b.text}
              ref={(el) => {
                beatRefs.current[i] = el;
              }}
              className="op-beat"
              style={{ opacity: 0 }}
            >
              {b.text}
            </h2>
          ))}
        </div>
        <div ref={cueRef} className="op-cue">
          Scroll <span className="op-cue-arrow">↓</span>
        </div>
        {!ready && (
          <div className="op-loader">
            <div className="op-loader-bar">
              <div className="op-loader-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="op-loader-t">{pct}%</span>
          </div>
        )}
      </div>
    </section>
  );
}
