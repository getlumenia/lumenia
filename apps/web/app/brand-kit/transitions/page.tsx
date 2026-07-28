/**
 * /brand-kit/transitions, a sandbox comparing professional section-transition styles for the
 * Lumenia landing. The LOCKED default is "overlay" (the next section scrolls up over the pinned
 * one: same as /brand-kit/opening's greeting→scrub). This page also demos three variants:
 * recede, cross-dissolve, and iris/clip. Uniform layout per unit: A pinned (sticky z0), B pinned
 * over it (sticky z1, overlapping), unit 200vh for scroll room; a rAF reads each unit's scroll
 * progress and drives B's transform/opacity/clip (recede also transforms A). Reduced-motion falls
 * back to normal stacked flow. ISOLATED workspace route, never touches the live landing.
 */
"use client";

import { useEffect, useRef } from "react";
import SmoothScroll from "../../../components/brand/SmoothScroll";

type Kind = "overlay" | "recede" | "dissolve" | "clip";
const UNITS: { kind: Kind; n: string; name: string; desc: string; a: string; b: string }[] = [
  { kind: "overlay", n: "01", name: "Overlay reveal", desc: "The next section scrolls up over the pinned one. This is the locked default for every section on the landing.", a: "bg-paper", b: "bg-accent" },
  { kind: "recede", n: "02", name: "Recede + overlay", desc: "As the next section covers it, the pinned one scales back, dims and blurs, receding into depth.", a: "bg-accent", b: "bg-paper" },
  { kind: "dissolve", n: "03", name: "Cross-dissolve", desc: "The section dissolves into the next in place, a soft opacity cross-fade, no motion.", a: "bg-paper", b: "bg-dark" },
  { kind: "clip", n: "04", name: "Iris reveal", desc: "The next section irises in from the centre via an expanding circular mask.", a: "bg-dark", b: "bg-accent" },
];

const clamp = (v: number) => Math.max(0, Math.min(1, v));

function Sandbox() {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;
    const units = Array.from(root.querySelectorAll<HTMLElement>(".trx"));
    let raf = 0;
    const tick = () => {
      const vh = window.innerHeight;
      for (const u of units) {
        const denom = u.offsetHeight - vh;
        const p = clamp(denom > 0 ? -u.getBoundingClientRect().top / denom : 0);
        const kind = u.dataset.kind as Kind;
        const a = u.querySelector<HTMLElement>(".trx-a-inner");
        const b = u.querySelector<HTMLElement>(".trx-b");
        if (!b) continue;
        if (kind === "overlay") {
          b.style.transform = `translateY(${(1 - p) * 100}%)`;
        } else if (kind === "recede") {
          b.style.transform = `translateY(${(1 - p) * 100}%)`;
          if (a) {
            a.style.transform = `scale(${1 - 0.12 * p})`;
            a.style.opacity = String(1 - 0.55 * p);
            a.style.filter = `blur(${p * 5}px)`;
          }
        } else if (kind === "dissolve") {
          b.style.opacity = String(p);
        } else if (kind === "clip") {
          b.style.clipPath = `circle(${(p * 145).toFixed(1)}% at 50% 50%)`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="trx-root" ref={rootRef}>
      <header className="trx-intro">
        <p className="trx-eyebrow"><span className="trx-dot" />Brand kit · Section transitions</p>
        <h1 className="trx-h1">How sections meet.</h1>
        <p className="trx-sub">Four ways one section hands off to the next. Overlay is the locked default; scroll to feel each.</p>
        <span className="trx-cue" aria-hidden="true">↓</span>
      </header>

      {UNITS.map((u) => (
        <section className="trx" data-kind={u.kind} key={u.kind}>
          <div className={`trx-a ${u.a}`}>
            <div className="trx-a-inner">
              <span className="trx-tag">{u.n}</span>
              <h2 className="trx-name">{u.name}</h2>
              <p className="trx-desc">{u.desc}</p>
              <span className="trx-scroll" aria-hidden="true">keep scrolling ↓</span>
            </div>
          </div>
          <div className={`trx-b ${u.b}`}>
            <div className="trx-b-inner">
              <span className="trx-badge" aria-hidden="true" />
              <h3 className="trx-bh">The next section</h3>
              <p className="trx-bp">delivered by “{u.name}”</p>
            </div>
          </div>
        </section>
      ))}

      <footer className="trx-outro bg-paper">
        <h2 className="trx-name">Default everywhere: overlay.</h2>
        <p className="trx-desc">Each landing section is <code>position:sticky; top:0</code> with a rising z-index: the next slides over the pinned one.</p>
      </footer>
    </div>
  );
}

export default function TransitionsPage() {
  return (
    <SmoothScroll>
      <div className="trxp">
        <style>{CSS}</style>
        <Sandbox />
      </div>
    </SmoothScroll>
  );
}

const CSS = `
.trxp{--paper:#F5F3EF;--surface:#FBFAF8;--ink:#1E1B22;--muted:#67626E;--line:#E5DFE8;--accent:#6E5FCE;
  font-family:"Switzer",ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;background:#0e0c14}
.trxp :where(h1,h2,h3,p){margin:0}
.bg-paper{background:var(--paper);color:var(--ink)}
.bg-accent{background:linear-gradient(155deg,#7f70e4,#6E5FCE 60%,#5f50c2);color:#F6F4FD}
.bg-dark{background:radial-gradient(120% 90% at 50% 20%, #221c33, #15121C);color:#EDEAF3}

.trx-intro{position:relative;z-index:1;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;gap:14px;padding:40px;background:var(--paper);color:var(--ink)}
.trx-eyebrow{display:inline-flex;align-items:center;gap:9px;font-size:12.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--accent)}
.trx-dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.trx-h1{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(40px,8vw,92px);line-height:1;letter-spacing:-.025em}
.trx-sub{color:var(--muted);font-size:clamp(15px,1.8vw,19px);max-width:52ch}
.trx-cue{margin-top:18px;font-size:26px;color:var(--accent);animation:trxbob 1.6s ease-in-out infinite}
@keyframes trxbob{0%,100%{transform:translateY(0)}50%{transform:translateY(8px)}}

.trx{position:relative;height:200vh}
.trx-a{position:sticky;top:0;height:100vh;z-index:0;display:grid;place-items:center;overflow:hidden;padding:40px}
.trx-a-inner{max-width:640px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:16px;will-change:transform,opacity,filter}
.trx-tag{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:14px;opacity:.6}
.trx-name{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(30px,5vw,58px);letter-spacing:-.02em;line-height:1.02}
.trx-desc{font-size:clamp(15px,1.8vw,19px);line-height:1.55;opacity:.82;max-width:46ch}
.trx-desc code{font-family:ui-monospace,monospace;font-size:.9em;background:color-mix(in srgb,currentColor 12%,transparent);padding:1px 6px;border-radius:5px}
.trx-scroll{margin-top:8px;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;opacity:.6}

.trx-b{position:sticky;top:0;height:100vh;z-index:1;margin-top:-100vh;display:grid;place-items:center;overflow:hidden;padding:40px;
  will-change:transform,opacity,clip-path}
.trx-b-inner{text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px}
.trx-badge{width:44px;height:44px;border-radius:50%;background:currentColor;opacity:.9;
  -webkit-mask:radial-gradient(circle at 50% 50%, transparent 0, transparent 40%, #000 42%);
  mask:radial-gradient(circle at 50% 50%, transparent 0, transparent 40%, #000 42%)}
.trx-bh{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(28px,4.5vw,52px);letter-spacing:-.02em}
.trx-bp{font-size:15px;opacity:.72}

/* initial (pre-JS / p=0) states per kind */
.trx[data-kind="overlay"] .trx-b, .trx[data-kind="recede"] .trx-b{transform:translateY(100%)}
.trx[data-kind="dissolve"] .trx-b{opacity:0}
.trx[data-kind="clip"] .trx-b{clip-path:circle(0% at 50% 50%)}

.trx-outro{position:relative;z-index:1;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;gap:14px;padding:40px}

@media (prefers-reduced-motion:reduce){
  .trx{height:auto}
  .trx-a,.trx-b{position:static;height:auto;min-height:60vh;margin-top:0;transform:none!important;opacity:1!important;clip-path:none!important;filter:none!important}
  .trx-cue{animation:none}
}
`;
