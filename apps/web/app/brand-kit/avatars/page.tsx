/**
 * /brand-kit/avatars: the 5 Lumenia avatars (the messenger + 4 pose variations), live
 * in three.js with procedural idle motion. ISOLATED workspace route; never touches the
 * live landing or the frozen claim route. WebGL is client-only (dynamic, ssr:false).
 */
"use client";

import dynamic from "next/dynamic";

const AvatarShowcase = dynamic(() => import("../../../components/brand3d/AvatarShowcase"), {
  ssr: false,
});

export default function AvatarsPage() {
  return (
    <div className="ava">
      <style>{CSS}</style>
      <header className="ava-head">
        <span className="ava-mark">Lumenia</span>
        <div>
          <h1 className="ava-title">The avatar: the messenger &amp; variations</h1>
          <p className="ava-sub">
            One locked character, seven living poses, all Meshy image→3D, smoothed and animated
            with procedural idle motion in three.js (Meshy skeletal rigging can’t rig a stylised
            non-humanoid blob). Each is a real model, drag-free idle by default. Reused across the
            hero, onboarding, the claim moment, request, and success states.
          </p>
        </div>
      </header>

      <AvatarShowcase />

      <p className="ava-foot">
        The little-courier &amp; bear directions are retired · variations built from the messenger via
        image→image → image→3D · see also the Asset kit and the Brand book.
      </p>
    </div>
  );
}

const CSS = `
.ava{--paper:#F5F3EF;--ink:#1E1B22;--muted:#67626E;--accent:#6E5FCE;--line:#E5DFE8;
  min-height:100dvh;background:var(--paper);color:var(--ink);
  font-family:"Switzer",ui-sans-serif,system-ui,sans-serif;padding:clamp(20px,4vw,52px)}
.ava :where(h1,p){margin:0}
.ava-head{display:flex;gap:20px;align-items:baseline;max-width:1280px;margin:0 auto 32px;flex-wrap:wrap}
.ava-mark{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:22px;letter-spacing:-.02em}
.ava-title{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(26px,3.6vw,40px);letter-spacing:-.02em}
.ava-sub{margin-top:8px;color:var(--muted);font-size:15px;max-width:76ch;line-height:1.55}
.ava .av-grid{max-width:1280px;margin:0 auto}
.ava-foot{max-width:1280px;margin:26px auto 0;color:var(--muted);font-size:13px;line-height:1.6}
`;
