/**
 * The pointer, the motion, and the pacing rules for the demo film.
 *
 * A recorded browser has no cursor — Playwright drives the real input pipeline, but nothing is
 * drawn. So the film would show fields filling themselves and buttons pressing with no visible
 * cause, which reads as a screen recording of a robot rather than of a person. This injects a
 * macOS-shaped pointer that follows real mouse events, and gives every action a hand-like path:
 * move in an eased arc, pause a beat, press, ripple.
 *
 * The pacing rules are here rather than in the script because they are what stops the film feeling
 * like a slideshow: nothing holds still for long, scrolling is eased rather than jumped, and typing
 * has a human rhythm with a little variance instead of a metronome.
 */

/** The pointer overlay. Injected before any page script so it survives navigation. */
export const CURSOR_SCRIPT = `
(() => {
  if (window.__lumeniaCursor) return;
  window.__lumeniaCursor = true;
  const add = () => {
    if (document.getElementById("__cursor")) return;
    const el = document.createElement("div");
    el.id = "__cursor";
    el.style.cssText = [
      "position:fixed","left:0","top:0","width:22px","height:22px","z-index:2147483647",
      "pointer-events:none","will-change:transform","transform:translate(-100px,-100px)",
      "filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))",
    ].join(";");
    // The macOS arrow: white fill, black edge, so it stays visible on paper and on the dark strips.
    el.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M4 2 L4 17.2 L8.1 13.4 L10.6 19.4 L13.2 18.3 L10.7 12.5 L16.3 12.3 Z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.15" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(el);

    const ring = document.createElement("div");
    ring.id = "__cursor_ring";
    ring.style.cssText = [
      "position:fixed","left:0","top:0","width:34px","height:34px","margin:-17px 0 0 -17px",
      "border-radius:50%","z-index:2147483646","pointer-events:none","opacity:0",
      "background:radial-gradient(circle, rgba(110,95,206,.45) 0%, rgba(110,95,206,0) 70%)",
      "transition:opacity .18s ease, transform .3s ease",
    ].join(";");
    document.documentElement.appendChild(ring);

    let x = -100, y = -100;
    addEventListener("mousemove", (e) => {
      x = e.clientX; y = e.clientY;
      el.style.transform = "translate(" + x + "px," + y + "px)";
      ring.style.transform = "translate(" + x + "px," + y + "px) scale(1)";
    }, true);
    addEventListener("mousedown", () => {
      ring.style.opacity = "1";
      ring.style.transform = "translate(" + x + "px," + y + "px) scale(1.5)";
      setTimeout(() => { ring.style.opacity = "0"; }, 260);
    }, true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
  else add();
})();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ease-in-out so the pointer accelerates away and settles, instead of sliding at constant speed. */
function ease(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

let last = { x: 720, y: 500 };

/** Move the pointer along an eased path. Every click in the film goes through here. */
export async function moveTo(page, x, y, ms = 620) {
  const steps = Math.max(14, Math.round(ms / 16));
  const from = { ...last };
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps);
    await page.mouse.move(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
    await sleep(ms / steps);
  }
  last = { x, y };
}

/** Point at an element and press it, the way a hand would: approach, settle, click. */
export async function click(page, locator, { settle = 260, after = 420 } = {}) {
  const el = typeof locator === "string" ? page.locator(locator) : locator;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(180);
  const box = await el.boundingBox();
  if (!box) throw new Error("demo: nothing to click");
  await moveTo(page, box.x + box.width / 2, box.y + box.height / 2);
  await sleep(settle);
  await page.mouse.down();
  await sleep(70);
  await page.mouse.up();
  await sleep(after);
}

/** Type with a human rhythm — varied gaps, a longer breath after punctuation. */
export async function type(page, locator, text, { perChar = 62 } = {}) {
  const el = typeof locator === "string" ? page.locator(locator) : locator;
  await click(page, el, { after: 120 });
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(perChar + Math.random() * 45 + (".,-@".includes(ch) ? 90 : 0));
  }
  await sleep(260);
}

/** Eased scroll. A jump-cut scroll is the fastest way to make a film look automated. */
export async function scrollBy(page, dy, ms = 1100) {
  await page.evaluate(
    ([dy, ms]) =>
      new Promise((resolve) => {
        const start = window.scrollY;
        const t0 = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms);
          const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          window.scrollTo(0, start + dy * e);
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
    [dy, ms],
  );
  await sleep(120);
}

/** Scroll an element into the middle of the frame, smoothly. */
export async function scrollTo(page, selector, ms = 1000) {
  await page.evaluate(
    ([sel, ms]) =>
      new Promise((resolve) => {
        const el = document.querySelector(sel);
        if (!el) return resolve();
        const target = window.scrollY + el.getBoundingClientRect().top - window.innerHeight * 0.28;
        const start = window.scrollY;
        const t0 = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms);
          const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          window.scrollTo(0, start + (target - start) * e);
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
    [selector, ms],
  );
  await sleep(150);
}

/** A beat. Kept short on purpose: nothing in this film holds still for long. */
export const beat = (ms = 700) => sleep(ms);
export { sleep };
