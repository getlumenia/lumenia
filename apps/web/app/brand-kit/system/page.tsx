/**
 * /brand-kit/system: the LOCKED Lumenia brand kit rendered: the Periwinkle system
 * (Stellar's lavender, warmed), Sentient + Switzer, and the component set, the
 * visual companion to brand.md. Server component; real product copy, no mock data.
 * Inherits the Fontshare faces from the /brand-kit layout.
 */
import type { CSSProperties } from "react";

export const metadata = { title: "Brand Kit: System (Periwinkle)" };

const LIGHT: Array<[string, string, string]> = [
  ["--paper", "#F5F3EF", "page ground"],
  ["--surface", "#FBFAF8", "raised cards"],
  ["--ink", "#1E1B22", "primary text"],
  ["--muted", "#67626E", "secondary text"],
  ["--line", "#E5DFE8", "hairlines"],
  ["--accent", "#6E5FCE", "periwinkle: actions"],
  ["--accent-hover", "#5F50C2", "button hover"],
  ["--accent-pressed", "#4E40A8", "button active"],
  ["--accent-soft", "#E8E3F7", "chips, tints"],
  ["--on-accent", "#F6F4FD", "text on accent"],
];

const DARK: Array<[string, string, string]> = [
  ["--paper", "#15121C", "ground"],
  ["--surface", "#1D1926", "raised cards"],
  ["--ink", "#EDEAF3", "primary text"],
  ["--muted", "#A59DB2", "secondary text"],
  ["--line", "#2C2536", "hairlines"],
  ["--accent", "#B7ACE8", "Stellar lavender"],
  ["--accent-soft", "#2A2338", "chips, tints"],
  ["--on-accent", "#1A1622", "text on accent"],
];

const TYPE_SCALE: Array<[string, string, string]> = [
  ["Display", "clamp(40-88px) · Sentient 600", "Money, minus the setup."],
  ["H1", "clamp(34-60px) · Sentient 600", "No wallet. No seed phrase."],
  ["H2", "clamp(26-40px) · Sentient 600", "It can’t get lost."],
  ["H3", "22px · Sentient 600", "Backed by Stellar."],
  ["Lead", "19px · Switzer 400", "Tap the link: the money is already yours."],
  ["Body", "16px · Switzer 400", "You send a link. They tap it and it’s theirs, no app, no seed phrase, no fees taken from what you sent."],
  ["Caption", "12.5px · Switzer 600 · 0.06em", "BACKED BY THE STELLAR COMMUNITY FUND"],
];

export default function BrandSystemPage() {
  return (
    <div className="bs">
      <style>{CSS}</style>

      {/* cover */}
      <header className="bs-cover">
        <p className="bs-kick"><span className="bs-seal-dot" />Backed by the Stellar Community Fund</p>
        <h1 className="bs-title">Lumenia Brand Kit</h1>
        <p className="bs-lead">
          Direction <strong>Periwinkle</strong>: Stellar’s lavender, warmed for consumers.
          Type <strong>Sentient + Switzer</strong>. Concept <strong>“Nothing to set up.”</strong>
        </p>
      </header>

      {/* HERO: the payoff */}
      <Section idx="01" title="Hero" hint="the concept, in one screen">
        <div className="bs-hero">
          <div className="bs-hero-copy">
            <p className="bs-eyebrow"><span className="bs-dot" />Money home, in a link</p>
            <h2 className="bs-hero-h">
              No <s>wallet</s>. No <s>seed&nbsp;phrase</s>. No <s>app</s>.{" "}
              <span className="bs-keep">Just a link.</span>
            </h2>
            <p className="bs-hero-sub">Tap the link: the money is already yours.</p>
            <div className="bs-row">
              <span className="bs-btn">See it work</span>
              <span className="bs-ghost">How it works →</span>
            </div>
          </div>
          <div className="bs-hero-art" aria-hidden="true">
            <div className="bs-glow" />
            <svg viewBox="0 0 220 176" className="bs-loop">
              <rect x="22" y="24" width="176" height="112" rx="26" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="6" />
              <path d="M60 136 v20 l26 -20 z" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="6" strokeLinejoin="round" />
              <path d="M84 82 l20 20 l40 -44" fill="none" stroke="var(--accent)" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="bs-art-note">Meshy object (message + check), placeholder, not a logo</span>
          </div>
        </div>
      </Section>

      {/* COLOUR */}
      <Section idx="02" title="Colour" hint="warm off-white + one periwinkle">
        <div className="bs-two">
          <div>
            <p className="bs-sub-h">Light: primary</p>
            <div className="bs-tokens">
              {LIGHT.map(([tok, hex, role]) => (
                <div key={tok} className="bs-token">
                  <span className="bs-chip" style={{ background: hex }} />
                  <div>
                    <b>{tok}</b>
                    <span className="bs-hex">{hex}</span>
                    <span className="bs-role">{role}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="bs-darkpanel">
            <p className="bs-sub-h" style={{ color: "#A59DB2" }}>Dark: system alternate</p>
            <div className="bs-tokens">
              {DARK.map(([tok, hex, role]) => (
                <div key={tok} className="bs-token bs-token-d">
                  <span className="bs-chip" style={{ background: hex, borderColor: "rgba(255,255,255,.14)" }} />
                  <div>
                    <b style={{ color: "#EDEAF3" }}>{tok}</b>
                    <span className="bs-hex" style={{ color: "#A59DB2" }}>{hex}</span>
                    <span className="bs-role" style={{ color: "#8A8298" }}>{role}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <p className="bs-note">
          Semantic (separate from the accent): success = the accent + a check (no green); warning
          <span className="bs-sw" style={{ background: "#D98A2B" }} /> danger
          <span className="bs-sw" style={{ background: "#C4362B" }} />. The Stellar name appears only on
          the how-it-works strip, which may switch to the on-brand dark pairing (yellow #FDDA24 on black).
        </p>
      </Section>

      {/* TYPE */}
      <Section idx="03" title="Typography" hint="Sentient display · Switzer body">
        <div className="bs-typerows">
          {TYPE_SCALE.map(([role, spec, sample]) => (
            <div key={role} className="bs-typerow">
              <div className="bs-typemeta"><b>{role}</b><span>{spec}</span></div>
              <p className={`bs-type-${role.toLowerCase()}`}>{sample}</p>
            </div>
          ))}
        </div>
        <p className="bs-note">
          Funder echo: Stellar’s own pairing is <em>Lora + Inter</em> (see the 4th specimen on
          <code> /brand-kit</code>): instant alignment, but Inter is the generic default we avoid. Not our pick.
        </p>
      </Section>

      {/* COMPONENTS */}
      <Section idx="04" title="Components" hint="buttons · states · surfaces">
        <div className="bs-comp">
          <div className="bs-comp-group">
            <p className="bs-sub-h">Buttons &amp; states</p>
            <div className="bs-row">
              <span className="bs-btn">Primary</span>
              <span className="bs-btn" style={{ background: "var(--accent-hover)" }}>Hover</span>
              <span className="bs-btn" style={{ background: "var(--accent-pressed)" }}>Pressed</span>
              <span className="bs-btn2">Secondary</span>
              <span className="bs-ghost">Ghost link →</span>
              <span className="bs-btn bs-dis">Disabled</span>
            </div>
          </div>
          <div className="bs-comp-group">
            <p className="bs-sub-h">Seal, input &amp; chips</p>
            <div className="bs-row">
              <span className="bs-badge"><span className="bs-badge-dot" />Backed by the Stellar Community Fund</span>
              <span className="bs-input"><span className="bs-input-pre">$</span>Enter an amount</span>
              <span className="bs-chip2">USDC</span>
            </div>
          </div>
          <div className="bs-comp-group">
            <p className="bs-sub-h">Cards</p>
            <div className="bs-cards">
              <div className="bs-card">
                <span className="bs-ic"><Check /></span>
                <h4>No wallet needed</h4>
                <p>The link is how you receive. Nothing to download, nothing to open.</p>
              </div>
              <div className="bs-stat">
                <b>$0.00</b><span>what you pay to receive</span>
              </div>
              <div className="bs-stat">
                <b>7 days</b><span>to claim, or it returns</span>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* MOTION / ASSETS pointer */}
      <Section idx="05" title="Motion, 3D & assets" hint="the rules live in brand.md">
        <ul className="bs-list">
          <li><b>Signature motion:</b> the hero “subtraction” (struck words dissolve → “Just a link.”), once, reduced-motion safe. Motion + GSAP + Lenis.</li>
          <li><b>3D:</b> one Meshy hero object: matte cream-to-periwinkle link-loop, no chrome/neon.</li>
          <li><b>Assets:</b> warm grain + periwinkle glow; human presence = treated real photography (periwinkle duotone), not raw AI faces. Lock one style ref, generate the set from it.</li>
          <li><b>Icons:</b> Phosphor. <b>Prompts</b> (Meshy / Ideogram / Flux / human): see <code>brand.md §11</code>.</li>
        </ul>
      </Section>

      <footer className="bs-foot">
        Lumenia Brand Kit · Periwinkle · Sentient + Switzer · full spec in <code>brand.md</code> ·
        explore alternates at <code>/brand-kit</code>.
      </footer>
    </div>
  );
}

function Section({ idx, title, hint, children }: { idx: string; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="bs-section">
      <div className="bs-shd">
        <span className="bs-idx">{idx}</span>
        <h3>{title}</h3>
        <span className="bs-hint">{hint}</span>
      </div>
      {children}
    </section>
  );
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

const CSS = `
.bs{
  --paper:#F5F3EF;--surface:#FBFAF8;--ink:#1E1B22;--muted:#67626E;--line:#E5DFE8;
  --accent:#6E5FCE;--accent-hover:#5F50C2;--accent-pressed:#4E40A8;--accent-soft:#E8E3F7;--on-accent:#F6F4FD;
  background:
    radial-gradient(60% 45% at 88% 6%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%),
    var(--paper);
  color:var(--ink);min-height:100dvh;
  font-family:"Switzer",ui-sans-serif,system-ui,-apple-system,sans-serif;line-height:1.55;
  padding:clamp(22px,4vw,64px);-webkit-font-smoothing:antialiased}
.bs :where(h1,h2,h3,h4,p,ul){margin:0}
.bs s{color:var(--muted);text-decoration-color:var(--accent);text-decoration-thickness:2px}

.bs-cover{max-width:1080px;margin:0 auto clamp(40px,6vw,80px)}
.bs-kick{display:inline-flex;align-items:center;gap:9px;font-size:12px;font-weight:600;letter-spacing:.02em;
  color:var(--ink);background:var(--accent-soft);padding:7px 14px;border-radius:999px;margin-bottom:22px}
.bs-seal-dot,.bs-badge-dot,.bs-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);display:inline-block}
.bs-title{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(42px,8vw,92px);letter-spacing:-.025em;line-height:1;margin-bottom:18px}
.bs-lead{font-size:clamp(16px,2vw,20px);color:var(--muted);max-width:60ch}
.bs-lead strong{color:var(--ink);font-weight:600}

.bs-section{max-width:1080px;margin:0 auto clamp(40px,6vw,72px)}
.bs-shd{display:flex;align-items:baseline;gap:14px;padding-bottom:14px;margin-bottom:26px;border-bottom:1px solid var(--line)}
.bs-idx{font-family:"Sentient",Georgia,serif;font-size:15px;color:var(--accent);font-weight:600}
.bs-shd h3{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(21px,3vw,28px);letter-spacing:-.01em}
.bs-hint{margin-left:auto;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.bs-sub-h{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
.bs-note{margin-top:22px;font-size:13.5px;color:var(--muted);line-height:1.6}
.bs-note code,.bs-foot code{background:var(--accent-soft);color:var(--accent-pressed);padding:1px 6px;border-radius:6px;font-size:12.5px}
.bs-sw{display:inline-block;width:13px;height:13px;border-radius:4px;vertical-align:-2px;margin:0 4px}

/* hero */
.bs-hero{display:grid;grid-template-columns:1.25fr .75fr;gap:36px;align-items:center;
  background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:clamp(28px,4vw,56px)}
@media (max-width:760px){.bs-hero{grid-template-columns:1fr}}
.bs-eyebrow{display:flex;align-items:center;gap:10px;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:18px}
.bs-hero-h{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(32px,4.6vw,58px);line-height:1.04;letter-spacing:-.022em;text-wrap:balance;margin-bottom:18px}
.bs-keep{color:var(--accent)}
.bs-hero-sub{font-size:clamp(16px,1.7vw,19px);color:var(--muted);margin-bottom:28px;max-width:36ch}
.bs-row{display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.bs-btn{background:var(--accent);color:var(--on-accent);font-weight:600;font-size:15px;padding:13px 24px;border-radius:12px}
.bs-btn2{background:transparent;color:var(--ink);font-weight:600;font-size:15px;padding:11.5px 22px;border-radius:12px;border:1.5px solid var(--line)}
.bs-ghost{color:var(--ink);font-weight:600;font-size:15px;border-bottom:2px solid var(--accent);padding-bottom:2px}
.bs-dis{background:color-mix(in srgb,var(--ink) 10%,var(--paper));color:color-mix(in srgb,var(--ink) 34%,var(--paper))}
.bs-hero-art{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:220px}
.bs-glow{position:absolute;inset:0;background:radial-gradient(50% 50% at 50% 45%, color-mix(in srgb,var(--accent) 30%,transparent), transparent 70%);filter:blur(6px)}
.bs-loop{position:relative;width:min(230px,70%);height:auto}
.bs-art-note{position:relative;margin-top:14px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}

/* colour */
.bs-two{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media (max-width:760px){.bs-two{grid-template-columns:1fr}}
.bs-darkpanel{background:#15121C;border:1px solid #2C2536;border-radius:18px;padding:22px}
.bs-tokens{display:flex;flex-direction:column;gap:10px}
.bs-token{display:flex;align-items:center;gap:14px}
.bs-chip{width:44px;height:44px;border-radius:11px;border:1px solid var(--line);flex:none}
.bs-token b{font-size:13px;font-variant-numeric:tabular-nums;display:block}
.bs-hex{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;margin-right:10px}
.bs-role{font-size:12px;color:var(--muted)}

/* type */
.bs-typerows{display:flex;flex-direction:column;gap:20px}
.bs-typerow{display:grid;grid-template-columns:180px 1fr;gap:24px;align-items:baseline;padding-bottom:18px;border-bottom:1px solid var(--line)}
@media (max-width:640px){.bs-typerow{grid-template-columns:1fr;gap:6px}}
.bs-typemeta b{font-size:14px;display:block}
.bs-typemeta span{font-size:12px;color:var(--muted)}
.bs-type-display{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(34px,5vw,60px);letter-spacing:-.022em;line-height:1.02}
.bs-type-h1{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(28px,3.6vw,44px);letter-spacing:-.02em;line-height:1.05}
.bs-type-h2{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(23px,2.6vw,32px);letter-spacing:-.01em}
.bs-type-h3{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:22px}
.bs-type-lead{font-size:19px;color:var(--ink)}
.bs-type-body{font-size:16px;color:var(--ink);opacity:.86;max-width:60ch}
.bs-type-caption{font-size:12.5px;font-weight:600;letter-spacing:.06em;color:var(--muted)}

/* components */
.bs-comp{display:flex;flex-direction:column;gap:30px}
.bs-comp-group .bs-row{gap:14px}
.bs-badge{display:inline-flex;align-items:center;gap:9px;background:var(--accent-soft);color:var(--ink);font-size:13px;font-weight:600;padding:8px 15px;border-radius:999px}
.bs-input{display:inline-flex;align-items:center;gap:9px;background:var(--surface);border:1.5px solid var(--line);border-radius:12px;padding:12px 16px;color:var(--muted);font-size:15px}
.bs-input-pre{color:var(--ink);font-weight:700}
.bs-chip2{background:var(--accent-soft);color:var(--accent-pressed);font-weight:600;font-size:13px;padding:7px 13px;border-radius:9px}
.bs-cards{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:14px}
@media (max-width:760px){.bs-cards{grid-template-columns:1fr}}
.bs-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px}
.bs-ic{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:var(--accent-soft);color:var(--accent);margin-bottom:14px}
.bs-card h4{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:18px;margin-bottom:6px}
.bs-card p{font-size:13.5px;color:var(--muted);line-height:1.5}
.bs-stat{background:color-mix(in srgb,var(--accent) 9%,var(--paper));border:1px solid var(--line);border-radius:16px;padding:22px;display:flex;flex-direction:column;gap:6px;justify-content:center}
.bs-stat b{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(26px,3vw,34px);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.bs-stat span{font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}

.bs-list{list-style:none;display:flex;flex-direction:column;gap:12px}
.bs-list li{font-size:14.5px;color:var(--muted);padding-left:18px;position:relative}
.bs-list li::before{content:"";position:absolute;left:0;top:9px;width:7px;height:7px;border-radius:50%;background:var(--accent)}
.bs-list b{color:var(--ink);font-weight:600}
.bs-list code{background:var(--accent-soft);color:var(--accent-pressed);padding:1px 6px;border-radius:6px;font-size:12.5px}

.bs-foot{max-width:1080px;margin:0 auto;padding-top:22px;border-top:1px solid var(--line);color:var(--muted);font-size:13.5px}
`;
