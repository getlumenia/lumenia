/**
 * /brand-kit/brand: the Lumenia brand book, in the STELLAR "Brand Guidelines 2026"
 * template. Pages 01-07 are the guidelines proper (cover · wordmark/type/colour ·
 * graphics/highlights · icon guidelines · icons · our 3D asset). Pages 08+ carry every
 * OTHER brand-kit route in verbatim, page by page, each behind a P.0X plate, so the
 * whole workspace reads as one sequential document. The individual routes are NOT
 * deleted; this is the single consolidated "brand" route.
 *
 * Server component: it composes the other route components directly (server pages import
 * cleanly; the client pages hydrate). The WebGL model on 07 comes through a client
 * wrapper (ModelStage) so the doc itself stays a Server Component. Brand CSS is scoped
 * under .bg; the embedded routes live OUTSIDE .bg and keep their own (prefixed) styles.
 *
 * Isolated workspace route, it never touches the live landing or the frozen claim route.
 */
import type { Metadata } from "next";
import ModelStage from "../../../components/brand3d/ModelStage";
import ExplorePage from "../page";
import BrandSystemPage from "../system/page";
import MarksPage from "../marks/page";
import ConceptsPage from "../concepts/page";
import HeroPreview from "../hero/page";
import ObjectInspector from "../object/page";
import AssetKit from "../assets/page";
import AvatarsStatic from "../../../components/brand3d/AvatarsStatic";

export const metadata: Metadata = {
  title: "Lumenia: Brand Guidelines 2026",
  robots: { index: false, follow: false },
};

const LIGHT: Array<[string, string, string]> = [
  ["Paper", "#F5F3EF", "245 · 243 · 239"],
  ["Surface", "#FBFAF8", "251 · 250 · 248"],
  ["Ink", "#1E1B22", "30 · 27 · 34"],
  ["Muted", "#67626E", "103 · 98 · 110"],
  ["Line", "#E5DFE8", "229 · 223 · 232"],
  ["Accent", "#6E5FCE", "110 · 95 · 206"],
  ["Accent soft", "#E8E3F7", "232 · 227 · 247"],
  ["On-accent", "#F6F4FD", "246 · 244 · 253"],
];

const DARK: Array<[string, string, string]> = [
  ["Paper", "#15121C", "21 · 18 · 28"],
  ["Surface", "#1D1926", "29 · 25 · 38"],
  ["Ink", "#EDEAF3", "237 · 234 · 243"],
  ["Muted", "#A59DB2", "165 · 157 · 178"],
  ["Accent (Stellar lavender)", "#B7ACE8", "183 · 172 · 232"],
];

const SEMANTIC: Array<[string, string, string]> = [
  ["Success", "#6E5FCE", "the accent + a check: never green"],
  ["Warning", "#D98A2B", "functional only"],
  ["Danger", "#C4362B", "functional only"],
];

// The other routes, moved in page by page from page 08 onward.
const PLATES: Array<[string, string, React.ComponentType]> = [
  ["08", "Explore: directions", ExplorePage],
  ["09", "Design system", BrandSystemPage],
  ["10", "Marks: sketches", MarksPage],
  ["11", "Hero-object directions", ConceptsPage],
  ["12", "Landing hero", HeroPreview],
  ["13", "Object: three.js inspector", ObjectInspector],
  ["14", "Asset kit", AssetKit],
  ["15", "Avatars", AvatarsStatic],
];

export default function BrandBook() {
  return (
    <>
      <div className="bg">
        <style>{CSS}</style>

        {/* ───────────────────────── 01 · COVER ───────────────────────── */}
        <section className="pg pg-cover">
          <Head n="01" />
          <div className="cover-row">
            <span className="cover-num">01</span>
            <h1 className="cover-title">Brand<br />Guidelines</h1>
          </div>
          <p className="cover-foot">
            Lumenia · Periwinkle · Sentient + Switzer · “Nothing to set up.” · Backed by the Stellar Community Fund
          </p>
        </section>

        {/* ─────────────────── 02 · LOGO · TYPE · COLOUR ─────────────────── */}
        <section className="pg">
          <Head n="02" />
          <div className="cols3">
            <div>
              <h2 className="sec-h">Brand wordmark</h2>
              <p className="sec-p">The wordmark <em>is</em> the identity: set in Sentient. Any symbol is hand-drawn vector, never AI-generated.</p>
              <div className="logo-plate"><span className="logo-word">Lumenia</span></div>
              <div className="logo-plate logo-plate-inv"><span className="logo-word">Lumenia</span></div>
              <p className="seal"><span className="seal-dot" />Backed by the Stellar Community Fund</p>
            </div>

            <div>
              <h2 className="sec-h">Typography</h2>
              <p className="sec-p">A warm serif display + a clean humanist sans, the fastest non-crypto, human-trust signal.</p>
              <div className="type-row">
                <span className="type-serif">Sentient</span>
                <span className="type-note">Display: 500/600. Hero clamp(40-88px), tracking −0.02em, balance.</span>
              </div>
              <div className="type-row">
                <span className="type-sans">Switzer</span>
                <span className="type-note">Body/UI: 400/500/600. Lead 18-20, body 16, tabular-nums on figures.</span>
              </div>
              <p className="type-specimen">No wallet. No seed phrase. Just a link.</p>
            </div>

            <div>
              <h2 className="sec-h">Colour: Periwinkle</h2>
              <p className="sec-p">Warm off-white ground, one periwinkle accent. Light is primary; dark is a system alternate whose accent is Stellar’s lavender.</p>
              <p className="sub-lab">Primary: light</p>
              <div className="sw-list">
                {LIGHT.map(([name, hex, rgb]) => (
                  <div className="sw" key={name}>
                    <span className="sw-chip" style={{ background: hex }} />
                    <span className="sw-name">{name}</span>
                    <span className="sw-hex">{hex}</span>
                    <span className="sw-rgb">{rgb}</span>
                  </div>
                ))}
              </div>
              <p className="sub-lab">Secondary: dark alternate</p>
              <div className="sw-list">
                {DARK.map(([name, hex, rgb]) => (
                  <div className="sw" key={name}>
                    <span className="sw-chip" style={{ background: hex }} />
                    <span className="sw-name">{name}</span>
                    <span className="sw-hex">{hex}</span>
                    <span className="sw-rgb">{rgb}</span>
                  </div>
                ))}
              </div>
              <p className="sub-lab">Semantic</p>
              <div className="sw-list">
                {SEMANTIC.map(([name, hex, note]) => (
                  <div className="sw" key={name}>
                    <span className="sw-chip" style={{ background: hex }} />
                    <span className="sw-name">{name}</span>
                    <span className="sw-rgb sw-rgb-wide">{note}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ─────────────────── 03 · GRAPHICS · HIGHLIGHTS ─────────────────── */}
        <section className="pg">
          <Head n="03" />
          <div className="cols2">
            <div>
              <h2 className="sec-h">Graphics</h2>
              <p className="sec-p">Warm paper grain, a soft periwinkle glow, and fine noise for depth and calm atmosphere, never crypto gradients, neon, or glass.</p>
              <div className="gfx-grid">
                <div className="gfx gfx-glow" />
                <div className="gfx gfx-grain" />
                <div className="gfx gfx-paper" />
                <div className="gfx gfx-soft" />
              </div>
            </div>
            <div>
              <h2 className="sec-h">Highlights</h2>
              <p className="sec-p">The signature motif is <em>subtraction</em>: the scary steps struck through, until only “a link” remains, plus the arrival check.</p>
              <div className="hl-box">
                <p className="hl-line"><s>wallet</s> <s>seed&nbsp;phrase</s> <s>app</s> <s>gas</s></p>
                <p className="hl-keep">Just a <span className="hl-accent">link</span>.</p>
                <span className="hl-check" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ─────────────────── 04 · ICON GUIDELINES ─────────────────── */}
        <section className="pg">
          <Head n="04" />
          <div className="cols2">
            <div>
              <h2 className="sec-h">Icon guidelines</h2>
              <p className="sec-p"><b>Grid.</b> 128×128 base, icons fit the square or its inner rectangles. Optical adjustments allowed.</p>
              <p className="sec-p"><b>Stroke.</b> 1.5-2px, rounded joins (Phosphor, warmer than Lucide). Accent used sparingly, for action + arrival only.</p>
              <p className="sec-p"><b>Texture.</b> On light, marks are Ink #1E1B22; on dark, Accent #B7ACE8. No coin/token clichés.</p>
              <div className="icon-palette">
                {[["#FBFAF8", "surface"], ["#6E5FCE", "accent"], ["#B7ACE8", "lavender"], ["#1E1B22", "ink"]].map(([c, l]) => (
                  <div className="ip" key={l}><span className="ip-chip" style={{ background: c, borderColor: c === "#FBFAF8" ? "#E5DFE8" : "transparent" }} /><span>{l}</span></div>
                ))}
              </div>
            </div>
            <div>
              <h2 className="sec-h">Grid &amp; construction</h2>
              <div className="grid-demo">
                <div className="gd-cell"><div className="gd-square" /></div>
                <div className="gd-cell"><div className="gd-square gd-tall" /></div>
                <div className="gd-cell"><div className="gd-square gd-wide" /></div>
              </div>
              <p className="sec-p sec-note">Examples: full square · vertical · horizontal fit.</p>
            </div>
          </div>
        </section>

        {/* ─────────────────── 05 · ICON SET ─────────────────── */}
        <section className="pg">
          <Head n="05" />
          <h2 className="sec-h">Icons: light &amp; dark</h2>
          <p className="sec-p sec-p-wide">
            The full icon set is <b>in production</b>: generated as a matched family (Meshy + hand vector),
            light and dark variants, following the guidelines on the previous page. Placeholders below are
            honest empties, not mock art.
          </p>
          <div className="icon-empties">
            {Array.from({ length: 16 }).map((_, i) => (
              <div className={`ie ${i % 5 === 0 ? "ie-accent" : ""}`} key={i}>
                <span className="ie-plus">+</span>
              </div>
            ))}
          </div>
          <p className="sec-note">In production · light on #FBFAF8 · dark on #15121C.</p>
        </section>

        {/* ─────────────────── 07 · OUR ASSET, THE MASCOT ─────────────────── */}
        <section className="pg pg-model">
          <Head n="07" />
          <div className="model-wrap">
            <div className="model-copy">
              <h2 className="sec-h">Our asset: the messenger</h2>
              <p className="sec-p">
                The Lumenia mascot: a warm ceramic companion who hands you the money, the envelope is the
                link. Built Meshy concept → image→3D → three.js (smooth normals + envelope pulled to the
                accent). This is a live model, not a picture.
              </p>
              <ul className="model-facts">
                <li>Matte ceramic · warm cream + Periwinkle envelope</li>
                <li>react-three-fiber · lazy-loaded · idle float</li>
                <li>Reused on the hero; more assets (icon set, scroll video) next, via Meshy</li>
              </ul>
            </div>
            <div className="model-stage">
              <ModelStage />
            </div>
          </div>
        </section>
      </div>

      {/* ─── 08+ · the rest of the workspace, moved in page by page ─── */}
      {PLATES.map(([n, title, Comp]) => (
        <div key={n}>
          <PlateHead n={n} title={title} />
          <Comp />
        </div>
      ))}

      <footer style={FOOT_STYLE}>
        Lumenia Brand Guidelines 2026 · in the Stellar template · pages 01-07 are the guidelines; 08+ are
        the workspace routes moved in, page by page · full spec in <code style={CODE_STYLE}>brand.md</code>.
      </footer>
    </>
  );
}

function Head({ n }: { n: string }) {
  return (
    <div className="pg-head">
      <span className="ph-mark">Lumenia</span>
      <span className="ph-mid">Brand Guidelines 2026</span>
      <span className="ph-no">P. {n}</span>
    </div>
  );
}

function PlateHead({ n, title }: { n: string; title: string }) {
  return (
    <div style={PLATE_HEAD_STYLE}>
      <span style={{ fontFamily: '"Sentient",Georgia,serif', fontWeight: 600, fontStyle: "italic" }}>Lumenia</span>
      <span style={{ margin: "0 auto", color: "#A59DB2" }}>{title} · Brand Guidelines 2026</span>
      <span style={{ fontWeight: 600, letterSpacing: ".04em" }}>P. {n}</span>
    </div>
  );
}

const PLATE_HEAD_STYLE: React.CSSProperties = {
  background: "#100D16",
  color: "#F1EEF7",
  borderTop: "1px solid #2A2438",
  borderBottom: "1px solid #B7ACE8",
  padding: "11px clamp(20px,4vw,44px)",
  display: "flex",
  alignItems: "baseline",
  gap: 16,
  fontFamily: '"Switzer",ui-sans-serif,system-ui,sans-serif',
  fontSize: 13,
};

const FOOT_STYLE: React.CSSProperties = {
  background: "#100D16",
  color: "#A59DB2",
  fontFamily: '"Switzer",ui-sans-serif,system-ui,sans-serif',
  fontSize: 13,
  lineHeight: 1.6,
  padding: "26px clamp(20px,4vw,44px)",
  borderTop: "1px solid #2A2438",
};

const CODE_STYLE: React.CSSProperties = {
  background: "rgba(183,172,232,.14)",
  color: "#B7ACE8",
  padding: "1px 6px",
  borderRadius: 6,
};

const CSS = `
.bg{
  --bg:#100D16;--panel:#171320;--ink:#F1EEF7;--muted:#A59DB2;--line:#2A2438;
  --accent:#B7ACE8;--accent2:#6E5FCE;--paper:#F5F3EF;
  background:var(--bg);color:var(--ink);
  font-family:"Switzer",ui-sans-serif,system-ui,sans-serif;line-height:1.55;
  -webkit-font-smoothing:antialiased}
.bg :where(h1,h2,p,ul){margin:0}
.bg s{color:var(--muted);text-decoration-color:var(--accent);text-decoration-thickness:2px}
.bg code{background:rgba(183,172,232,.14);color:var(--accent);padding:1px 6px;border-radius:6px;font-size:12.5px}

.bg .pg{max-width:1180px;margin:0 auto;padding:clamp(26px,4vw,54px) clamp(20px,4vw,44px);
  border-bottom:1px solid var(--line);min-height:78vh;display:flex;flex-direction:column}
.bg .pg-head{display:flex;align-items:baseline;gap:16px;padding-bottom:12px;margin-bottom:30px;
  border-bottom:1px solid var(--accent);font-size:13px}
.bg .ph-mark{font-family:"Sentient",Georgia,serif;font-weight:600;font-style:italic;letter-spacing:-.01em}
.bg .ph-mid{margin:0 auto;color:var(--muted)}
.bg .ph-no{font-weight:600;letter-spacing:.04em}

.bg .pg-cover{min-height:92vh;justify-content:center}
.bg .cover-row{display:flex;gap:clamp(24px,5vw,72px);align-items:flex-start;flex-wrap:wrap}
.bg .cover-num{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(90px,18vw,240px);line-height:.8;color:var(--accent)}
.bg .cover-title{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(56px,12vw,150px);line-height:.92;letter-spacing:-.02em}
.bg .cover-foot{margin-top:auto;padding-top:40px;color:var(--muted);font-size:14px;letter-spacing:.01em}

.bg .sec-h{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(22px,2.6vw,30px);letter-spacing:-.01em;margin-bottom:10px}
.bg .sec-p{color:var(--muted);font-size:14px;line-height:1.6;margin-bottom:12px;max-width:46ch}
.bg .sec-p b{color:var(--ink);font-weight:600}
.bg .sec-p-wide{max-width:70ch}
.bg .sec-note{color:var(--muted);font-size:12px;letter-spacing:.05em;text-transform:uppercase;margin-top:14px}
.bg .cols3{display:grid;grid-template-columns:repeat(3,1fr);gap:clamp(20px,3vw,40px)}
.bg .cols2{display:grid;grid-template-columns:1fr 1fr;gap:clamp(22px,4vw,48px)}
@media (max-width:900px){.bg .cols3,.bg .cols2{grid-template-columns:1fr}}
.bg .sub-lab{margin:16px 0 8px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--accent)}

.bg .logo-plate{background:var(--paper);border-radius:14px;padding:24px;display:flex;justify-content:center;margin-bottom:10px}
.bg .logo-plate-inv{background:#0A0810;border:1px solid var(--line)}
.bg .logo-word{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:30px;letter-spacing:-.02em}
.bg .logo-plate .logo-word{color:#1E1B22}
.bg .logo-plate-inv .logo-word{color:#F1EEF7}
.bg .seal{display:inline-flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:var(--muted)}
.bg .seal-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block}

.bg .type-row{display:flex;flex-direction:column;gap:2px;padding:12px 0;border-top:1px solid var(--line)}
.bg .type-serif{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:34px}
.bg .type-sans{font-family:"Switzer",sans-serif;font-weight:600;font-size:32px}
.bg .type-note{color:var(--muted);font-size:12.5px}
.bg .type-specimen{margin-top:16px;font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(20px,2.4vw,28px);line-height:1.1;letter-spacing:-.01em}

.bg .sw-list{display:flex;flex-direction:column;gap:7px}
.bg .sw{display:grid;grid-template-columns:24px 1.1fr 74px 1fr;align-items:center;gap:10px;font-size:12px}
.bg .sw-chip{width:24px;height:24px;border-radius:7px;border:1px solid rgba(255,255,255,.12)}
.bg .sw-name{color:var(--ink);font-weight:500}
.bg .sw-hex{color:var(--muted);font-variant-numeric:tabular-nums}
.bg .sw-rgb{color:var(--muted);font-variant-numeric:tabular-nums;font-size:11.5px}
.bg .sw-rgb-wide{grid-column:3 / span 2}

.bg .gfx-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.bg .gfx{aspect-ratio:1.5;border-radius:12px;border:1px solid var(--line)}
.bg .gfx-glow{background:radial-gradient(60% 60% at 50% 45%,#B7ACE8,transparent 70%),#100D16}
.bg .gfx-grain{background:radial-gradient(circle at 50% 50%,rgba(183,172,232,.5),transparent 70%),repeating-conic-gradient(rgba(255,255,255,.05) 0 1deg, transparent 1deg 2deg),#15121C}
.bg .gfx-paper{background:radial-gradient(70% 60% at 40% 30%,#FBFAF8,#EDE7E0)}
.bg .gfx-soft{background:linear-gradient(135deg,#E8E3F7,#B7ACE8)}

.bg .hl-box{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px}
.bg .hl-line{font-family:"Sentient",Georgia,serif;font-size:clamp(18px,2vw,24px);color:var(--muted);display:flex;gap:14px;flex-wrap:wrap}
.bg .hl-keep{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(30px,4vw,50px);letter-spacing:-.02em;margin-top:8px}
.bg .hl-accent{color:var(--accent)}
.bg .hl-check{position:absolute;right:22px;bottom:22px;width:46px;height:46px;border-radius:50%;background:rgba(183,172,232,.16);color:var(--accent);display:grid;place-items:center}

.bg .icon-palette{display:flex;gap:16px;margin-top:14px}
.bg .ip{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:11px;color:var(--muted)}
.bg .ip-chip{width:40px;height:40px;border-radius:50%;border:1px solid transparent}
.bg .grid-demo{display:flex;gap:14px}
.bg .gd-cell{width:110px;height:110px;border-radius:10px;
  background:linear-gradient(rgba(183,172,232,.18) 1px, transparent 1px) 0 0/100% 13.75px,linear-gradient(90deg, rgba(183,172,232,.18) 1px, transparent 1px) 0 0/13.75px 100%,var(--panel);
  border:1px solid var(--line);display:grid;place-items:center}
.bg .gd-square{width:74px;height:74px;border-radius:8px;background:rgba(110,95,206,.35);border:1px solid var(--accent2)}
.bg .gd-tall{width:46px;height:88px}
.bg .gd-wide{width:88px;height:46px}

.bg .icon-empties{display:grid;grid-template-columns:repeat(8,1fr);gap:12px;margin-top:8px}
@media (max-width:760px){.bg .icon-empties{grid-template-columns:repeat(4,1fr)}}
.bg .ie{aspect-ratio:1;border:1px dashed var(--line);border-radius:12px;display:grid;place-items:center;color:var(--muted)}
.bg .ie-accent{border-color:rgba(183,172,232,.5);background:rgba(183,172,232,.06)}
.bg .ie-plus{font-size:20px;opacity:.4}

.bg .pg-model{min-height:88vh}
.bg .model-wrap{display:grid;grid-template-columns:.9fr 1.1fr;gap:clamp(24px,4vw,48px);align-items:center;flex:1}
@media (max-width:900px){.bg .model-wrap{grid-template-columns:1fr}}
.bg .model-facts{list-style:none;display:flex;flex-direction:column;gap:8px;margin-top:14px}
.bg .model-facts li{position:relative;padding-left:18px;color:var(--muted);font-size:13.5px}
.bg .model-facts li::before{content:"";position:absolute;left:0;top:8px;width:7px;height:7px;border-radius:50%;background:var(--accent)}
.bg .model-stage{position:relative;min-height:min(66vh,560px);height:100%;background:radial-gradient(58% 52% at 50% 46%, rgba(183,172,232,.22), transparent 72%)}
`;
