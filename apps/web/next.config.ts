import type { NextConfig } from "next";
import path from "node:path";

// PWA service worker (Serwist) is deferred (not in the NOW scope).
const nextConfig: NextConfig = {
  // LOCAL ONLY: this is a pnpm workspace whose node_modules is hoisted to the repo
  // root, so Turbopack's root must be the repo root (else the symlinked `next`
  // resolves outside an apps/web root and the build fails). On Vercel the web
  // project uploads apps/web standalone with real deps — the default inference is
  // correct there (it is how prod already builds), so we must NOT override it.
  ...(process.env.VERCEL
    ? {}
    : { turbopack: { root: path.resolve(import.meta.dirname, "..", "..") } }),

  // NOT inlining CSS (experimental.inlineCss). Lighthouse flags the three stylesheets as ~900 ms of
  // render-blocking, but inlining them was measured WORSE — Performance 94 → 88, LCP 2.94 s → 3.77 s.
  // The 18 KB moves into the document, so the HTML itself lands later and every metric waits on it.
  // The linked files are cacheable and parallel; the audit's "savings" do not survive contact.

  // The OG route reads the embedded font from ./assets via fs at runtime — make
  // sure that file is traced into the serverless function bundle on Vercel.
  outputFileTracingIncludes: {
    "/c/**": ["./assets/**"],
  },

  // The bearer key rides in the #fragment (never sent to a server), but the claim
  // route must also not leak its full URL via the Referer header to the sponsor,
  // the explorer, or any third party. Cover the page and its /og sub-path.
  // The public try-it surface moved from /demo to /try. Keep any old /demo link
  // (shared chats, QR codes, indexed URLs) alive with a permanent redirect.
  async redirects() {
    return [{ source: "/demo", destination: "/try", permanent: true }];
  },

  async headers() {
    // X-Robots-Tag: the claim page is FROZEN, so its missing robots meta cannot be
    // fixed on the page — the header is the layer we own. robots.txt Disallow
    // alone can leave a link-discovered claim URL indexed (URL-only, exposing
    // amount/sender in the query); noindex at the header level closes that.
    return [
      {
        source: "/c/:id",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        source: "/c/:id/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
