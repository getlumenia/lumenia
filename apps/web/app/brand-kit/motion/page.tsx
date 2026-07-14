/**
 * /brand-kit/motion — the MOTION gallery. A single isolated home for every AI
 * image→video (I2V) asset produced for Lumenia: the launch sizzle reel, the 4
 * story beats (share → travel → tap → received), plus in-progress backgrounds.
 * Pipeline: Hugging Face Wan 2.2 14B I2V (free, ZeroGPU, watermark-free) → seamless
 * crossfade-loop + 720p encode. ISOLATED workspace route — never touches the live
 * landing group or the frozen claim route. Fonts (Sentient/Switzer) come from the
 * /brand-kit layout.
 */

function Vid({ src, poster }: { src: string; poster?: string }) {
  const webm = src.replace(/\.mp4$/, ".webm");
  return (
    <video
      className="mo-v"
      poster={poster}
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
      aria-hidden="true"
    >
      <source src={webm} type="video/webm" />
      <source src={src} type="video/mp4" />
    </video>
  );
}

export default function MotionGalleryPage() {
  return (
    <div className="mo">
      <style>{CSS}</style>

      <header className="mo-head">
        <p className="mo-eyebrow"><span className="mo-dot" />Brand kit · Motion</p>
        <h1 className="mo-h1">Stills, brought to life.</h1>
        <p className="mo-sub">
          Every frame here started as a static brand render, then was animated with an
          open image→video model (Wan 2.2) — free, and watermark-free. Subtle, premium,
          on-brand motion only.
        </p>
      </header>

      {/* Backgrounds */}
      <section className="mo-sec">
        <h2 className="mo-h2">Living backgrounds</h2>
        <p className="mo-note">
          Two paths, one look. The faithful aurora came from <em>Canva Magic Media</em> (kept it
          abstract, higher-res). The Wan model, given the near-empty hero glow, invented
          blooming flowers — pretty, on-palette, but a reinterpretation. Hybrid pipeline: Wan for
          characters/story, Canva for clean abstract backgrounds.
        </p>
        <div className="mo-grid">
          <figure className="mo-cell">
            <div className="mo-frame mo-frame-16"><Vid src="/brand-kit-assets/video/bg-howitworks.mp4" /></div>
            <figcaption>
              <span className="mo-t">bg-howitworks — aurora <span className="mo-tag">Canva · faithful</span></span>
              <span className="mo-b">Flowing periwinkle ribbon. Candidate for the scroll-opening band.</span>
            </figcaption>
          </figure>
          <figure className="mo-cell">
            <div className="mo-frame mo-frame-16"><Vid src="/brand-kit-assets/video/bg-cta.mp4" /></div>
            <figcaption>
              <span className="mo-t">bg-cta — glow <span className="mo-tag">Canva · faithful</span></span>
              <span className="mo-b">Draped surface undulates; the warm-centered glow breathes.</span>
            </figcaption>
          </figure>
          <figure className="mo-cell">
            <div className="mo-frame mo-frame-16"><Vid src="/brand-kit-assets/video/bg-footer.mp4" /></div>
            <figcaption>
              <span className="mo-t">bg-footer — mist <span className="mo-tag">Canva · faithful</span></span>
              <span className="mo-b">Periwinkle fog drifts and rises against the dark slab.</span>
            </figcaption>
          </figure>
          <figure className="mo-cell">
            <div className="mo-frame mo-frame-16"><Vid src="/brand-kit-assets/video/bg-soft.mp4" /></div>
            <figcaption>
              <span className="mo-t">bg-soft — fluid <span className="mo-tag">Canva · faithful</span></span>
              <span className="mo-b">Periwinkle-and-cream fluid morphs and flows.</span>
            </figcaption>
          </figure>
          <figure className="mo-cell">
            <div className="mo-frame mo-frame-16"><Vid src="/brand-kit-assets/video/bg-hero-bloom.mp4" /></div>
            <figcaption>
              <span className="mo-t">bg-hero — “bloom” <span className="mo-tag mo-tag-warn">experimental</span></span>
              <span className="mo-b">Wan hallucinated flowers from the abstract glow. Direction TBD.</span>
            </figcaption>
          </figure>
        </div>
      </section>

      {/* Coming next — honest queue */}
      <section className="mo-sec">
        <h2 className="mo-h2">Queued (waiting on free GPU quota)</h2>
        <ul className="mo-queue">
          <li><b>Backgrounds ✓</b> — cta, footer, howitworks, soft all done via Canva (watermark-free, 1376×768).</li>
          <li><b>bg-hero, faithful re-roll</b> — abstract-constrained vs the bloom, side by side.</li>
          <li><b>Mascot reactions</b> — wave, celebrate, thumbs-up, heart (i2v fills the gap where the skeletal rig failed on the blob).</li>
          <li><b>8 illustration micro-motions</b> — celebrate, request, phone, home, trust…</li>
        </ul>
        <p className="mo-foot">
          Free ZeroGPU resets daily (~3–4 clips/day at these settings). Resuming in batches.
        </p>
      </section>
    </div>
  );
}

const CSS = `
.mo{--paper:#F5F3EF;--surface:#FBFAF8;--ink:#1E1B22;--muted:#67626E;--line:#E5DFE8;--accent:#6E5FCE;--accent-soft:#E8E3F7;--warn:#D98A2B;
  background:var(--paper);color:var(--ink);min-height:100vh;
  font-family:"Switzer",ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;
  padding:clamp(40px,6vw,88px) clamp(20px,5vw,64px) 120px;max-width:1160px;margin:0 auto}
.mo :where(h1,h2,p,ul,figure,figcaption){margin:0}

.mo-eyebrow{display:inline-flex;align-items:center;gap:9px;font-size:12.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:18px}
.mo-dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.mo-h1{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(34px,6vw,68px);line-height:1.02;letter-spacing:-.025em}
.mo-sub{color:var(--muted);font-size:clamp(15px,1.7vw,18px);line-height:1.6;max-width:60ch;margin-top:16px}

.mo-reel{margin-top:clamp(36px,5vw,64px)}
.mo-reel-card{position:relative;aspect-ratio:16/9;border-radius:22px;overflow:hidden;border:1px solid var(--line);background:var(--surface);
  box-shadow:0 50px 90px -50px color-mix(in srgb,var(--accent) 55%,transparent)}
.mo-cap{color:var(--muted);font-size:13.5px;margin-top:12px;text-align:center}

.mo-sec{margin-top:clamp(48px,7vw,96px)}
.mo-h2{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(22px,3vw,34px);letter-spacing:-.02em;margin-bottom:24px;display:flex;align-items:center;gap:12px}
.mo-tag{font-family:"Switzer",sans-serif;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);
  background:var(--accent-soft);padding:4px 10px;border-radius:999px}
.mo-tag-warn{color:#8a5410;background:color-mix(in srgb,var(--warn) 22%,white)}

.mo-grid{display:grid;grid-template-columns:1fr 1fr;gap:clamp(18px,2.5vw,30px)}
@media (max-width:720px){.mo-grid{grid-template-columns:1fr}}
.mo-cell{display:flex;flex-direction:column;gap:14px}
.mo-frame{position:relative;border-radius:18px;overflow:hidden;border:1px solid var(--line);background:var(--surface);aspect-ratio:16/10}
.mo-frame-16{aspect-ratio:16/9}
.mo-v{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.mo-wide .mo-frame{aspect-ratio:16/9}
figcaption{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;align-items:baseline}
.mo-n{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:13px;color:var(--accent);grid-row:span 2}
.mo-t{font-weight:600;font-size:16px}
.mo-b{grid-column:2;color:var(--muted);font-size:14px;line-height:1.5}
.mo-wide figcaption{grid-template-columns:1fr}
.mo-wide .mo-b{grid-column:1}

.mo-note{color:var(--muted);font-size:14.5px;line-height:1.6;max-width:70ch;margin:-8px 0 22px}
.mo-note em{color:var(--ink);font-style:italic}

.mo-queue{list-style:none;display:flex;flex-direction:column;gap:12px;padding:0}
.mo-queue li{color:var(--muted);font-size:15px;line-height:1.5;padding-left:22px;position:relative}
.mo-queue li::before{content:"";position:absolute;left:0;top:8px;width:8px;height:8px;border-radius:50%;border:2px solid var(--accent)}
.mo-queue b{color:var(--ink);font-weight:600}
.mo-foot{color:var(--muted);font-size:13px;margin-top:20px;padding-top:20px;border-top:1px solid var(--line)}
`;
