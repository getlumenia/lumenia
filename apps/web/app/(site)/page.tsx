/**
 * Landing (/) — the LOCKED Periwinkle landing, composed from per-section components under
 * components/site/sections/. This file is intentionally thin: it only wires the section order and
 * the overlay-reveal structure. The opening IS the Apple-style scroll-scrub hero — a sticky mascot
 * Greeting the ScrubHero scrolls up over. Sticky greeting z0; everything after rides in .op-over z1
 * (overlay-reveal, our locked transition). Shared styles live in ./sections/landing.css.
 *
 * Section order (top→bottom, brand.md §12 narrative):
 *   1 Greeting + ScrubHero + HeroResolution — the hero (subtraction → "Money home, in a link.")
 *   2 Fears        — the four fears, named then struck through
 *   3 Moment       — the real human beat (treated photograph)
 *   4 HowItWorks   — pinned 3-step scroll story
 *   5 Proof        — the one Stellar-dark strip + real on-chain receipt
 *   6 Trust        — "Where is my money, exactly?" essay + FAQ
 *   7 CloseCTA + Footer — dual CTA over the living video + the dark footer
 */
import SmoothScroll from "../../components/brand/SmoothScroll";
import "../../components/site/sections/landing.css";
import { BootOpening } from "../../components/site/sections/BootOpening";
import { Greeting } from "../../components/site/sections/Greeting";
import { ScrubHero } from "../../components/site/sections/ScrubHero";
import { HeroResolution } from "../../components/site/sections/HeroResolution";
import { Fears } from "../../components/site/sections/Fears";
import { Moment } from "../../components/site/sections/Moment";
import { HowItWorks } from "../../components/site/sections/HowItWorks";
import { Proof } from "../../components/site/sections/Proof";
import { Trust } from "../../components/site/sections/Trust";
import { CloseCTA } from "../../components/site/sections/CloseCTA";
import { Footer } from "../../components/site/sections/Footer";

export default function Landing() {
  return (
    <SmoothScroll>
      {/* `site-theme` maps shadcn semantic tokens to Periwinkle so shadcn primitives placed inside the
          landing render on-brand; the landing's own styles use the collision-free `--pw-*` namespace. */}
      {/* data-boot ships in the SSR markup, not from an effect: it holds the greeting's entrance at
          its first frame from the very first paint. Set after hydration it would land too late —
          opreveal/opbubble would already have played under the field and freeze half-open. */}
      <div className="op site-theme" data-boot="hold">
        {/* First frame: a flat field of the wordmark's "i" colour that contracts into the "i"
            itself, then releases the greeting's own entrance. Inside .op so it inherits
            --pw-accent (the letters' fill) and flips with the theme. */}
        <BootOpening />
        {/* Without JS nothing clears the hold, so the greeting would sit invisible behind a field
            that only a CSS failsafe removes. Hand no-JS readers the settled page instead. */}
        <noscript>
          <style>{`.op[data-boot]{--boot-noscript:1}.op[data-boot] .op-brandlogo,.op[data-boot] .op-greet-stage,.op[data-boot] .op-bubble{animation-play-state:running}.op-boot,.op-boot-spark{display:none}`}</style>
        </noscript>
        <Greeting />
        {/* Section transitions = the brand-kit sticky-overlap (each section is position:sticky;top:0
            with a rising z-index, so the NEXT section slides up over the pinned previous one). The
            tall scroll-regions (scrub reel, pinned how-it-works, the FAQ-heavy Trust) can't pin
            without hiding content, so they stay relative and their neighbours overlay them instead.
            Sticky/z-index is driven from landing.css by section class. */}
        <div className="op-over">
          <ScrubHero />
          <HeroResolution />
          <Fears />
          <Moment />
          <HowItWorks />
          <Proof />
          <Trust />
          <CloseCTA />
          <Footer />
        </div>
      </div>
    </SmoothScroll>
  );
}
