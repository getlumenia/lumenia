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

  // The NEAR rail's library is a workspace package shipped as TypeScript source (packages/near,
  // `main: src/index.ts`); the browser imports its relayer client, so Next has to compile it.
  transpilePackages: ["@lumenia/near"],

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

  /**
   * SEP-0001 discovery. A wallet resolving `name*getlumenia.com` fetches
   * `/.well-known/stellar.toml` — and an app-router segment cannot be called `.well-known`
   * (a leading dot is not a route segment), so the well-known path is rewritten onto a normal
   * route handler. See app/api/stellar-toml/route.ts.
   */
  async rewrites() {
    return [{ source: "/.well-known/stellar.toml", destination: "/api/stellar-toml" }];
  },

  async headers() {
    /**
     * Content-Security-Policy. This app keeps a raw Ed25519 seed in IndexedDB and decrypts it in
     * the page, and its most sensitive screen is deliberately completed inside the WhatsApp
     * in-app browser — the least trustworthy place it runs. One injected script there is total
     * loss, so the two directives that carry the weight are `script-src` (no remote code) and
     * `connect-src` (an allowlist, so injected code has nowhere to send a stolen key).
     *
     * `'unsafe-inline'` is still required for scripts: Next inlines its hydration payload and the
     * theme-flash guard, and eliminating it needs a per-request nonce from middleware. Honest
     * limitation — this blocks remote loading and exfiltration, not inline injection. A
     * nonce-based policy is the next step up.
     *
     * The connect allowlist is derived from the SAME env vars lib/network.ts reads, so a
     * deployment that repoints its sponsor or Horizon does not silently lose its own backend.
     */
    const dev = process.env.NODE_ENV !== "production";
    const origin = (u: string | undefined): string[] => {
      if (!u) return [];
      try {
        return [new URL(u).origin];
      } catch {
        return [];
      }
    };
    const connect = [
      "'self'",
      ...origin(process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev"),
      ...origin(process.env.NEXT_PUBLIC_SPONSOR_URL_MAINNET),
      ...origin(process.env.NEXT_PUBLIC_HORIZON ?? "https://horizon-testnet.stellar.org"),
      ...origin(process.env.NEXT_PUBLIC_HORIZON_MAINNET ?? "https://horizon.stellar.org"),
      ...origin(process.env.NEXT_PUBLIC_SOROBAN_RPC ?? "https://soroban-testnet.stellar.org"),
      ...origin(process.env.NEXT_PUBLIC_SOROBAN_RPC_MAINNET ?? "https://mainnet.sorobanrpc.com"),
      // Only reachable from the spike harness, which is build-gated off in production.
      ...(dev ? ["https://friendbot.stellar.org"] : []),
      // The NEAR rail (lib/near/config.ts): its RPC (one URL or several, comma-separated), the
      // relayer that pays a pay-forward link's gas, and the 1Click quote service the claim page
      // asks for a dry cross-chain quote. Same rule as above: derived from the env the code reads.
      ...(process.env.NEXT_PUBLIC_NEAR_RPC ?? "https://test.rpc.fastnear.com").split(",").flatMap((u) => origin(u.trim())),
      ...origin(process.env.NEXT_PUBLIC_NEAR_RELAYER_URL ?? "https://lumenia-near-relayer.avakit.workers.dev"),
      "https://1click.chaindefuser.com",
    ];
    // /brand-kit pulls Fontshare + Google Fonts, and 404s in production — so those hosts are
    // allowed in development only, and the shipped policy never mentions them.
    const styleExtra = dev ? " https://api.fontshare.com https://fonts.googleapis.com" : "";
    const fontExtra = dev ? " https://cdn.fontshare.com https://fonts.gstatic.com" : "";

    const csp = [
      "default-src 'self'",
      /* `wasm-unsafe-eval` is required, not optional: Argon2id runs as WebAssembly (hash-wasm), and
       * it is what turns a password into the key that locks an account, backs it up and restores
       * it. Without this the browser refuses to compile the module at all — every unlock failed
       * with a CompileError that the UI reported as "that password didn't work", telling people
       * their correct password was wrong about money they could no longer open.
       *
       * It is the narrow directive for exactly this, and deliberately NOT `unsafe-eval`: it permits
       * compiling WebAssembly and nothing else, so eval() of strings stays blocked and the
       * no-remote-code property this policy exists for is untouched. */
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
      `style-src 'self' 'unsafe-inline'${styleExtra}`,
      `font-src 'self' data:${fontExtra}`,
      "img-src 'self' data: blob:",
      `connect-src ${[...new Set(connect)].join(" ")}`,
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "upgrade-insecure-requests",
    ].join("; ");

    const baseline = [
      { key: "Content-Security-Policy", value: csp },
      // Clickjacking: an overlay on the "Send" button of /send-out is a real cash-out attack.
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
    ];

    // X-Robots-Tag: the claim page is FROZEN, so its missing robots meta cannot be
    // fixed on the page — the header is the layer we own. robots.txt Disallow
    // alone can leave a link-discovered claim URL indexed (URL-only, exposing
    // amount/sender in the query); noindex at the header level closes that.
    return [
      { source: "/:path*", headers: baseline },
      {
        // The claim routes carry a bearer key: they keep the stricter no-referrer. Next emits
        // both entries, and the last Referrer-Policy wins, so this overrides the baseline here.
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
      {
        // The claim screen of a link made with practice money (app/claim): the key rides in its
        // #fragment like the others, so the same no-referrer and noindex.
        source: "/claim",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        // The old path of that screen, kept as a client-side forward to /claim with the fragment
        // intact. A static segment under /c, so the two entries above already cover it; written out
        // so the rule survives if those patterns ever narrow.
        source: "/c/near",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        // Same reasoning for the v2 claim route — its #fragment is the money too.
        source: "/v2/c/:linkHex",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        // The self-hosted Firefox add-on (AMO-signed, unlisted channel), at
        // public/extension/lumenia-firefox.xpi once it exists. Firefox offers to install a file
        // from a link only when it arrives as application/x-xpinstall; as anything else it is just a
        // download. Stated here rather than left to the host's MIME table. `:file+`, not `:file*`:
        // zero-or-more would also match /extension.xpi, outside the folder.
        source: "/extension/:file+.xpi",
        headers: [{ key: "Content-Type", value: "application/x-xpinstall" }],
      },
    ];
  },
};

export default nextConfig;
