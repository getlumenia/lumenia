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
 * TWO baked origins, not one. Every surface now falls back to the Cloudflare Worker, which
 * is the only sponsor we deploy. The FROZEN claim route (/c/[id]) still carries the old
 * Vercel origin, because that file is grant evidence and cannot be edited — so a local run
 * of the claim spec would otherwise call an origin nothing rewrites. Both are listed, and
 * both get redirected at the target.
 */
const BAKED_SPONSORS = [
  "https://lumenia-sponsor.avakit.workers.dev",
  "https://lumenia-sponsor.vercel.app", // frozen /c/[id] only — do not remove while that route is frozen
] as const;

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
