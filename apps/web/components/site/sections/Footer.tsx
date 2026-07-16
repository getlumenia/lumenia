/**
 * Footer — the Periwinkle footer closing every page in the (site) group, over the living bg-footer
 * glow. The brand-kit messenger (avatar-heart, bg-removed + watermark cleaned) stands on a soft
 * ground-glow as a warm sign-off. Per the owner logo rule, no text "Lumenia" — the link mark stands
 * in for it. The SCF seal is a shadcn <Badge>.
 */
import "./footer.css";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { AvatarReveal } from "./AvatarReveal";
import { AmbientVideo } from "../AmbientVideo";

const COLS = [
  { title: "Product", links: [["How it works", "/how-it-works"], ["Live demo", "/demo"], ["Tools", "/tools"], ["Waitlist", "/waitlist"], ["Cash-out", "/cash-out"]] },
  { title: "Company", links: [["About", "/about"], ["Roadmap", "/roadmap"], ["Developers", "/developers"], ["Brand", "/brand"]] },
  { title: "Legal", links: [["Privacy", "/privacy"], ["Terms", "/terms"]] },
];

export function Footer() {
  return (
    <footer className="foot">
      {/* Living footer glow — theme-aware: bg-footer (dark navy smoke) in dark, bg-soft (light lavender
          drift) in light. Only the theme's video is shown (CSS); reduced-motion drops both. */}
      <AmbientVideo className="foot-bg" poster="/brand-kit-assets/bg-footer.webp"
        sources={["/brand-kit-assets/video/bg-footer.webm", "/brand-kit-assets/video/bg-footer.mp4"]} />
      <AmbientVideo className="foot-bg-light" poster="/brand-kit-assets/bg-soft.webp"
        sources={["/brand-kit-assets/video/bg-soft.webm", "/brand-kit-assets/video/bg-soft.mp4"]} />
      <div className="foot-scrim" aria-hidden="true" />

      <div className="foot-inner">
        <div className="foot-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="foot-mark" src="/brand-kit-assets/mark-link.webp" loading="lazy" decoding="async" alt="Lumenia" />
          <p className="foot-tag">Money home, without the ordeal.</p>
          <AvatarReveal
            src="/brand-kit-assets/avatar-heart-cut.webp"
            variant="rise"
            wrapClassName="foot-mascot-wrap"
            glowClassName="foot-mascot-glow"
            className="foot-mascot"
          />
        </div>

        <nav className="foot-nav">
          {COLS.map((c) => (
            <div className="foot-col" key={c.title}>
              <span className="foot-ct">{c.title}</span>
              {c.links.map(([label, href]) => (
                <Link key={href} href={href}>{label}</Link>
              ))}
            </div>
          ))}
        </nav>
      </div>

      <div className="foot-bottom">
        <span>Your money is never ours. That&rsquo;s the point.</span>
        <Badge variant="secondary" className="foot-seal">
          <span className="foot-seal-star" aria-hidden="true" />
          Backed by the Stellar Community Fund
        </Badge>
      </div>
    </footer>
  );
}
