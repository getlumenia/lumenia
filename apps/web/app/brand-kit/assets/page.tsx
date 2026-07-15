/**
 * /brand-kit/assets — the Lumenia Asset kit. Everything generated with Meshy (non-print
 * features) in the Periwinkle system: logos, the icon set, section backgrounds,
 * illustrations, and the avatar (3D variations + animation land here as they finish).
 * ISOLATED workspace route — never touches the live landing or the frozen claim route.
 */
import type { Metadata } from "next";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Lumenia — Asset kit",
  robots: { index: false, follow: false },
};

type Item = { src: string; label: string; note?: string; pick?: boolean; ratio: string };

const LOGOS: Item[] = [
  { src: "/brand-kit-assets/logo-wordmark.svg", label: "Wordmark — vector", note: "clean SVG · prominent lumen glow on the i — the primary logo", pick: true, ratio: "3.2 / 1" },
  { src: "/brand-kit-assets/logo-mark-link-peri.png", label: "Mark — link", note: "two joined, all-periwinkle — the symbol / no-text mark", pick: true, ratio: "1 / 1" },
  { src: "/brand-kit-assets/logo-lockup-peri.png", label: "Lockup", note: "spark mark + wordmark, all-periwinkle", ratio: "3 / 2" },
  { src: "/brand-kit-assets/logo-lumen-spark.png", label: "Mark — lumen", note: "a lumen / light form, periwinkle", ratio: "1 / 1" },
];

const ICONS: Item[] = [
  { src: "/brand-kit-assets/icons-core.png", label: "Core — money actions", note: "send · receive · request · link · envelope · check · phone · face-id · key · banknote · 7-day · shield", ratio: "1 / 1" },
  { src: "/brand-kit-assets/icons-app.png", label: "App & future", note: "home · profile · activity · notify · settings · security · bank · gift · chat · split · contacts · QR", ratio: "1 / 1" },
  { src: "/brand-kit-assets/icons-trust.png", label: "Trust & status", note: "verified · lock · receipt · swap · globe · pending · refund · star · privacy · hourglass · badge · link", ratio: "1 / 1" },
  { src: "/brand-kit-assets/icons-onboard.png", label: "Onboarding & methods", note: "card · bank · wallet-free · share · QR · invite · verify · language · help · theme · exchange · receipt", ratio: "1 / 1" },
];

const BACKGROUNDS: Item[] = [
  { src: "/brand-kit-assets/bg-hero.webp", label: "Hero", note: "warm paper + periwinkle glow, space to rest an object", ratio: "16 / 9" },
  { src: "/brand-kit-assets/bg-howitworks.png", label: "How-it-works", note: "dark aurora — the Stellar/proof strip", ratio: "16 / 9" },
  { src: "/brand-kit-assets/bg-soft.webp", label: "Soft field", note: "periwinkle gradient — section dividers", ratio: "16 / 9" },
  { src: "/brand-kit-assets/bg-cta.webp", label: "CTA band", note: "bright periwinkle glow — call-to-action", ratio: "16 / 9" },
  { src: "/brand-kit-assets/bg-footer.webp", label: "Footer", note: "dark low-glow — footer / close", ratio: "16 / 9" },
];

const ILLUSTRATIONS: Item[] = [
  { src: "/brand-kit-assets/il-hands.webp", label: "Passing light", note: "hands passing a glowing light — the transfer", ratio: "4 / 3" },
  { src: "/brand-kit-assets/il-phone.webp", label: "Tap the link", note: "hand tapping a phone, periwinkle bloom", ratio: "4 / 3" },
  { src: "/brand-kit-assets/il-abstract.webp", label: "Connection", note: "abstract ribbons connecting two points", ratio: "4 / 3" },
  { src: "/brand-kit-assets/il-home.png", label: "Home", note: "cozy home, golden hour — arrival", ratio: "4 / 3" },
  { src: "/brand-kit-assets/il-celebrate.webp", label: "Celebrate", note: "soft confetti — success / received", ratio: "4 / 3" },
  { src: "/brand-kit-assets/il-trust.webp", label: "Safe", note: "a shield of light — trust", ratio: "4 / 3" },
  { src: "/brand-kit-assets/il-request.png", label: "Request", note: "an open hand — ask to be paid", ratio: "4 / 3" },
  { src: "/brand-kit-assets/il-onboard.png", label: "Welcome", note: "a doorway of light — onboarding", ratio: "4 / 3" },
];

function Grid({ items, cols }: { items: Item[]; cols: number }) {
  return (
    <div className="ak-grid" style={{ ["--cols" as string]: cols }}>
      {items.map((it) => (
        <figure key={it.src} className={it.pick ? "ak-card ak-pick" : "ak-card"}>
          <div className="ak-imgwrap" style={{ aspectRatio: it.ratio }}>
            {it.src.endsWith(".svg") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={it.src} alt={it.label} className="ak-img ak-img-contain" />
            ) : (
              <Image src={it.src} alt={it.label} fill sizes="(max-width:900px) 100vw, 33vw" className="ak-img" />
            )}
            {it.pick && <span className="ak-badge">Pick</span>}
          </div>
          <figcaption>
            <b>{it.label}</b>
            {it.note && <span>{it.note}</span>}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export default function AssetKit() {
  return (
    <div className="ak">
      <style>{CSS}</style>
      <header className="ak-head">
        <span className="ak-mark">Lumenia</span>
        <div>
          <h1 className="ak-title">Asset kit</h1>
          <p className="ak-sub">
            Generated with Meshy (non-print) in the Periwinkle system — logos, a full icon set,
            section backgrounds, illustrations, and the avatar. Curation notes inline; 3D avatar
            variations + animation land in the last section as they finish.
          </p>
        </div>
      </header>

      <Section n="01" title="Logos" hint="all-periwinkle · 2 picked — wordmark (vector) + link mark">
        <Grid items={LOGOS} cols={4} />
      </Section>

      <Section n="02" title="Icon set" hint="cohesive soft-3D family · 48 icons">
        <Grid items={ICONS} cols={4} />
      </Section>

      <Section n="03" title="Backgrounds" hint="section grounds">
        <Grid items={BACKGROUNDS} cols={3} />
      </Section>

      <Section n="04" title="Illustrations" hint="brand directions — animate later if needed">
        <Grid items={ILLUSTRATIONS} cols={3} />
      </Section>

      <Section n="05" title="Avatar — the messenger" hint="5 live 3D avatars + 2 more poses">
        <div className="ak-avatar">
          <Image src="/brand-kit-concepts/mascot-v2.png" alt="The messenger" width={600} height={600} className="ak-avatar-img" />
          <div>
            <p className="ak-avatar-p">
              Our locked avatar. <b>Done:</b> 6 pose variations (wave · tap · celebrate · thumbs-up ·
              point · heart) built to 3D and all <b>7 avatars animated</b> with procedural idle motion
              — live at <b>/brand-kit/avatars</b>. (Meshy skeletal rig can’t rig this non-humanoid
              blob — procedural idle fits a website mascot better.)
            </p>
            <p className="ak-note">Live · the little-courier & bear directions are retired.</p>
          </div>
        </div>
      </Section>

      <footer className="ak-foot">Lumenia Asset kit · Periwinkle · generated with Meshy · see also the Brand book.</footer>
    </div>
  );
}

function Section({ n, title, hint, children }: { n: string; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="ak-section">
      <div className="ak-shd">
        <span className="ak-idx">{n}</span>
        <h2>{title}</h2>
        <span className="ak-hint">{hint}</span>
      </div>
      {children}
    </section>
  );
}

const CSS = `
.ak{--paper:#F5F3EF;--surface:#FBFAF8;--ink:#1E1B22;--muted:#67626E;--line:#E5DFE8;
  --accent:#6E5FCE;--accent-soft:#E8E3F7;
  min-height:100dvh;background:var(--paper);color:var(--ink);
  font-family:"Switzer",ui-sans-serif,system-ui,sans-serif;padding:clamp(20px,4vw,52px)}
.ak :where(h1,h2,p){margin:0}
.ak-head{display:flex;gap:20px;align-items:baseline;max-width:1200px;margin:0 auto 40px;flex-wrap:wrap}
.ak-mark{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:22px;letter-spacing:-.02em}
.ak-title{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(28px,4vw,44px);letter-spacing:-.02em}
.ak-sub{margin-top:8px;color:var(--muted);font-size:15px;max-width:72ch;line-height:1.55}

.ak-section{max-width:1200px;margin:0 auto clamp(34px,5vw,60px)}
.ak-shd{display:flex;align-items:baseline;gap:14px;padding-bottom:12px;margin-bottom:22px;border-bottom:1px solid var(--line)}
.ak-idx{font-family:"Sentient",Georgia,serif;font-weight:600;color:var(--accent);font-size:15px}
.ak-shd h2{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(20px,2.6vw,28px);letter-spacing:-.01em}
.ak-hint{margin-left:auto;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}

.ak-grid{display:grid;grid-template-columns:repeat(var(--cols),1fr);gap:16px}
@media (max-width:900px){.ak-grid{grid-template-columns:1fr 1fr}}
@media (max-width:600px){.ak-grid{grid-template-columns:1fr}}
.ak-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;overflow:hidden;display:flex;flex-direction:column}
.ak-pick{border-color:color-mix(in srgb,var(--accent) 45%,var(--line));box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 30%,transparent)}
.ak-imgwrap{position:relative;width:100%;background:
  radial-gradient(60% 55% at 50% 42%, color-mix(in srgb,var(--accent) 10%,transparent), transparent 72%), var(--paper)}
.ak-img{object-fit:cover}
.ak-img-contain{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:9%;box-sizing:border-box}
.ak-badge{position:absolute;top:10px;left:10px;background:var(--accent);color:#F6F4FD;font-weight:700;font-size:11px;padding:3px 9px;border-radius:7px;letter-spacing:.04em}
.ak-card figcaption{padding:12px 14px;display:flex;flex-direction:column;gap:3px}
.ak-card figcaption b{font-size:14px}
.ak-card figcaption span{font-size:12px;color:var(--muted);line-height:1.45}

.ak-avatar{display:grid;grid-template-columns:280px 1fr;gap:28px;align-items:center;
  background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:22px}
@media (max-width:700px){.ak-avatar{grid-template-columns:1fr}}
.ak-avatar-img{width:100%;height:auto;border-radius:12px}
.ak-avatar-p{font-size:15px;color:var(--ink);line-height:1.6}
.ak-avatar-p b{font-weight:600}
.ak-note{margin-top:10px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}

.ak-foot{max-width:1200px;margin:0 auto;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
`;
