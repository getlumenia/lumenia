/**
 * /brand-kit/opening — Apple-style scroll-scrub opening. The 9s launch reel is exploded
 * into an image sequence (public/brand-kit-assets/opening-frames/) and drawn frame-by-frame
 * to a <canvas> as you scroll — NO <video> currentTime seeking, so there is zero decode jank.
 * Frames are motion-interpolated to 60fps (ffmpeg minterpolate) for buttery scrubbing.
 * All 536 frames are preloaded + decoded before scrubbing is enabled; a requestAnimationFrame
 * loop reads the (Lenis-smoothed) window scroll and draws the nearest frame. Scroll progress
 * 0→1 covers the full 9 seconds. Headline beats fade in over the scrub; a reduced-motion
 * fallback plays the reel as a plain looping video. ISOLATED workspace route — never touches
 * the live landing or the frozen claim route. Fonts come from the /brand-kit layout.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import SmoothScroll from "../../../components/brand/SmoothScroll";

const N = 536; // frame count (f_001..f_536) — reel motion-interpolated to 60fps
const SCRUB_VH = 560; // pinned section height; scrollable = SCRUB_VH - 100
const framePath = (i: number) => `/brand-kit-assets/opening-frames/f_${String(i).padStart(3, "0")}.webp`;

// Headline beats — the "subtraction". {a,b,c,d} = progress ramp: 0→1 over [a,b], hold [b,c], 1→0 over [c,d].
const BEATS = [
  { text: "No wallet.", a: 0.05, b: 0.11, c: 0.18, d: 0.24 },
  { text: "No seed phrase.", a: 0.25, b: 0.31, c: 0.38, d: 0.44 },
  { text: "No app.", a: 0.45, b: 0.51, c: 0.57, d: 0.63 },
  { text: "Just a link.", a: 0.66, b: 0.73, c: 0.80, d: 0.86 },
];

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
function beatOpacity(p: number, b: (typeof BEATS)[number]) {
  if (p < b.a || p > b.d) return 0;
  if (p < b.b) return (p - b.a) / (b.b - b.a);
  if (p > b.c) return 1 - (p - b.c) / (b.d - b.c);
  return 1;
}

function ScrubHero() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const cueRef = useRef<HTMLDivElement>(null);
  const beatRefs = useRef<(HTMLHeadingElement | null)[]>([]);
  const framesRef = useRef<HTMLImageElement[]>([]);
  const [pct, setPct] = useState(0);
  const [ready, setReady] = useState(false);
  const [reduce, setReduce] = useState(false);

  // reduced-motion check (mount-safe)
  useEffect(() => {
    setReduce(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  // preload + decode all frames
  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    const imgs: HTMLImageElement[] = new Array(N);
    let done = 0;
    const bump = () => {
      done += 1;
      if (!cancelled) setPct(Math.round((done / N) * 100));
      if (done === N && !cancelled) setReady(true);
    };
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
        img.onerror = bump; // don't stall the loader on a single miss
      }
      imgs[i] = img;
    }
    framesRef.current = imgs;
    return () => {
      cancelled = true;
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
      lastIdx = -1; // force redraw
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
      // overlays (write directly — no React re-render per frame)
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
        <video
          poster="/brand-kit-assets/bg-hero.png"
          autoPlay
          loop
          muted
          playsInline
          className="op-reduce-v"
        >
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

function Greeting() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<HTMLDivElement>(null);

  // Ambient "lumen" particle field + mouse-parallax depth.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const N = 46;
    const parts = Array.from({ length: N }, (_, i) => ({
      x: Math.random(), y: Math.random(), r: rnd(0.8, 2.8), sp: rnd(4, 15),
      sway: rnd(0, Math.PI * 2), swAmp: rnd(4, 15), a: rnd(0.05, 0.4),
      tw: rnd(0, Math.PI * 2), twSp: rnd(0.4, 1.3), star: i % 6 === 0,
    }));
    let w = 0, h = 0, raf = 0, last = 0;
    let tx = 0, ty = 0, cx = 0, cy = 0; // parallax target + current
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
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="op-brandlogo" src="/brand-kit-assets/logo-wordmark-t.svg" alt="Lumenia" />
      <div className="op-greet-stage">
        <div ref={bubbleRef} className="op-px-bubble">
          <div className="op-bubble">
            <div className="op-bubble-top">
              <span className="op-bubble-spark" aria-hidden="true" />
              <span className="op-bubble-name">Lumenia</span>
              <span className="op-bubble-time">now</span>
            </div>
            <p className="op-bubble-text">Hey — I&rsquo;ve got a message for you.</p>
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
    </section>
  );
}

export default function OpeningPage() {
  return (
    <SmoothScroll>
      <div className="op">
        <style>{CSS}</style>
        <Greeting />
        <div className="op-over">
          <ScrubHero />
          <section className="op-after">
            <h2 className="op-after-h">Money home, in a link.</h2>
            <p className="op-after-p">
              The recipient claims it walletless, seedless, and pays no gas — in a target ~30s.
            </p>
          </section>
        </div>
      </div>
    </SmoothScroll>
  );
}

const CSS = `
.op{--paper:#F5F3EF;--surface:#FBFAF8;--ink:#1E1B22;--muted:#67626E;--accent:#6E5FCE;
  background:#0e0c14;color:var(--ink);font-family:"Switzer",ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.op :where(h1,h2,p){margin:0}

.op-scrub{position:relative}
.op-sticky{position:sticky;top:0;height:100vh;overflow:hidden;background:#0e0c14}
.op-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}

.op-overlays{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.op-scrim{position:absolute;inset:0;background:radial-gradient(60% 55% at 50% 50%, rgba(10,8,18,.9), transparent 72%)}
.op-beat{position:absolute;color:#fff;font-family:"Sentient",Georgia,serif;font-weight:600;
  font-size:clamp(38px,8vw,104px);letter-spacing:-.03em;line-height:1;text-align:center;padding:0 24px;
  text-shadow:0 4px 40px rgba(0,0,0,.35);will-change:opacity,transform}

.op-cue{position:absolute;left:50%;bottom:40px;transform:translateX(-50%);color:#fff;opacity:.9;
  font-size:13px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;display:flex;align-items:center;gap:8px;
  text-shadow:0 2px 20px rgba(0,0,0,.4)}
.op-cue-arrow{display:inline-block;animation:opbob 1.6s ease-in-out infinite}
@keyframes opbob{0%,100%{transform:translateY(0)}50%{transform:translateY(6px)}}

.op-loader{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;
  background:#0e0c14;color:#EDEAF3}
.op-loader-bar{width:min(240px,60vw);height:3px;border-radius:3px;background:rgba(255,255,255,.14);overflow:hidden}
.op-loader-fill{height:100%;background:#B7ACE8;border-radius:3px;transition:width .2s ease}
.op-loader-t{font-size:12px;letter-spacing:.1em;color:#8b85a0}

.op-after{min-height:80vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;
  padding:80px 40px;background:var(--paper);
  background-image:radial-gradient(60% 50% at 50% 40%, color-mix(in srgb,var(--accent) 12%,transparent), transparent 72%)}
.op-after-h{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(32px,5vw,60px);letter-spacing:-.02em;color:var(--ink)}
.op-after-p{color:var(--muted);font-size:clamp(15px,1.8vw,19px);max-width:44ch}

.op-reduce{position:relative;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0e0c14}
.op-reduce-v{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.85}
.op-reduce-copy{position:relative;text-align:center;color:#fff;padding:24px;text-shadow:0 4px 40px rgba(0,0,0,.4)}
.op-reduce-copy h1{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(28px,5vw,56px);letter-spacing:-.02em;line-height:1.1}
.op-reduce-copy p{font-family:"Sentient",Georgia,serif;font-size:clamp(22px,3.5vw,40px);color:#B7ACE8;margin-top:10px}

/* greeting */
.op-greet{position:sticky;top:0;z-index:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:40px 24px 0;overflow:hidden;background:var(--paper)}
.op-over{position:relative;z-index:1}
.op-particles{position:absolute;inset:-30px;width:calc(100% + 60px);height:calc(100% + 60px);z-index:0;pointer-events:none;will-change:transform}
.op-bg-layer{position:absolute;inset:0;z-index:0;pointer-events:none;will-change:transform}
.op-bigspark{position:absolute;left:50%;top:52%;transform:translate(-50%,-50%);width:min(560px,64vw);aspect-ratio:1;
  background:var(--accent);opacity:.055;filter:blur(2px);
  clip-path:polygon(50% 0%,57% 43%,100% 50%,57% 57%,50% 100%,43% 57%,0% 50%,43% 43%)}
.op-glow-back{position:absolute;left:50%;top:54%;transform:translate(-50%,-50%);width:min(820px,90vw);height:min(820px,90vw);
  border-radius:50%;background:radial-gradient(circle, color-mix(in srgb,var(--accent) 18%,transparent), transparent 60%);
  filter:blur(6px);animation:opbreath 7.5s ease-in-out infinite}
.op-brandlogo{position:absolute;top:30px;left:50%;transform:translateX(-50%);height:30px;width:auto;display:block;z-index:2;
  animation:opfadein 1s ease .15s both}
.op-greet-stage{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;
  animation:opreveal .95s cubic-bezier(.2,.75,.2,1) both}
.op-px-bubble{display:flex;justify-content:center;margin-bottom:24px;will-change:transform}
.op-px-mascot{display:flex;justify-content:center;will-change:transform}
.op-bubble{position:relative;max-width:min(500px,86vw);min-width:min(340px,80vw);
  background:linear-gradient(152deg,#7f70e4 0%,#6E5FCE 52%,#5f50c2 100%);color:#F6F4FD;
  padding:16px 24px 20px;border-radius:24px;transform-origin:bottom center;
  box-shadow:0 26px 54px -22px rgba(110,95,206,.62), 0 2px 8px rgba(78,64,168,.25), inset 0 1px 0 rgba(255,255,255,.28);
  animation:opbubble 1.05s cubic-bezier(.2,.8,.25,1) .5s both}
.op-bubble-top{display:flex;align-items:center;gap:8px;margin-bottom:8px;
  font-family:"Switzer",ui-sans-serif,sans-serif;font-size:13px;font-weight:600}
.op-bubble-spark{width:14px;height:14px;flex:none;background:#EFEBFF;
  clip-path:polygon(50% 0%,58% 42%,100% 50%,58% 58%,50% 100%,42% 58%,0% 50%,42% 42%);
  filter:drop-shadow(0 0 4px rgba(255,255,255,.7))}
.op-bubble-name{color:#fff;letter-spacing:-.01em}
.op-bubble-time{margin-left:auto;font-weight:500;font-size:12px;color:rgba(246,244,253,.62)}
.op-bubble-text{margin:0;font-family:"Switzer",ui-sans-serif,sans-serif;font-weight:500;
  font-size:clamp(19px,2.5vw,29px);line-height:1.3;letter-spacing:-.01em;color:#fff;text-align:left}
.op-bubble-tail{position:absolute;bottom:-8px;left:50%;transform:translateX(-50%) rotate(45deg);width:20px;height:20px;
  background:#5f50c2;border-radius:0 0 6px 0}
.op-mascot-wrap{position:relative;display:flex;justify-content:center}
.op-mascot-halo{position:absolute;left:50%;top:47%;transform:translate(-50%,-50%);width:80%;height:84%;z-index:0;pointer-events:none;
  border-radius:50%;background:radial-gradient(circle, color-mix(in srgb,var(--accent) 24%,transparent), transparent 64%);
  filter:blur(20px);animation:opbreath 6s ease-in-out infinite}
.op-envglow{position:absolute;left:39%;top:70%;transform:translate(-50%,-50%);width:38%;aspect-ratio:1;z-index:2;pointer-events:none;
  border-radius:50%;background:radial-gradient(circle, color-mix(in srgb,var(--accent) 62%,white), transparent 66%);
  filter:blur(7px);animation:openv 2.6s ease-in-out infinite}
.op-groundpool{position:absolute;left:50%;bottom:4%;transform:translateX(-50%);width:58%;height:32px;z-index:0;pointer-events:none;
  border-radius:50%;background:radial-gradient(ellipse at center, color-mix(in srgb,var(--accent) 32%,transparent), transparent 70%);filter:blur(8px)}
.op-mascot{position:relative;z-index:1;width:clamp(230px,32vw,392px);height:auto;display:block;margin-top:-26px;
  filter:drop-shadow(0 22px 26px rgba(110,95,206,.18));animation:opfloat 4.6s ease-in-out infinite;
  -webkit-mask-image:linear-gradient(to bottom,#000 66%,transparent 83%);mask-image:linear-gradient(to bottom,#000 66%,transparent 83%)}
@keyframes opfloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-13px)}}
@keyframes opbreath{0%,100%{opacity:.68;transform:translate(-50%,-50%) scale(1)}50%{opacity:1;transform:translate(-50%,-50%) scale(1.06)}}
@keyframes opreveal{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
@keyframes opfadein{from{opacity:0}to{opacity:1}}
@keyframes opbubble{0%{opacity:0;transform:translateY(8px) scale(.78)}55%{opacity:1;transform:translateY(0) scale(1.05)}100%{transform:translateY(0) scale(1)}}
@keyframes openv{0%,100%{opacity:.28;transform:translate(-50%,-50%) scale(.9)}50%{opacity:.85;transform:translate(-50%,-50%) scale(1.12)}}
@media (prefers-reduced-motion:reduce){.op-mascot,.op-glow-back,.op-mascot-halo,.op-greet-stage,.op-brandlogo,.op-bubble,.op-envglow{animation:none}}
`;
