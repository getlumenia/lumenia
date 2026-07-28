/**
 * (site) route group — the public site on the LOCKED "Periwinkle" system (brand.md): Sentient +
 * Switzer (self-hosted), the `--pw-*` palette, `next-themes` via data-theme, SiteNav + Footer.
 *
 * This is now the whole public site: the old (marketing) warm-paper group has been fully migrated
 * in here and DELETED (route groups don't affect URLs, so each page moved without its URL changing
 * and arrived with the right chrome already around it). The only warm-paper left in the product is
 * the frozen claim route.
 *
 * The claim route /c/[id] lives outside this group and stays webfont-free + frozen: nothing here
 * may reach it.
 *
 * Route-specific metadata (title, canonical, OG) belongs in each page.tsx — Next merges metadata
 * shallowly, so a page that redefines `openGraph` replaces the whole object rather than extending
 * it. Only genuinely group-wide fields live here.
 */
import type { Metadata, Viewport } from "next";
// Sentient + Switzer, self-hosted — replaces the api.fontshare.com stylesheet, which was two extra
// origins of DNS/TLS/round-trips sitting in front of the first paint. Same family names, same faces.
import "../../components/site/fonts.css";
// The --pw-* Periwinkle palette (both themes), scoped to .op / .pw. Imported once here rather than
// per-route so the group's pages share one source of truth for the palette.
import "../../components/site/pw-tokens.css";
// Scoped here, not in the root layout: the ::view-transition rules are document-level, but only
// this group has a ThemeToggle to start one — so the frozen claim route never loads them.
import "../../components/site/theme-transition.css";
import { SiteNav } from "../../components/site/SiteNav";
import { ThemeProvider } from "../../components/site/ThemeProvider";

/** Group-wide only. Everything route-specific (title/description/canonical/OG) lives in page.tsx.
 *  The title TEMPLATE enforces the " | Lumenia" suffix pages used to append by hand (drift risk);
 *  pages now declare only their base title. It lives HERE, not in the root layout, because the
 *  root also wraps the frozen /c/[id], whose dynamic "X sent you $Y" title must stay untouched. */
export const metadata: Metadata = {
  title: { default: "Lumenia", template: "%s | Lumenia" },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
};

/**
 * Overrides the root viewport for this group only.
 *
 * `maximumScale: 5` undoes the root's `maximumScale: 1`, which renders as user-scalable=no and
 * blocks pinch-zoom — a WCAG failure. Scoped here rather than fixed at the root because the root
 * also wraps the frozen claim route, which is grant evidence and is not in this task's blast
 * radius. It is worth fixing there too (a recipient reading an amount has more reason to zoom than
 * anyone) — that just needs the claim regression re-run alongside it.
 *
 * themeColor tracks Periwinkle's own surfaces rather than the root's warm paper, and follows the
 * theme the way the pages do.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F5F3EF" },
    { media: "(prefers-color-scheme: dark)", color: "#15121C" },
  ],
  maximumScale: 5,
};

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      {/* Switzer 500 sets the landing's greeting bubble — the first type anyone reads there — and
          the body copy on every other page in the group. Self-hosted, so this is a same-origin
          preload on an already-open connection. */}
      <link rel="preload" as="font" type="font/woff2" href="/fonts/switzer-500.woff2" crossOrigin="" />
      {/* On the landing the wordmark IS the LCP element, but it is discovered late — it is an <img>
          deep in a client component. Elsewhere in the group it is the nav mark, painted immediately.
          Both variants are preloaded because the theme picks one before paint and a miss costs the
          landing its LCP; they are 7.5 KB each. */}
      <link rel="preload" as="image" href="/brand-kit-assets/logo-wordmark-t.svg" type="image/svg+xml" fetchPriority="high" />
      <link rel="preload" as="image" href="/brand-kit-assets/logo-wordmark-dark.svg" type="image/svg+xml" fetchPriority="high" />
      <SiteNav />
      {children}
    </ThemeProvider>
  );
}
