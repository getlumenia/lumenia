/**
 * /brand-kit/hero: ISOLATED preview of the REAL landing hero in the LOCKED
 * Periwinkle system (brand.md). Nothing here touches the live (marketing) landing
 * or the frozen claim route; it inherits Sentient + Switzer from the /brand-kit
 * layout (Fontshare) and carries its own Periwinkle tokens inline.
 *
 * Signature moment (brand.md §9): the "subtraction": "No wallet. No seed phrase.
 * No app." is struck through on load, the struck list dissolves, and the payoff
 * "Just a link." settles in. Motion only (motion/react); GSAP/Lenis arrive with the
 * full scroll narrative, not the hero. prefers-reduced-motion renders the settled
 * final state (struck list muted + payoff), which is also the no-JS/SSR meaning.
 *
 * The 3D object is a CSS placeholder for now, the Meshy GLB (brand.md §11.1, a soft
 * message bubble with a debossed check) drops into this slot after the composition
 * is approved, to avoid spending credits on the wrong object.
 */
"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { useAnimate, useReducedMotion, stagger } from "motion/react";

// Lazy, client-only: keeps three.js out of the initial bundle / off the server.
const HeroBubble = dynamic(() => import("../../../components/brand3d/HeroBubble"), {
  ssr: false,
});

const REMOVED = ["wallet", "seed phrase", "app"];

export default function HeroPreview() {
  const [scope, animate] = useAnimate();
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) return; // leave the settled JSX state (already meaningful)
    let cancelled = false;

    const run = async () => {
      // snap to the pre-animation state (words un-struck at full ink, payoff hidden)
      animate(".lh-strike", { scaleX: 0 }, { duration: 0 });
      animate(".lh-word", { color: "var(--ink)", opacity: 1 }, { duration: 0 });
      animate(".lh-removed", { opacity: 1, filter: "blur(0px)", y: 0 }, { duration: 0 });
      animate(".lh-payoff", { opacity: 0, y: 16, scale: 0.965 }, { duration: 0 });

      await new Promise((r) => setTimeout(r, 340));
      if (cancelled) return;

      // 1: draw each strike-through, left→right, staggered
      await animate(
        ".lh-strike",
        { scaleX: 1 },
        { duration: 0.42, delay: stagger(0.5), ease: [0.65, 0, 0.35, 1] },
      );
      if (cancelled) return;

      // 2: the struck list dissolves (fades, softens, drifts up)
      await animate(
        ".lh-removed",
        { opacity: 0.4, filter: "blur(1.2px)", y: -3 },
        { duration: 0.5, ease: "easeInOut" },
      );
      animate(".lh-word", { color: "var(--muted)" }, { duration: 0.5 });
      if (cancelled) return;

      // 3: the payoff settles in as the survivor
      await animate(
        ".lh-payoff",
        { opacity: 1, y: 0, scale: 1 },
        { duration: 0.6, ease: [0.2, 0.7, 0.2, 1] },
      );
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [animate, reduce]);

  return (
    <div className="lh" ref={scope}>
      <style>{CSS}</style>

      {/* top app-bar: wordmark is the primary identity (Sentient) */}
      <header className="lh-bar">
        <span className="lh-mark">Lumenia</span>
        <nav className="lh-nav">
          <a href="#">How it works</a>
          <a href="#">Trust</a>
          <span className="lh-cta-sm">Try the demo</span>
        </nav>
      </header>

      <main className="lh-hero">
        <div className="lh-copy">
          <p className="lh-eyebrow"><span className="lh-dot" />Money by link: no crypto to learn</p>

          <h1 className="lh-h">
            <span className="lh-removed" aria-hidden="true">
              {REMOVED.map((w, i) => (
                <span key={w} className="lh-neg">
                  No{" "}
                  <span className="lh-strk">
                    <span className="lh-word">{w}</span>
                    <span className="lh-strike" style={{ ["--i" as string]: i }} />
                  </span>
                  .
                </span>
              ))}
            </span>
            <span className="lh-payoff">
              Just a <span className="lh-link">link</span>.
            </span>
            <span className="lh-sr">
              No wallet, no seed phrase, no app, just a link.
            </span>
          </h1>

          <p className="lh-sub">
            Send money to someone and they tap the link, it&apos;s already theirs.
            Nothing to install, nothing to memorise, nothing taken from what you sent.
          </p>

          <div className="lh-row">
            <a className="lh-btn" href="#">See it work</a>
            <a className="lh-ghost" href="#">How it works →</a>
          </div>

          <p className="lh-trust">Free to receive · held in dollars · yours in a tap</p>
        </div>

        {/* 3D object slot: the real Meshy GLB (brand.md §11.1), lazy react-three-fiber */}
        <div className="lh-art" aria-hidden="true">
          <div className="lh-glow" />
          <div className="lh-canvas"><HeroBubble /></div>
        </div>
      </main>
    </div>
  );
}

const CSS = `
.lh{
  --paper:#F5F3EF;--surface:#FBFAF8;--ink:#1E1B22;--muted:#67626E;--line:#E5DFE8;
  --accent:#6E5FCE;--accent-hover:#5F50C2;--accent-pressed:#4E40A8;--accent-soft:#E8E3F7;--on-accent:#F6F4FD;
  min-height:100dvh;color:var(--ink);
  font-family:"Switzer",ui-sans-serif,system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased;line-height:1.5;
  background:
    radial-gradient(52% 42% at 84% 8%, color-mix(in srgb, var(--accent) 15%, transparent), transparent 72%),
    radial-gradient(40% 40% at 6% 96%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 70%),
    var(--paper);
}
@media (prefers-color-scheme: dark){
  .lh{
    --paper:#15121C;--surface:#1D1926;--ink:#EDEAF3;--muted:#A59DB2;--line:#2C2536;
    --accent:#B7ACE8;--accent-hover:#C7BEF0;--accent-pressed:#A99CE0;--accent-soft:#2A2338;--on-accent:#1A1622;
  }
}
.lh :where(h1,p){margin:0}

/* app-bar */
.lh-bar{display:flex;align-items:center;justify-content:space-between;
  max-width:1120px;margin:0 auto;padding:22px clamp(20px,4vw,40px)}
.lh-mark{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:23px;letter-spacing:-.02em}
.lh-nav{display:flex;align-items:center;gap:26px}
.lh-nav a{color:var(--muted);text-decoration:none;font-size:14.5px;font-weight:500}
.lh-nav a:hover{color:var(--ink)}
.lh-cta-sm{background:var(--accent);color:var(--on-accent);font-weight:600;font-size:14px;
  padding:9px 17px;border-radius:11px}

/* hero */
.lh-hero{max-width:1120px;margin:0 auto;display:grid;grid-template-columns:1.18fr .82fr;
  gap:clamp(28px,4vw,56px);align-items:center;
  padding:clamp(28px,6vw,72px) clamp(20px,4vw,40px) clamp(48px,7vw,96px)}
@media (max-width:820px){.lh-hero{grid-template-columns:1fr;padding-top:20px}}

.lh-eyebrow{display:inline-flex;align-items:center;gap:9px;font-size:12.5px;font-weight:700;
  letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:22px}
.lh-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block}

.lh-h{font-family:"Sentient",Georgia,serif;font-weight:600;letter-spacing:-.024em;
  display:flex;flex-direction:column;gap:6px}
.lh-removed{display:flex;flex-wrap:wrap;gap:2px 14px;
  font-size:clamp(21px,2.5vw,30px);line-height:1.12;color:var(--muted)}
.lh-neg{white-space:nowrap}
.lh-strk{position:relative;display:inline-block}
.lh-word{color:var(--muted)}
.lh-strike{position:absolute;left:-1px;right:-1px;top:54%;height:2.5px;border-radius:2px;
  background:var(--accent);transform:scaleX(1);transform-origin:left center}
.lh-payoff{font-size:clamp(46px,7.4vw,96px);line-height:1.0;margin-top:8px;display:block}
.lh-link{color:var(--accent)}
.lh-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

.lh-sub{margin-top:24px;max-width:44ch;font-size:clamp(16px,1.55vw,19px);color:var(--muted);line-height:1.55}
.lh-row{margin-top:30px;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.lh-btn{background:var(--accent);color:var(--on-accent);font-weight:600;font-size:16px;
  padding:15px 28px;border-radius:13px;text-decoration:none;
  transition:background .18s ease,transform .18s ease}
.lh-btn:hover{background:var(--accent-hover);transform:translateY(-1px)}
.lh-ghost{color:var(--ink);font-weight:600;font-size:16px;text-decoration:none;
  border-bottom:2px solid var(--accent);padding-bottom:2px}
.lh-trust{margin-top:26px;font-size:13px;color:var(--muted);letter-spacing:.01em}

/* 3D placeholder */
.lh-art{position:relative;display:flex;flex-direction:column;align-items:center;
  justify-content:center;min-height:340px}
@media (max-width:820px){.lh-art{min-height:260px;order:-1;margin-bottom:8px}}
.lh-glow{position:absolute;width:74%;aspect-ratio:1;border-radius:50%;
  background:radial-gradient(circle, color-mix(in srgb,var(--accent) 34%,transparent), transparent 68%);
  filter:blur(10px)}
.lh-canvas{position:absolute;inset:0}
`;
