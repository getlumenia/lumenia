/**
 * /brand-kit/marks: hand-drawn Lumenia mark sketches (vector, NOT AI-generated, 
 * image models reproduce existing crypto logos). Four original directions in the
 * Periwinkle palette, each shown large, in the wordmark lockup, at favicon sizes,
 * and reversed on the accent. Concept "Nothing to set up": letter/gesture-based,
 * warm, non-crypto: no chain-links, rings, hexagons, coins.
 */
export const metadata = { title: "Brand Kit: Marks (sketches)" };

type Mark = { id: string; name: string; note: string; svg: React.ReactNode };

/* viewBox 0 0 96 96, drawn with currentColor so colour comes from CSS */
const MARKS: Mark[] = [
  {
    id: "l-lumen",
    name: "L · lumen",
    note: "A monogram “L” whose path ends and a small lumen (light/value) lifts off, letter-based = instantly ownable, never crypto. Best at tiny sizes.",
    svg: (
      <>
        <path d="M34 22 V68 H60" fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="70" cy="33" r="8" fill="currentColor" />
      </>
    ),
  },
  {
    id: "cupped",
    name: "Cupped light",
    note: "Cupped hands / a bowl holding a lumen, the warmest, most human mark. “Money received, held.” Reads giving-and-receiving, not tech.",
    svg: (
      <>
        <path d="M26 48 a22 22 0 0 0 44 0" fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round" />
        <circle cx="48" cy="33" r="11" fill="currentColor" />
      </>
    ),
  },
  {
    id: "tap-echo",
    name: "Tap · echo",
    note: "A tap point with a single echo arc, the gesture of tapping the link and value answering back. Distinct from a wifi/signal glyph (one arc, offset).",
    svg: (
      <>
        <circle cx="42" cy="52" r="11" fill="currentColor" />
        <path d="M58 37 a20 20 0 0 1 0 30" fill="none" stroke="currentColor" strokeWidth="11" strokeLinecap="round" />
      </>
    ),
  },
  {
    id: "streak",
    name: "Lumen streak",
    note: "A lumen arriving along a curved streak, “light (value) travels by link, and lands.” A quiet nod to Stellar’s lumens without any crypto shape.",
    svg: (
      <>
        <path d="M22 70 Q46 58 54 46" fill="none" stroke="currentColor" strokeWidth="11" strokeLinecap="round" />
        <circle cx="62" cy="36" r="10" fill="currentColor" />
      </>
    ),
  },
];

function Glyph({ mark, size }: { mark: Mark; size: number }) {
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} aria-hidden="true">{mark.svg}</svg>
  );
}

export default function MarksPage() {
  return (
    <div className="mk">
      <style>{CSS}</style>

      <header className="mk-head">
        <p className="mk-kick">Lumenia · brand kit · mark sketches</p>
        <h1>Marks: hand-drawn</h1>
        <p className="mk-lede">
          Vector sketches, <strong>not</strong> AI (models reproduce crypto logos). Four original
          directions in Periwinkle, letter- or gesture-based, warm, non-crypto: no chain-links, rings,
          hexagons, coins. Shown large, in the wordmark lockup, at favicon sizes, and reversed.
        </p>
      </header>

      <div className="mk-grid">
        {MARKS.map((m) => (
          <article key={m.id} className="mk-card">
            <div className="mk-hero"><span className="mk-accent"><Glyph mark={m} size={72} /></span></div>

            <div className="mk-uses">
              {/* wordmark lockup */}
              <div className="mk-lockup">
                <span className="mk-accent"><Glyph mark={m} size={30} /></span>
                <span className="mk-word">Lumenia</span>
              </div>
              {/* favicon sizes */}
              <div className="mk-tiny">
                <span className="mk-accent"><Glyph mark={m} size={24} /></span>
                <span className="mk-accent"><Glyph mark={m} size={16} /></span>
                <span className="mk-tiny-lbl">24 · 16px</span>
              </div>
              {/* reversed */}
              <div className="mk-rev"><span className="mk-onacc"><Glyph mark={m} size={26} /></span></div>
            </div>

            <div className="mk-meta">
              <h3>{m.name}</h3>
              <p>{m.note}</p>
            </div>
          </article>
        ))}
      </div>

      <footer className="mk-foot">
        Pick one (or say “merge the streak’s dot into the L”) and I’ll refine it to a final grid-built
        vector + favicon set. The wordmark is <strong>Sentient</strong>; the mark stays optional and
        hand-made. Full kit: <code>brand.md</code> · <code>/brand-kit/system</code>.
      </footer>
    </div>
  );
}

const CSS = `
.mk{
  --paper:#F5F3EF;--surface:#FBFAF8;--ink:#1E1B22;--muted:#67626E;--line:#E5DFE8;
  --accent:#6E5FCE;--accent-soft:#E8E3F7;--on-accent:#F6F4FD;
  background:var(--paper);color:var(--ink);min-height:100dvh;
  font-family:"Switzer",ui-sans-serif,system-ui,-apple-system,sans-serif;line-height:1.55;
  padding:clamp(22px,4vw,64px);-webkit-font-smoothing:antialiased}
.mk :where(h1,h3,p){margin:0}
.mk-accent{color:var(--accent);display:inline-flex}
.mk-onacc{color:var(--on-accent);display:inline-flex}

.mk-head{max-width:1080px;margin:0 auto clamp(34px,5vw,60px)}
.mk-kick{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.mk-head h1{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(34px,6vw,58px);letter-spacing:-.02em;margin-bottom:14px}
.mk-lede{color:var(--muted);max-width:70ch;font-size:15.5px}
.mk-lede strong{color:var(--ink);font-weight:600}

.mk-grid{max-width:1080px;margin:0 auto;display:grid;grid-template-columns:repeat(2,1fr);gap:22px}
@media (max-width:760px){.mk-grid{grid-template-columns:1fr}}
.mk-card{border:1px solid var(--line);border-radius:20px;background:var(--surface);overflow:hidden;display:flex;flex-direction:column}

.mk-hero{display:flex;align-items:center;justify-content:center;padding:44px;
  background:radial-gradient(60% 60% at 50% 45%, color-mix(in srgb,var(--accent) 12%,transparent), transparent 70%);
  border-bottom:1px solid var(--line)}

.mk-uses{display:flex;align-items:center;gap:26px;flex-wrap:wrap;padding:22px clamp(20px,3vw,30px);border-bottom:1px solid var(--line)}
.mk-lockup{display:inline-flex;align-items:center;gap:10px}
.mk-word{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:26px;letter-spacing:-.01em;color:var(--ink)}
.mk-tiny{display:inline-flex;align-items:center;gap:12px}
.mk-tiny-lbl{font-size:11px;color:var(--muted);letter-spacing:.04em}
.mk-rev{display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:12px;background:var(--accent)}

.mk-meta{padding:18px clamp(20px,3vw,30px)}
.mk-meta h3{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:19px;margin-bottom:6px}
.mk-meta p{font-size:13.5px;color:var(--muted);line-height:1.55}

.mk-foot{max-width:1080px;margin:26px auto 0;padding-top:22px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
.mk-foot strong{color:var(--ink);font-weight:600}
.mk-foot code{background:var(--accent-soft);color:#4E40A8;padding:1px 6px;border-radius:6px;font-size:12.5px}
`;
