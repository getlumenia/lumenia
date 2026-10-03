"use client";

/**
 * LumenField: the slow drift of small lights behind the landing's greeting, for the app's
 * first-run beats. Same idea as the greeting's canvas (components/site/sections/Greeting.tsx), cut
 * down to what an app screen can afford: no pointer parallax, fewer particles, and nothing at all
 * while the tab is hidden.
 *
 * The colour is read from `--money` on the canvas itself, so it is the periwinkle accent on light
 * and Stellar's lavender on dark, and it follows a theme switch without a reload. Reduced motion
 * draws the field once and never animates it.
 */
import { useEffect, useRef } from "react";

const FALLBACK: [number, number, number] = [110, 95, 206];

function readAccent(el: Element): [number, number, number] {
  const raw = getComputedStyle(el).getPropertyValue("--money").trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(raw);
  if (!m) return FALLBACK;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function LumenField({ className, count = 34 }: { className?: string; count?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let [cr, cg, cb] = readAccent(canvas);
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const parts = Array.from({ length: count }, (_, i) => ({
      x: Math.random(),
      y: Math.random(),
      r: rnd(0.8, 2.6),
      speed: rnd(5, 14),
      sway: rnd(0, Math.PI * 2),
      swayAmp: rnd(4, 14),
      alpha: rnd(0.08, 0.42),
      twinkle: rnd(0, Math.PI * 2),
      twinkleSpeed: rnd(0.4, 1.2),
      star: i % 6 === 0,
    }));
    let w = 0;
    let h = 0;
    let raf = 0;
    let last = 0;

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const dot = (px: number, py: number, r: number, a: number, star: boolean) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r * 4);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, r * 4, 0, Math.PI * 2);
      ctx.fill();
      if (star) {
        // A few of them are tiny four-point sparks, the same lumen the wordmark's "i" carries.
        const len = r * 4.6;
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${a * 0.85})`;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(px - len, py);
        ctx.lineTo(px + len, py);
        ctx.moveTo(px, py - len);
        ctx.lineTo(px, py + len);
        ctx.stroke();
      }
    };

    const still = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) dot(p.x * w, p.y * h, p.r, p.alpha * 0.7, p.star);
    };

    const frame = (t: number) => {
      if (!last) last = t;
      const dt = Math.min((t - last) / 1000, 0.05);
      last = t;
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.y -= (p.speed / Math.max(h, 1)) * dt;
        if (p.y < -0.03) {
          p.y = 1.03;
          p.x = Math.random();
        }
        const px = p.x * w + Math.sin(p.sway + t / 1400) * p.swayAmp;
        const a = Math.max(0, p.alpha * (0.55 + 0.45 * Math.sin(p.twinkle + (t / 1000) * p.twinkleSpeed)));
        dot(px, p.y * h, p.r, a, p.star);
      }
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (reduce || raf || document.hidden) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    size();
    if (reduce) still();
    else start();

    const resize = new ResizeObserver(() => {
      size();
      if (reduce) still();
    });
    resize.observe(canvas);

    // next-themes flips `data-theme` on <html>; the accent changes with it.
    const theme = new MutationObserver(() => {
      [cr, cg, cb] = readAccent(canvas);
      if (reduce) still();
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      resize.disconnect();
      theme.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [count]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
