/**
 * Greeting — the sticky mascot greeting the scrub-hero scrolls up over (the "overlay reveal").
 * A message bubble + the periwinkle "messenger" mascot + a drifting lumen particle field with
 * mouse-parallax depth. It sits at z0 (position:sticky) while everything after rides in .op-over
 * at z1. Per the owner logo rule, no text "Lumenia": the wordmark SVG + the link mark are used.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useScroll, useTransform } from "motion/react";

export function Greeting() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<HTMLDivElement>(null);
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    setReduce(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  // Recede transition (brand-kit variant 02): as the content scrolls up over the pinned greeting,
  // the greeting scales back, dims and blurs — receding into depth instead of a flat overlay.
  const { scrollY } = useScroll();
  const scale = useTransform(scrollY, [0, 760], [1, 0.9]);
  const opacity = useTransform(scrollY, [0, 560, 760], [1, 0.7, 0.3]);
  const filter = useTransform(scrollY, [0, 760], ["blur(0px)", "blur(5px)"]);

  // Ambient "lumen" particle field + mouse-parallax depth.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const PN = 46;
    const parts = Array.from({ length: PN }, (_, i) => ({
      x: Math.random(), y: Math.random(), r: rnd(0.8, 2.8), sp: rnd(4, 15),
      sway: rnd(0, Math.PI * 2), swAmp: rnd(4, 15), a: rnd(0.05, 0.4),
      tw: rnd(0, Math.PI * 2), twSp: rnd(0.4, 1.3), star: i % 6 === 0,
    }));
    let w = 0, h = 0, raf = 0, last = 0;
    let tx = 0, ty = 0, cx = 0, cy = 0;
    const onMove = (e: PointerEvent) => {
      tx = (e.clientX / window.innerWidth - 0.5) * 2;
      ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    const onLeave = () => { tx = 0; ty = 0; };
    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const dot = (px: number, py: number, r: number, alpha: number, star: boolean) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r * 4);
      g.addColorStop(0, `rgba(110,95,206,${alpha})`);
      g.addColorStop(1, "rgba(110,95,206,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, r * 4, 0, Math.PI * 2); ctx.fill();
      if (star) {
        ctx.strokeStyle = `rgba(123,108,222,${alpha * 0.85})`;
        ctx.lineWidth = 0.9;
        const L = r * 4.6;
        ctx.beginPath();
        ctx.moveTo(px - L, py); ctx.lineTo(px + L, py);
        ctx.moveTo(px, py - L); ctx.lineTo(px, py + L);
        ctx.stroke();
      }
    };
    const parallax = () => {
      cx += (tx - cx) * 0.07; cy += (ty - cy) * 0.07;
      canvas.style.transform = `translate(${cx * -8}px, ${cy * -8}px)`;
      if (bgRef.current) bgRef.current.style.transform = `translate(${cx * -16}px, ${cy * -16}px)`;
      if (bubbleRef.current) bubbleRef.current.style.transform = `translate(${cx * 7}px, ${cy * 7}px)`;
      if (mascotRef.current) mascotRef.current.style.transform = `translate(${cx * 16}px, ${cy * 16}px)`;
    };
    const frame = (t: number) => {
      if (!last) last = t;
      const dt = Math.min((t - last) / 1000, 0.05); last = t;
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.y -= (p.sp / h) * dt;
        if (p.y < -0.03) { p.y = 1.03; p.x = Math.random(); }
        const px = p.x * w + Math.sin(p.sway + t / 1400) * p.swAmp;
        const alpha = Math.max(0, p.a * (0.55 + 0.45 * Math.sin(p.tw + (t / 1000) * p.twSp)));
        dot(px, p.y * h, p.r, alpha, p.star);
      }
      parallax();
      raf = requestAnimationFrame(frame);
    };
    size();
    window.addEventListener("resize", size);
    if (reduce) {
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) dot(p.x * w, p.y * h, p.r, p.a * 0.7, p.star);
    } else {
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerout", onLeave);
      raf = requestAnimationFrame(frame);
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerout", onLeave);
    };
  }, []);

  return (
    <section className="op-greet">
      <canvas ref={canvasRef} className="op-particles" aria-hidden="true" />
      <div ref={bgRef} className="op-bg-layer" aria-hidden="true">
        <span className="op-bigspark" />
        <div className="op-glow-back" />
      </div>
      {/* Wordmark swaps per theme: the periwinkle-on-paper mark's letter counters are paper-filled,
          so it only reads on light. The dark variant recolors counters + glyphs for dark surfaces. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="op-brandlogo op-brandlogo--light" src="/brand-kit-assets/logo-wordmark-t.svg" alt="Lumenia" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="op-brandlogo op-brandlogo--dark" src="/brand-kit-assets/logo-wordmark-dark.svg" alt="" aria-hidden="true" />
      <motion.div className="op-greet-recede" style={reduce ? undefined : { scale, opacity, filter }}>
      <div className="op-greet-stage">
        <div ref={bubbleRef} className="op-px-bubble">
          <div className="op-bubble">
            <div className="op-bubble-top">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="op-bubble-mark" src="/brand-kit-assets/mark-link.webp" alt="Lumenia" />
              <span className="op-bubble-time">now</span>
            </div>
            <p className="op-bubble-text">Hey, I&rsquo;ve got a message for you.</p>
            <span className="op-bubble-tail" />
          </div>
        </div>
        <div ref={mascotRef} className="op-px-mascot">
          <div className="op-mascot-wrap">
            <span className="op-mascot-halo" aria-hidden="true" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="op-mascot" src="/brand-kit-assets/mascot-messenger-cut.webp" alt="The Lumenia messenger, holding an envelope" />
            <span className="op-envglow" aria-hidden="true" />
            <span className="op-groundpool" aria-hidden="true" />
          </div>
        </div>
      </div>
      </motion.div>
    </section>
  );
}
