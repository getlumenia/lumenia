import type { MetadataRoute } from "next";
import { GUIDES, GUIDES_UPDATED } from "../lib/learn";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://lumenia-chi.vercel.app";

/**
 * sitemap.xml (Next native) — the public surface only.
 *
 * Deliberately excludes everything robots.ts disallows: the claim route (bearer links), the (app)
 * group (someone's own money), and the internal /brand-kit, /dev and /spike routes. The guides are
 * enumerated from GUIDES, the same source /learn/[slug] builds its static params from, so a new
 * guide cannot ship without appearing here.
 *
 * lastModified is HAND-MAINTAINED with real content dates (seeded from git history — the honesty
 * rule applies to crawlers too: Google ignores sitemaps whose lastmod visibly lies). When you make
 * a MEANINGFUL copy/content change to a route, bump its date here; do not automate it to the build
 * timestamp (that claims every page changed on every deploy).
 */
const MODIFIED: Record<string, string> = {
  "/": "2026-07-15",
  "/how-it-works": "2026-07-15",
  "/try": "2026-07-15",
  "/learn": "2026-07-15",
  "/about": "2026-07-16",
  "/developers": "2026-07-16",
  "/roadmap": "2026-07-15",
  "/stats": "2026-07-18",
  "/tools": "2026-07-16",
  "/tools/verify": "2026-07-16",
  "/tools/link-check": "2026-07-16",
  "/tools/usd-try": "2026-07-18", // live ECB reference rate replaced the stale constant
  "/tools/cost": "2026-07-18", // World Bank citation + copy soften
  "/cash-out": "2026-07-16",
  "/waitlist": "2026-07-16",
  "/brand": "2026-07-16",
  "/privacy": "2026-07-16",
  "/terms": "2026-07-16",
};

export default function sitemap(): MetadataRoute.Sitemap {
  const page = (path: string, priority: number, changeFrequency: "weekly" | "monthly"): MetadataRoute.Sitemap[number] => ({
    url: `${SITE_URL}${path}`,
    changeFrequency,
    priority,
    ...(MODIFIED[path] ? { lastModified: MODIFIED[path] } : {}),
  });

  return [
    page("/", 1, "weekly"),
    page("/how-it-works", 0.9, "monthly"),
    page("/try", 0.8, "monthly"),
    page("/learn", 0.7, "monthly"),
    ...GUIDES.map((g) => ({
      url: `${SITE_URL}/learn/${g.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.6,
      lastModified: GUIDES_UPDATED,
    })),
    page("/about", 0.6, "monthly"),
    page("/developers", 0.6, "monthly"),
    page("/roadmap", 0.5, "monthly"),
    page("/stats", 0.5, "monthly"),
    page("/tools", 0.5, "monthly"),
    page("/tools/verify", 0.4, "monthly"),
    page("/tools/link-check", 0.4, "monthly"),
    page("/tools/usd-try", 0.4, "monthly"),
    page("/tools/cost", 0.4, "monthly"),
    page("/cash-out", 0.4, "monthly"),
    page("/waitlist", 0.4, "monthly"),
    page("/brand", 0.3, "monthly"),
    page("/privacy", 0.3, "monthly"),
    page("/terms", 0.3, "monthly"),
  ];
}
