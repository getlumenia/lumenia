# BRAND.md — Lumenia Brand Kit

> The finalized brand system. **Direction LOCKED: “Periwinkle” (10)** — Stellar's
> lavender warmed into a consumer periwinkle. Type LOCKED: **Sentient + Switzer**.
> Build scope: the **whole site is Periwinkle** now — the landing plus every `(site)` and `(app)`
> surface. Two things stay distinct: the `(app)` money group (Periwinkle via a scoped token
> override) and the v1 claim route `/c/[id]` (the route the SOW 1 claim used; no longer frozen since D2, but kept lean; it
> was recolored to Periwinkle via a `.claim-pw` scope and is never restructured from here).
> Live workspace: `/brand-kit` (13 explored directions) · `/brand-kit/system` (this kit rendered).
> Repo language policy: this doc is English.

---

## 1. One line & concept
Send money by link. The person receiving it needs **no wallet, no seed phrase, no app** —
they tap the link and it's theirs.

**Concept spine — “Nothing to set up.”** The brand's identity is the *absence* of everything
scary. No wallet. No seed phrase. No app. No gas. We are defined by what we **remove**.
Signature idea: the scary crypto steps are struck through and dissolve, until only one thing
remains — **tap the link.**

- **Trust device:** a real, tappable on-chain **public receipt** — never jargon.
- **Emotional payoff:** human relief — the moment *after* the wall is gone.

## 2. Who we talk to
Not “a family,” not “the mother.” **Everyone afraid of crypto who never made it through
onboarding** — the person who believes receiving money on-chain is technical, risky, or
impossible on their phone. The landing kills four fears, in order:
1. “I don't have a wallet — how would I even receive it?”
2. “What if I lose the 12 words?”
3. “I tap a link on mobile and money appears? That's impossible.”
4. “What if it gets lost — is it safe?”

## 3. Positioning
- **Against crypto:** never look or sound like crypto. No tickers, charts, partner-logo walls,
  “the blockchain for X” headline, no dark neon.
- **Against banks:** warmer, clearer, free to receive, instant.
- **Stellar (the funder):** sold **quietly, never in the hero.** Two placements only —
  (a) a small **“Backed by the Stellar Community Fund”** trust seal, and (b) one **how-it-works /
  proof** strip where the chain is named with pride (this strip may use the Stellar-dark palette,
  §4.4). Outcome leads; Stellar is the credibility footnote.

## 4. Colour — “Periwinkle” (LOCKED)

Stellar's lavender (`#B7ACE8`) warmed into a consumer periwinkle: a nod to the funder that reads
soft, friendly and distinctly **not** crypto. Warm off-white ground, one periwinkle accent.
**Light is default; dark is a system-aware alternate** (its accent becomes Stellar's actual
lavender, tying back to the funder).

### 4.1 Light (primary)
| Token | Hex | Role |
|---|---|---|
| `--paper` | `#F5F3EF` | page ground (warm off-white, faint mauve) |
| `--surface` | `#FBFAF8` | raised cards |
| `--ink` | `#1E1B22` | primary text |
| `--muted` | `#67626E` | secondary text |
| `--line` | `#E5DFE8` | hairlines, borders |
| `--accent` | `#6E5FCE` | periwinkle — actions, links, highlights |
| `--accent-hover` | `#5F50C2` | button hover |
| `--accent-pressed` | `#4E40A8` | button active |
| `--accent-soft` | `#E8E3F7` | chips, tints, icon backings |
| `--on-accent` | `#F6F4FD` | text/icon on the accent |
| `--ring` | `#6E5FCE` @ 45% | focus ring |

### 4.2 Dark (system alternate)
| Token | Hex | Role |
|---|---|---|
| `--paper` | `#15121C` | ground |
| `--surface` | `#1D1926` | raised cards |
| `--ink` | `#EDEAF3` | primary text |
| `--muted` | `#A59DB2` | secondary text |
| `--line` | `#2C2536` | hairlines |
| `--accent` | `#B7ACE8` | **Stellar lavender** — pops on dark, funder tie-back |
| `--accent-hover` | `#C7BEF0` | hover |
| `--accent-pressed` | `#A99CE0` | active |
| `--accent-soft` | `#2A2338` | chips/tints |
| `--on-accent` | `#1A1622` | text on the accent |

### 4.3 Semantic (both themes, SEPARATE from the accent)
- **success / “received”:** the periwinkle accent + a checkmark (we do **not** use green — the
  standing no-brand-green rule holds; the accent carries the positive moment).
- **warning:** `#D98A2B` (amber) · **danger:** `#C4362B` (red). Functional only, never decorative.

### 4.4 Stellar strip (for the how-it-works / proof section only)
When the page names Stellar, that one strip may switch to the on-brand dark pairing:
ground `#0F0F0F` (or Stellar navy `#002E5D`), text `#F6F7F8`, accent Stellar yellow `#FDDA24`,
second accent lavender `#B7ACE8`. This is where the funder shows through — nowhere else.

### 4.5 Rules
Accent marks **action + arrival** moments only. No green as a brand/accent colour. No crypto
blue/purple gradient, no neon. Derived surfaces come from `color-mix` off these base tokens so
the system stays lean (see `/brand-kit/system`).

### 4.6 Contrast
`--on-accent` on `--accent` ≈ 4.9:1 (AA). `--accent` as text on `--paper` ≈ 4.3:1 — **use bold**
for accent text (eyebrows, links). Body `--ink` on `--paper` ≈ 13:1. All buttons/labels pass AA.

## 5. Typography (LOCKED)
A warm modern serif display + a clean humanist sans body — the fastest non-crypto, human-trust signal.
- **Display — Sentient** (Fontshare). Weights 500/600. Hero `clamp(40px, 6vw, 88px)`, tracking `-0.02em`,
  leading 1.03–1.08, `text-wrap: balance`.
- **Body/UI — Switzer** (Fontshare). Weights 400/500/600. Lead 18–20px, body 16px, caption 12.5px
  uppercase `0.06em`. `font-variant-numeric: tabular-nums` on all figures.
- **Scale:** display / h1 `clamp(34,4.6vw,60)` / h2 `clamp(26,3vw,40)` / h3 22 / lead 19 / body 16 / small 14 / caption 12.5.
- **Radii:** 10–16px, never pill-sized.
- **Funder echo (optional):** Stellar's own pairing is **Lora + Inter**. Available on `/brand-kit`
  as a 4th specimen — instant Stellar alignment, but Inter is the generic default we avoid. Not our pick.
- Fonts load across the product (the `(site)` and `(app)` groups); the v1 claim route stays webfont-free.

## 6. Logo / wordmark
- **Wordmark:** “Lumenia” set in **Sentient** (600). Lowercase-friendly, warm.
- **Mark:** the wordmark **is** the primary identity. Any symbol must be **hand-drawn vector, never
  AI-generated** — image models reproduce existing crypto logos (a periwinkle geometric mark returns
  **Polygon**). Avoid abstract loops / chain-links / hexagons. If a glyph is needed, design a
  distinctive, warm, original one by hand.
- **Trust seal:** “Backed by the Stellar Community Fund” — small pill, `--accent-soft` bg, used in
  footer + the proof strip. This is the only place the Stellar name appears above the fold-of-trust.

## 7. Voice & tone
Calm, plain, confident, warm. We **remove fear**, we don't hype.
- **Do:** short declarative sentences; name the fear, then kill it (“No seed phrase. Nothing to
  memorize.”); speak to one person.
- **Don't:** crypto jargon, exclamation hype, hedging, feature-listing, “revolutionary / seamless /
  trustless,” emoji bullets.
- Honesty rules (project-wide): say “the recipient pays no gas,” not “gasless”; “target ~30s,” not
  “is 30s”; never “yield / savings / interest / bank.”

## 8. The “never do” list (anti-AI / anti-generic filter)
Every screen passes this: ❌ no testnet badge / beta stripe on the landing · ❌ no mono label rails,
ghost numerals, or “01/02/03” dev rails on consumer sections · ❌ no three identical feature cards in
a symmetric grid, no bento overuse · ❌ no crypto purple/blue gradient, dark-neon, glassmorphism stacks
· ❌ no chrome/glass/neon 3D, no coin/token clichés · ❌ no raw AI faces (uncanny) · ❌ no default-framework
font look (Inter/Geist/Space Grotesk as-is) · ❌ no mock data — every number/proof is real.

## 9. Motion
- **Stack:** **Motion** (`motion/react`, installed) for reveals/layout · **GSAP + ScrollTrigger**
  for the signature type reveal + scroll narrative (add when we build) · **Lenis** for smooth scroll.
- **Signature moment:** the hero “subtraction” — “No ~~wallet~~. No ~~seed phrase~~. No ~~app~~.”
  the struck words dissolve on load, leaving **“Just a link.”** Do it once; don't scatter effects.
- Always honour `prefers-reduced-motion` (render the settled final state).

## 10. 3D, assets & icons
- **One hero object** in **Meshy** (GLB) — matte, ceramic/paper-like, warm periwinkle; **no
  chrome/glass/neon.**
- **2D atmosphere:** warm grain + a soft periwinkle glow. **Human presence: treated real photography**
  (periwinkle-tinted duotone/grain/crop), not raw AI faces.
- **Asset discipline:** lock **one** style reference first, generate the whole set from it.
- **Icons:** **Phosphor** (warmer than Lucide), 1.5–2px stroke, accent used sparingly.

## 11. Production prompts (copy-paste)

> **Originality rule (learned the hard way):** never prompt an *abstract symbol/mark in the brand
> colour* — a periwinkle geometric shape or “link loop” returns **Polygon / crypto logos**. Prompt
> **scenes and specific material objects**; describe texture, light and imperfection; and always append
> this exclusion block: `no logo, no icon, no emblem, no abstract geometry, no hexagon, no polygon,
> no crypto/blockchain, no coins, no chain-links, no tokens`. AI is for scenes/objects/textures — the
> logo is hand-drawn.

### 11.1 Meshy — hero 3D object (an original, tangible thing — NOT a mark)
```
A single soft, rounded message bubble — a friendly pillow-inflated form in matte ceramic, warm cream
with a faint lavender tint, thick smooth rounded edges and one small tail at the lower-left, a subtly
debossed checkmark on its face. Hand-sized, tactile, minimal, in soft studio light.
No chain links, no interlocking rings, no coins, no tokens, no hexagon, no polygon, no logo, no icon,
no chrome, no glass, no neon, no text.
```
Meshy settings: Art Style = **Stylized**, PBR maps ON, Symmetry ON → export **GLB**, low/target poly
for web + Draco. Load via `react-three-fiber + drei` (lazy) OR export a frame sequence for scroll-scrub.

### 11.2 Hero photograph — the “tap” moment (Leonardo / Flux; recommended hero visual)
```
Candid documentary photograph, close on two hands: a thumb gently tapping a smartphone screen held in
the other hand, at a sunlit kitchen table at home. Soft morning light through a window, a faint warm-
lavender glow reflecting off the screen onto the fingers. Cream, oat and soft-lavender palette; real
skin texture, fine 35mm film grain, shallow depth of field, natural imperfect framing; large calm
space on the left for a headline. Warm, intimate, unposed, premium.
No logo, no icon, no app UI on the screen, no text, no abstract geometry, no hexagon, no polygon,
no crypto/blockchain/coins/chain-links, no 3D-render look.
```
A real human moment can't be mistaken for a logo — the safest, most original hero.

### 11.3 Flux / Leonardo — atmosphere / background (no text)
```
A warm minimal editorial hero background: soft off-white paper texture with faint mauve and fine
film grain, a diffused periwinkle glow from the upper right, large empty negative space, a subtle
soft shadow in the lower third for an object to rest on. Premium, tactile, human, calm.
No text, no logos, no UI, no people, no crypto imagery. High resolution, 16:9.
```

### 11.4 Human presence
- **Preferred (real photo, less AI):** search Unsplash/Pexels — `hands holding phone warm window light`,
  `candid person phone home cozy`. Treatment: periwinkle-leaning **duotone** (paper `#F5F3EF` → ink
  `#1E1B22`, accent-tint `#6E5FCE`) + grain + tight crop. Prefer hands / over-shoulder (no faces in
  focus) to avoid uncanny.
- **AI fallback (Leonardo/Flux):**
```
Candid warm documentary photo, a person's hands holding a phone in soft natural window light at home,
cozy warm tones with a faint periwinkle cast, shallow depth of field, film grain, authentic and
unposed. No visible screen UI, no logos, no faces in focus.
```

### 11.5 Tools & watermark
Watermark-free + free/cheap, in order: **Leonardo.ai** (free daily, no watermark, style-reference →
lock the set) → **Flux via fal.ai** (cents/image, top quality, final hero) → **Ideogram** (free,
text-in-card mocks). Avoid Gemini app (visible watermark); if using Google, go through **AI Studio /
Imagen** (invisible SynthID only). Lock ONE style reference first.

## 12. Landing narrative (scroll = one story)
1. **Hero** — the fear-removal promise + the subtraction moment + the warm 3D object + one CTA
   (try the real demo): *“No wallet. No seed phrase. Just a link.”*
2. **The three fears** — each named and killed (narrative, not a feature grid).
3. **The moment** — a real phone showing money arrived (human relief).
4. **Proof / how it works** — the one strip that names Stellar with pride (§4.4) + a tappable public receipt.
5. **Trust** — 7-day return, free to receive, non-custodial, in plain words.
6. **Close** — one CTA band.

## 13. Production discipline (don't burn tokens)
The site is built out (landing + `(site)` + the `(app)` money surfaces); the v1 claim route stays lean and webfont-free.
Iterate in `/brand-kit`. Direction is locked (Periwinkle + Sentient). Keep to two or three signature
components, not a whole new library.
