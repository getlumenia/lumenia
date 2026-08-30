import type { BrowserContext } from "@playwright/test";

/**
 * Local-run helper. The web build BAKES the live sponsor origin, whose CORS allowlist pins the
 * deployed web origin — so a browser call from localhost is blocked. This installs a Playwright
 * route that re-issues every request to the baked origin against the target `SPONSOR_URL` and
 * fulfils with the real response.
 *
 * It is a URL REWRITE, not a stub: every byte still comes from the real sponsor code + real testnet.
 * No-op against the live URL (`SPONSOR_URL` unset or == the baked origin), so the same specs run
 * unchanged as the post-deploy live regression.
 */
/**
 * ONE baked origin. Every surface that talks to the sponsor — the v1 claim route (/c/[id])
 * included — falls back to the Cloudflare Worker, and the shipped CSP `connect-src`
 * (next.config.ts) allows only that origin, so an origin absent from this list is also an
 * origin a page is not permitted to call. Keep it in step with the `NEXT_PUBLIC_SPONSOR_URL`
 * fallbacks: an origin the build bakes but this list omits is one a local run cannot reach.
 */
const BAKED_SPONSORS = ["https://lumenia-sponsor.avakit.workers.dev"] as const;

export async function rewriteSponsor(
  context: BrowserContext,
  target: string | undefined = process.env.SPONSOR_URL,
): Promise<void> {
  if (!target) return;
  for (const baked of BAKED_SPONSORS) {
    if (target === baked) continue; // already pointing there — nothing to rewrite
    await context.route(`${baked}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const res = await fetch(`${target}${url.pathname}${url.search}`, {
        method: req.method(),
        headers: req.postData() ? { "content-type": "application/json" } : undefined,
        body: req.postData() ?? undefined,
      });
      await route.fulfill({
        status: res.status,
        body: await res.text(),
        contentType: res.headers.get("content-type") ?? "application/json",
      });
    });
  }
}
