import { test, expect } from "@playwright/test";

/**
 * The boot opening drains a field of colour into the "i" of the wordmark. That target is a CSS
 * constant (`--i-x` / `--i-y` in landing.css), derived from the wordmark SVG's geometry rather than
 * measured at runtime — which is what lets the opening run without JavaScript.
 *
 * A constant derived from a layout can rot when the layout moves. This is the guard: it compares
 * the CSS point against the wordmark's REAL rendered rect. Change `.op-brandlogo`'s height, its
 * position, or the SVG's viewBox, and this fails instead of the opening quietly draining into the
 * wrong place.
 */

// The lumen tittle — <circle cx="1504" cy="556"> inside viewBox "300 450 1470 460".
const SPARK_FX = (1504 - 300) / 1470;
const SPARK_FY = (556 - 450) / 460;

// Same convention as the other specs: live by default, WEB_URL to point it at a local server.
// Unlike them, this one costs nothing on-chain — it only reads the landing.
const WEB = (process.env.WEB_URL ?? "https://getlumenia.com").replace(/\/$/, "");

test.describe("boot opening", () => {
  test("the CSS drain point is the wordmark's actual lumen spark", async ({ page }) => {
    await page.goto(WEB + "/", { waitUntil: "domcontentloaded" });

    const point = await page.evaluate(
      ({ fx, fy }) => {
        const op = document.querySelector(".op")!;
        const style = getComputedStyle(op);
        const probe = document.createElement("div");
        // Resolve the calc()s the same way the field does: against the viewport-sized field.
        Object.assign(probe.style, {
          position: "fixed",
          left: style.getPropertyValue("--i-x").trim(),
          top: style.getPropertyValue("--i-y").trim(),
          width: "0px",
          height: "0px",
        });
        document.body.append(probe);
        const css = probe.getBoundingClientRect();
        probe.remove();

        const mark = [...document.querySelectorAll<HTMLImageElement>(".op-brandlogo")].find(
          (m) => m.getClientRects().length > 0,
        )!;
        const r = mark.getBoundingClientRect();
        return {
          css: { x: css.left, y: css.top },
          real: { x: r.left + r.width * fx, y: r.top + r.height * fy },
        };
      },
      { fx: SPARK_FX, fy: SPARK_FY },
    );

    // Sub-pixel tolerance: the CSS constant is rounded to 2dp.
    expect(point.css.x).toBeCloseTo(point.real.x, 0);
    expect(point.css.y).toBeCloseTo(point.real.y, 0);
  });

  test("the opening needs no JavaScript", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(WEB + "/", { waitUntil: "domcontentloaded" });

    // The field must be there at first paint and must be animating itself away.
    const field = page.locator(".op-boot");
    await expect(field).toBeAttached();
    /* POLL, do not snapshot. This read used to happen the instant domcontentloaded fired, which is
       before the stylesheet that carries the animation has been applied — so it saw "none" and
       reported the JS-free opening as broken when the opening was fine (verified separately: with
       scripts disabled the field really does animate `op-boot-drain`).
       `op-boot-leave` is the honest second answer: under prefers-reduced-motion the field is
       supposed to leave without draining, and a browser that emulates reduced motion by default
       must not read as a failure either. */
    await expect
      .poll(async () => field.evaluate((el) => getComputedStyle(el).animationName), { timeout: 10_000 })
      .toMatch(/^op-boot-(drain|leave)$/);

    // And the greeting must arrive on its own, rather than waiting for a script that never runs.
    // The greeting fades in on its own; under reduced motion it is simply there. Either way it
    // must reach full opacity WITHOUT a script running, which is the whole claim of this test.
    await expect(page.locator(".op-greet-stage")).toHaveCSS("opacity", "1", { timeout: 10_000 });
    await context.close();
  });
});
