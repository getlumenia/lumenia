/**
 * /brand-kit/concepts: ISOLATED direction board for the hero 3D object. Nothing here
 * touches the live landing or the frozen claim route. Direction chosen: the COMPANION
 * MASCOT (avatar). These are three refined, more professional Meshy renders of it, 
 * pick one, then it goes to image→3D and into the hero.
 */
import Image from "next/image";

export const metadata = { title: "Brand Kit: Mascot directions" };

type Concept = {
  id: string;
  src: string;
  tag: string;
  title: string;
  blurb: string;
  pros: string[];
  cons: string[];
};

const CONCEPTS: Concept[] = [
  {
    id: "★",
    src: "/brand-kit-concepts/mascot-v2.png",
    tag: "Our avatar · the messenger",
    title: "The messenger",
    blurb: "The locked Lumenia avatar, a friendly character holding a lavender envelope (money home, in a link). Built to 3D and living on the hero + brand book.",
    pros: ["Clearest story: holding the envelope", "Big expressive eyes, open warm smile", "Simplest, most brandable silhouette"],
    cons: ["Variations (poses / actions) generated separately in the Asset kit", "The little-courier and bear directions are retired"],
  },
];

export default function ConceptsPage() {
  return (
    <div className="cp">
      <style>{CSS}</style>
      <header className="cp-head">
        <span className="cp-mark">Lumenia</span>
        <div>
          <h1 className="cp-title">Our avatar: the messenger</h1>
          <p className="cp-sub">
            Locked. The little-courier and bear directions are retired; the messenger is the Lumenia
            avatar, built to 3D. Different variations (poses, actions) are generated as their own
            models in the Asset kit and animated there.
          </p>
        </div>
      </header>

      <div className="cp-grid">
        {CONCEPTS.map((c) => (
          <article key={c.id} className="cp-card">
            <div className="cp-imgwrap">
              <Image src={c.src} alt={c.title} width={1024} height={1024} className="cp-img" />
              <span className="cp-badge">{c.id}</span>
            </div>
            <p className="cp-tag">{c.tag}</p>
            <h2 className="cp-h">{c.title}</h2>
            <p className="cp-blurb">{c.blurb}</p>
            <ul className="cp-pros">
              {c.pros.map((p) => (
                <li key={p} className="cp-pro">{p}</li>
              ))}
            </ul>
            <ul className="cp-cons">
              {c.cons.map((p) => (
                <li key={p} className="cp-con">{p}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </div>
  );
}

const CSS = `
.cp{--paper:#F5F3EF;--surface:#FBFAF8;--ink:#1E1B22;--muted:#67626E;--line:#E5DFE8;
  --accent:#6E5FCE;--accent-soft:#E8E3F7;--ok:#4E40A8;--no:#C4362B;
  min-height:100dvh;background:var(--paper);color:var(--ink);
  font-family:"Switzer",ui-sans-serif,system-ui,sans-serif;padding:clamp(20px,4vw,48px)}
.cp :where(h1,h2,p,ul){margin:0}
.cp-head{display:flex;gap:20px;align-items:baseline;max-width:1200px;margin:0 auto 34px;flex-wrap:wrap}
.cp-mark{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:22px;letter-spacing:-.02em}
.cp-title{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:clamp(24px,3.4vw,38px);letter-spacing:-.02em}
.cp-sub{margin-top:8px;color:var(--muted);font-size:15px;max-width:70ch;line-height:1.55}
.cp-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;max-width:1200px;margin:0 auto}
@media (max-width:900px){.cp-grid{grid-template-columns:1fr}}
.cp-card{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:16px;display:flex;flex-direction:column}
.cp-imgwrap{position:relative;border-radius:14px;overflow:hidden;
  background:radial-gradient(60% 55% at 50% 42%, color-mix(in srgb,var(--accent) 12%,transparent), transparent 72%), var(--paper);
  aspect-ratio:1}
.cp-img{width:100%;height:100%;object-fit:cover}
.cp-badge{position:absolute;top:12px;left:12px;background:var(--ink);color:#fff;font-weight:700;font-size:12px;
  padding:4px 10px;border-radius:8px;letter-spacing:.04em}
.cp-tag{margin-top:14px;font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.cp-h{font-family:"Sentient",Georgia,serif;font-weight:600;font-size:22px;margin-top:4px}
.cp-blurb{margin-top:6px;color:var(--muted);font-size:14px;line-height:1.5}
.cp-pros,.cp-cons{list-style:none;margin-top:12px;display:flex;flex-direction:column;gap:6px}
.cp-pro,.cp-con{font-size:13.5px;padding-left:22px;position:relative;line-height:1.4}
.cp-pro{color:var(--ink)}
.cp-con{color:var(--muted)}
.cp-pro::before{content:"＋";position:absolute;left:0;top:0;color:var(--ok);font-weight:700}
.cp-con::before{content:"－";position:absolute;left:2px;top:0;color:var(--no);font-weight:700}
`;
