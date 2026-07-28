/**
 * Brand workspace: type pairings (real Fontshare faces) + 20 palette DIRECTIONS,
 * each shown NOT as a single swatch card but as a FULL landing layout: app-bar,
 * hero, the three-fears row, a proof/stat band, a colour-field CTA band, component
 * states (buttons/badge/input) and a dark-mode block, so every palette is judged
 * in real layout, in context. All copy is real product copy; no mock numbers.
 * Server component: no client JS. Derived surfaces come from color-mix so each
 * direction only carries its base tokens.
 */
import type { CSSProperties } from "react";

const HEADLINE = "No wallet. No seed phrase. Just a link.";
const SUB = "Tap the link: the money is already yours.";

const FEARS = [
  { t: "No wallet needed", b: "The link is how you receive. Nothing to download, nothing to open." },
  { t: "Nothing to memorize", b: "No seed phrase, no twelve words. Your face or a password, that’s it." },
  { t: "It can’t get lost", b: "Not claimed within 7 days? The money returns to the sender, automatically." },
];

const STATS = [
  { n: "$0.00", l: "what you pay to receive" },
  { n: "7 days", l: "to claim, or it returns" },
  { n: "~30s", l: "target time to arrive" },
];

type Pairing = { id: string; name: string; note: string; display: string; body: string };

const PAIRINGS: Pairing[] = [
  {
    id: "sentient", name: "Sentient + Switzer",
    note: "Warm modern serif: the human-trust, non-crypto signal (my pick).",
    display: '"Sentient", Georgia, serif', body: '"Switzer", system-ui, sans-serif',
  },
  {
    id: "clash", name: "Clash Display + Satoshi",
    note: "Confident grotesk: Base/Polygon energy, warmer than Geist.",
    display: '"Clash Display", system-ui, sans-serif', body: '"Satoshi", system-ui, sans-serif',
  },
  {
    id: "cabinet", name: "Cabinet Grotesk + General Sans",
    note: "Friendly, approachable: least intimidating, least premium.",
    display: '"Cabinet Grotesk", system-ui, sans-serif', body: '"General Sans", system-ui, sans-serif',
  },
  {
    id: "lora", name: "Lora + Inter (Stellar’s own)",
    note: "The funder’s exact pairing from the 2026 guidelines, instant Stellar alignment, but Inter is the generic default we’ve been avoiding.",
    display: '"Lora", Georgia, serif', body: '"Inter", system-ui, sans-serif',
  },
];

type Palette = {
  id: string; name: string; ground: string; personality: string; risk?: string; rec?: string;
  p: string; ink: string; mut: string; ln: string; acc: string; btnfg: string; ghost: string;
  dbg: string; dfg: string; dacc: string; committedDark?: boolean;
};

const PALETTES: Palette[] = [
  { id: "periwinkle", name: "Periwinkle: the selected direction", ground: "warm paper + periwinkle", rec: "Locked",
    personality: "Stellar's lavender warmed into a consumer periwinkle, soft, friendly, distinctly non-crypto, still a nod to the funder (#B7ACE8 as the dark-mode pop). This is the locked brand direction; the full spec lives in brand.md and /brand-kit/system.",
    p: "#F5F3EF", ink: "#1E1B22", mut: "#67626E", ln: "#E5DFE8", acc: "#6E5FCE", btnfg: "#F4F2FB", ghost: "#6E5FCE",
    dbg: "#14121A", dfg: "#EDEAF3", dacc: "#B7ACE8" },
];

function vars(pal: Palette): CSSProperties {
  return {
    ["--p" as string]: pal.p, ["--ink" as string]: pal.ink, ["--mut" as string]: pal.mut,
    ["--ln" as string]: pal.ln, ["--acc" as string]: pal.acc, ["--btnfg" as string]: pal.btnfg,
    ["--ghost" as string]: pal.ghost, ["--dbg" as string]: pal.dbg, ["--dfg" as string]: pal.dfg,
    ["--dacc" as string]: pal.dacc,
  } as CSSProperties;
}

function Check() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export default function BrandKitPage() {
  return (
    <div className="bk">
      <style>{CSS}</style>

      <header className="bk-head">
        <p className="bk-kick">Lumenia · internal brand workspace · not public</p>
        <h1>Brand Kit</h1>
        <p className="bk-lede">
          Concept: <strong>“Nothing to set up.”</strong> Palette is <strong>LOCKED: Periwinkle</strong>
          {" "}(the other explored directions were removed). It is shown below as a full landing layout, 
          app-bar, hero, the three fears, a proof band, a colour CTA and component states, so you see the
          selected colour in context. Full spec: <code>brand.md</code> · <code>/brand-kit/system</code>.
        </p>
      </header>

      {/* ---------- TYPE ---------- */}
      <section className="bk-section">
        <div className="bk-shd">
          <span className="bk-idx">A</span>
          <h2>Type pairings</h2>
          <span className="bk-hint">real Fontshare faces</span>
        </div>
        <div className="bk-type">
          {PAIRINGS.map((f) => (
            <article key={f.id} className="bk-pair">
              <div className="bk-pair-meta">
                <h3>{f.name}</h3>
                <p>{f.note}</p>
              </div>
              <p className="bk-pair-display" style={{ fontFamily: f.display }}>{HEADLINE}</p>
              <p className="bk-pair-body" style={{ fontFamily: f.body }}>
                You send a link. The person receiving it needs no wallet, no seed phrase and no app, 
                they tap it and the money is theirs. If nobody claims it within seven days, it comes back to you.
              </p>
              <p className="bk-pair-label" style={{ fontFamily: f.body }}>
                Backed by the Stellar Community Fund · testnet pilot
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* ---------- PALETTE ---------- */}
      <section className="bk-section">
        <div className="bk-shd">
          <span className="bk-idx">B</span>
          <h2>Palette directions</h2>
          <span className="bk-hint">the selected direction · full landing layout</span>
        </div>
        <div className="bk-stack">
          {PALETTES.map((pal) => <Showcase key={pal.id} pal={pal} />)}
        </div>
      </section>

      <footer className="bk-foot">
        <p>
          <strong>Locked:</strong> type → <strong>Sentient + Switzer</strong>; palette →
          {" "}<strong>Periwinkle</strong> (Stellar’s lavender, warmed). The other explored directions were
          removed. Full spec + tokens: <code>brand.md</code> and <code>/brand-kit/system</code>. Next: build
          the real hero in this palette.
        </p>
      </footer>
    </div>
  );
}

function Showcase({ pal }: { pal: Palette }) {
  return (
    <article className="sc" style={vars(pal)}>
      {/* app-bar */}
      <div className="sc-bar">
        <span className="sc-brand">Lumenia</span>
        <nav className="sc-nav">
          <span>How it works</span><span>Fees</span><span>Help</span>
        </nav>
        <span className="sc-bar-cta">Try the demo</span>
      </div>

      {/* hero */}
      <div className="sc-hero">
        <p className="sc-eyebrow">
          <span className="sc-dot" />{pal.name}
          {pal.rec ? <span className="sc-rec">{pal.rec}</span> : null}
          {pal.committedDark ? <span className="sc-tag">committed world</span> : null}
        </p>
        <h3 className="sc-h1">{HEADLINE}</h3>
        <p className="sc-sub">{SUB}</p>
        <div className="sc-row">
          <span className="sc-btn">See it work</span>
          <span className="sc-ghost">How it works →</span>
        </div>
      </div>

      {/* three fears */}
      <div className="sc-fears">
        {FEARS.map((f) => (
          <div key={f.t} className="sc-fear">
            <span className="sc-ficon"><Check /></span>
            <h4>{f.t}</h4>
            <p>{f.b}</p>
          </div>
        ))}
      </div>

      {/* proof / stat band */}
      <div className="sc-stats">
        {STATS.map((s) => (
          <div key={s.l} className="sc-stat">
            <b>{s.n}</b><span>{s.l}</span>
          </div>
        ))}
      </div>

      {/* colour-field CTA band */}
      <div className="sc-cta">
        <h3>Money, minus the setup.</h3>
        <span className="sc-cta-btn">Try the demo</span>
      </div>

      {/* component states */}
      <div className="sc-comp">
        <div className="sc-comp-row">
          <span className="sc-btn">Primary</span>
          <span className="sc-btn2">Secondary</span>
          <span className="sc-ghost">Ghost link →</span>
          <span className="sc-btn sc-dis">Disabled</span>
        </div>
        <div className="sc-comp-row">
          <span className="sc-badge"><span className="sc-badge-dot" />Backed by the Stellar Community Fund</span>
          <span className="sc-input"><span className="sc-input-pre">$</span>Enter an amount</span>
        </div>
      </div>

      {/* swatches + meta */}
      <div className="bk-sw">
        <Swatch label="Ground" hex={pal.p} />
        <Swatch label="Ink" hex={pal.ink} />
        <Swatch label="Muted" hex={pal.mut} />
        <Swatch label="Line" hex={pal.ln} />
        <Swatch label="Accent" hex={pal.acc} />
      </div>
      <div className="bk-meta">
        <p>{pal.personality}</p>
        {pal.risk ? <p className="bk-risk">{pal.risk}</p> : null}
      </div>

      {/* dark-mode block */}
      <div className="sc-dark">
        <p className="sc-eyebrow sc-eyebrow-d"><span className="sc-dot sc-dot-d" />Dark mode</p>
        <h4 className="sc-dark-h">{HEADLINE}</h4>
        <div className="sc-row">
          <span className="sc-dark-btn">See it work</span>
          <span className="sc-dark-ghost">How it works →</span>
        </div>
      </div>
    </article>
  );
}

function Swatch({ label, hex }: { label: string; hex: string }) {
  return (
    <div className="bk-swatch">
      <span className="bk-chip" style={{ background: hex }} />
      <b>{label}</b>
      <span>{hex}</span>
    </div>
  );
}

const CSS = `
.bk{--bg:#0f0f0e;--fg:#ECEAE3;--sub:#9A988F;--edge:#26261f;--edge2:#161613;
  min-height:100dvh;background:var(--bg);color:var(--fg);
  font-family:"Switzer",ui-sans-serif,system-ui,-apple-system,sans-serif;
  line-height:1.55;padding:clamp(22px,4vw,60px);-webkit-font-smoothing:antialiased}
@media (prefers-color-scheme:light){.bk{--bg:#F7F6F2;--fg:#1B1A16;--sub:#6C6B62;--edge:#E7E4DD;--edge2:#FBFAF7}}
.bk :where(h1,h2,h3,h4,p){margin:0}
.bk-head{max-width:1160px;margin:0 auto clamp(30px,4vw,52px)}
.bk-kick{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--sub);margin-bottom:12px}
.bk-head h1{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(34px,6vw,60px);letter-spacing:-.02em;margin-bottom:12px}
.bk-lede{color:var(--sub);max-width:70ch;font-size:15.5px}
.bk-lede strong{color:var(--fg);font-weight:600}

.bk-section{max-width:1160px;margin:0 auto clamp(40px,6vw,72px)}
.bk-shd{display:flex;align-items:baseline;gap:14px;padding-bottom:16px;margin-bottom:26px;border-bottom:1px solid var(--edge)}
.bk-idx{font-family:"Sentient",Georgia,serif;font-size:20px;color:var(--sub)}
.bk-shd h2{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(22px,3vw,30px);letter-spacing:-.01em}
.bk-hint{margin-left:auto;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--sub)}

/* type */
.bk-type{display:grid;gap:14px}
.bk-pair{border:1px solid var(--edge);border-radius:16px;background:var(--edge2);padding:clamp(20px,3vw,32px)}
.bk-pair-meta{display:flex;justify-content:space-between;gap:16px;align-items:baseline;flex-wrap:wrap;margin-bottom:18px}
.bk-pair-meta h3{font-size:15px;font-weight:600;color:var(--fg)}
.bk-pair-meta p{font-size:13px;color:var(--sub);max-width:52ch}
.bk-pair-display{font-weight:600;font-size:clamp(28px,4.6vw,50px);line-height:1.05;letter-spacing:-.02em;color:var(--fg);text-wrap:balance;margin-bottom:16px}
.bk-pair-body{font-size:clamp(15px,1.5vw,17px);color:var(--fg);opacity:.82;max-width:62ch;margin-bottom:14px}
.bk-pair-label{font-size:12px;letter-spacing:.06em;color:var(--sub);text-transform:uppercase}

/* palette stack */
.bk-stack{display:flex;flex-direction:column;gap:clamp(28px,4vw,48px)}

/* ---- SHOWCASE: a full landing layout per direction ---- */
.sc{
  --surface:color-mix(in srgb, var(--ink) 4%, var(--p));
  --sline:color-mix(in srgb, var(--ink) 13%, var(--p));
  --band:color-mix(in srgb, var(--acc) 11%, var(--p));
  --acc-soft:color-mix(in srgb, var(--acc) 16%, var(--p));
  --dis-bg:color-mix(in srgb, var(--ink) 10%, var(--p));
  --dis-fg:color-mix(in srgb, var(--ink) 34%, var(--p));
  background:var(--p);color:var(--ink);border:1px solid var(--sline);
  border-radius:22px;overflow:hidden;box-shadow:0 1px 0 rgba(0,0,0,.02)}
.sc :where(h3,h4,p){margin:0}
.sc-pad{padding:clamp(22px,3vw,40px)}

/* app-bar */
.sc-bar{display:flex;align-items:center;gap:22px;padding:15px clamp(22px,3vw,40px);border-bottom:1px solid var(--sline)}
.sc-brand{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:19px;color:var(--ink)}
.sc-nav{display:flex;gap:22px}
.sc-nav span{font-size:13px;color:var(--mut)}
.sc-bar-cta{margin-left:auto;background:var(--acc);color:var(--btnfg);font-size:13px;font-weight:600;padding:9px 17px;border-radius:10px}
@media (max-width:640px){.sc-nav{display:none}}

/* hero */
.sc-hero{padding:clamp(32px,4.5vw,64px) clamp(22px,3vw,40px)}
.sc-eyebrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--acc);margin-bottom:20px}
.sc-dot{width:7px;height:7px;border-radius:50%;background:var(--acc)}
.sc-rec{font-size:10px;font-weight:700;letter-spacing:.04em;color:#1c7a4f;background:rgba(28,122,79,.12);padding:3px 9px;border-radius:999px;text-transform:uppercase}
.sc-tag{font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--mut);border:1px solid var(--sline);padding:2px 8px;border-radius:999px;text-transform:uppercase}
.sc-h1{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(30px,4.8vw,56px);line-height:1.03;letter-spacing:-.022em;color:var(--ink);text-wrap:balance;max-width:16ch;margin-bottom:18px}
.sc-sub{font-size:clamp(15px,1.6vw,19px);color:var(--mut);max-width:42ch;margin-bottom:28px}
.sc-row{display:flex;align-items:center;gap:22px;flex-wrap:wrap}
.sc-btn{background:var(--acc);color:var(--btnfg);font-weight:600;font-size:15px;padding:13px 24px;border-radius:12px}
.sc-btn2{background:transparent;color:var(--ink);font-weight:600;font-size:15px;padding:11.5px 22px;border-radius:12px;border:1.5px solid var(--sline)}
.sc-ghost{color:var(--ink);font-weight:600;font-size:15px;border-bottom:2px solid var(--acc);padding-bottom:2px}
.sc-dis{background:var(--dis-bg);color:var(--dis-fg)}

/* three fears */
.sc-fears{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:0 clamp(22px,3vw,40px) clamp(24px,3vw,34px)}
@media (max-width:720px){.sc-fears{grid-template-columns:1fr}}
.sc-fear{background:var(--surface);border:1px solid var(--sline);border-radius:15px;padding:24px}
.sc-ficon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9px;background:var(--acc-soft);color:var(--acc);margin-bottom:15px}
.sc-fear h4{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:18px;color:var(--ink);margin-bottom:7px}
.sc-fear p{font-size:13.5px;color:var(--mut);line-height:1.5}

/* proof band */
.sc-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--sline);border-top:1px solid var(--sline);border-bottom:1px solid var(--sline)}
@media (max-width:560px){.sc-stats{grid-template-columns:1fr}}
.sc-stat{background:var(--band);padding:clamp(22px,3vw,32px) clamp(22px,3vw,40px);display:flex;flex-direction:column;gap:7px}
.sc-stat b{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(27px,3.6vw,42px);color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.sc-stat span{font-size:12.5px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}

/* colour-field CTA */
.sc-cta{background:var(--acc);color:var(--btnfg);display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;padding:clamp(28px,3.6vw,48px) clamp(22px,3vw,40px)}
.sc-cta h3{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(23px,3.2vw,36px);letter-spacing:-.015em;color:var(--btnfg);text-wrap:balance}
.sc-cta-btn{background:var(--btnfg);color:var(--acc);font-weight:600;font-size:15px;padding:13px 24px;border-radius:12px}

/* component states */
.sc-comp{display:flex;flex-direction:column;gap:18px;padding:clamp(24px,3vw,34px) clamp(22px,3vw,40px)}
.sc-comp-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.sc-badge{display:inline-flex;align-items:center;gap:9px;background:var(--acc-soft);color:var(--ink);font-size:13px;font-weight:600;padding:8px 15px;border-radius:999px}
.sc-badge-dot{width:8px;height:8px;border-radius:50%;background:var(--acc)}
.sc-input{display:inline-flex;align-items:center;gap:9px;background:var(--surface);border:1.5px solid var(--sline);border-radius:12px;padding:12px 16px;color:var(--mut);font-size:15px}
.sc-input-pre{color:var(--ink);font-weight:700}

/* swatches + meta reused inside showcase */
.bk-sw{display:flex;background:var(--surface);padding:clamp(20px,3vw,28px) clamp(22px,3vw,40px);border-top:1px solid var(--sline)}
.bk-swatch{flex:1;display:flex;flex-direction:column;gap:6px}
.bk-chip{height:34px;border-radius:8px;border:1px solid rgba(128,128,128,.22)}
.bk-swatch b{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);opacity:.85}
.bk-swatch span:last-child{font-size:10.5px;color:var(--mut);font-variant-numeric:tabular-nums}
.bk-meta{padding:16px clamp(22px,3vw,40px);background:var(--surface);border-top:1px solid var(--sline)}
.bk-meta p{font-size:13.5px;color:var(--mut);line-height:1.55}
.bk-risk{color:#c56a3a;margin-top:6px}
@media (prefers-color-scheme:light){.bk-risk{color:#b0492e}}

/* dark-mode block */
.sc-dark{background:var(--dbg);color:var(--dfg);padding:clamp(30px,4vw,52px) clamp(22px,3vw,40px)}
.sc-eyebrow-d{color:var(--dacc)}
.sc-dot-d{background:var(--dacc)}
.sc-dark-h{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(24px,3.4vw,40px);line-height:1.04;letter-spacing:-.022em;color:var(--dfg);max-width:16ch;margin:0 0 22px;text-wrap:balance}
.sc-dark-btn{background:var(--dacc);color:var(--dbg);font-weight:600;font-size:14px;padding:12px 22px;border-radius:11px}
.sc-dark-ghost{color:var(--dfg);font-weight:600;font-size:14px;border-bottom:2px solid var(--dacc);padding-bottom:2px}

.bk-foot{max-width:1160px;margin:0 auto;padding-top:24px;border-top:1px solid var(--edge);color:var(--sub);font-size:14.5px}
.bk-foot strong{color:var(--fg);font-weight:600}
`;
