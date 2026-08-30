/**
 * /learn/[slug] — a single guide. Rebuilt on the Periwinkle system and moved here from (marketing).
 *
 * Statically generated from lib/learn.ts (generateStaticParams), body copy unchanged. The guide's
 * own title is the h1 and its summary is the lead — the summary was written as a one-line answer to
 * the title, which is exactly what a lead is, and the old page dropped it on the article page and
 * showed it only in the index.
 *
 * The next/previous row at the end is real navigation, not a recommendation engine: five guides in
 * a fixed editorial order, so "what to read next" is simply the next one.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { jsonLdSafe } from "../../../../lib/utils";
import { GUIDES, GUIDES_PUBLISHED, GUIDES_UPDATED, getGuide } from "../../../../lib/learn";
import { Footer } from "../../../../components/site/sections/Footer";
import "../../../../components/site/page.css";
import "../../../../components/site/editorial.css";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://getlumenia.com";

/**
 * Article + BreadcrumbList structured data — the two schema types that still earn
 * visible treatment in 2026 (FAQPage rich results are dead; llms.txt is ignored by
 * AI crawlers — both deliberately skipped). Everything here is TRUE: real git
 * content dates (lib/learn.ts), the Organization as author (no invented persona),
 * no ratings, no fabricated fields. Static authored object — no user input.
 */
function guideJsonLd(g: { slug: string; title: string; summary: string }) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": `${SITE_URL}/learn/${g.slug}#article`,
        headline: g.title,
        description: g.summary,
        inLanguage: "en",
        image: `${SITE_URL}/og.png`,
        datePublished: GUIDES_PUBLISHED,
        dateModified: GUIDES_UPDATED,
        author: { "@id": `${SITE_URL}/#organization` },
        publisher: { "@id": `${SITE_URL}/#organization` },
        mainEntityOfPage: `${SITE_URL}/learn/${g.slug}`,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Learn", item: `${SITE_URL}/learn` },
          { "@type": "ListItem", position: 3, name: g.title, item: `${SITE_URL}/learn/${g.slug}` },
        ],
      },
      // The Organization the author/publisher ids point at — restated here because
      // a crawler reading this page never saw the landing's @graph.
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#organization`,
        name: "Lumenia",
        url: SITE_URL,
        logo: `${SITE_URL}/icon-512.png`,
      },
    ],
  };
}

export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const g = getGuide((await params).slug);
  if (!g) return { title: "Learn" };
  const title = `${g.title} | Lumenia`; // OG/Twitter keep the full branded form
  return {
    title: g.title, // the (site) layout template appends “ | Lumenia”
    description: g.summary,
    alternates: { canonical: `/learn/${g.slug}` },
    openGraph: {
      type: "article",
      url: `/learn/${g.slug}`,
      siteName: "Lumenia",
      title,
      description: g.summary,
      locale: "en_US",
      images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lumenia. Money home, in a link." }],
    },
    twitter: { card: "summary_large_image", title, description: g.summary, images: ["/og.png"] },
  };
}

export default async function Guide({ params }: { params: Promise<{ slug: string }> }) {
  const slug = (await params).slug;
  const g = getGuide(slug);
  if (!g) notFound();

  const i = GUIDES.findIndex((x) => x.slug === slug);
  const next = GUIDES[i + 1];

  return (
    <div className="pg ed">
      <script
        type="application/ld+json"
        // Authored here, but escaped anyway: JSON.stringify does not escape "<", so the day a
        // title or a future CMS field contains "</script>" this would break out of the tag.
        dangerouslySetInnerHTML={{ __html: jsonLdSafe(guideJsonLd(g!)) }}
      />
      <header className="pg-hero pg-glow">
        <div className="pg-hero-inner">
          <Link className="ed-back" href="/learn">
            <span className="ed-back-arrow" aria-hidden="true">
              ←
            </span>
            All guides
          </Link>
          <h1 className="pg-h1">{g.title}</h1>
          <p className="pg-lead">{g.summary}</p>
        </div>
      </header>

      <section className="ed-body">
        <article className="ed-prose">
          {g.body.map((p) => (
            <p key={p.slice(0, 40)}>{p}</p>
          ))}
        </article>

        <div className="ed-close">
          {next ? (
            <p className="ed-close-p">
              Next: <Link href={`/learn/${next.slug}`}>{next.title}</Link>
            </p>
          ) : (
            <p className="ed-close-p">
              That&apos;s the set. <Link href="/learn">Back to all guides</Link>, or see it for
              yourself.
            </p>
          )}
          <div className="pg-cta">
            <Link className="pg-btn pg-btn-primary" href="/try">
              See it work
            </Link>
            <Link className="pg-btn pg-btn-ghost" href="/how-it-works">
              How it works
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
