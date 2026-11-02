"use client";

/**
 * The /pitch deck: eight slides on a fixed 16:9 stage that scales with the window, one slide at a
 * time, or every slide in a column on a phone held upright.
 *
 * Three modes, all chosen by CSS (pitch.css) so the first paint is already the right one and
 * nothing jumps after hydration:
 *   - stage: the active slide fills a 16:9 frame fitted to the window. The keyboard, a swipe, the
 *     dots and the buttons move between slides, and the slide number rides in the URL (#3), so a
 *     link can open on the slide it is about.
 *   - document (a portrait screen up to 900px wide): every slide in one column, reflowed for
 *     reading, scrolled the way any page is. #3 still lands on slide 3, natively, because each
 *     slide's id is its number.
 *   - print: every slide on its own 1600 x 900 page, so "Save as PDF" is the deck as a file.
 *
 * Sizes inside a slide are design pixels of a 1600 x 900 canvas turned into real pixels by --u
 * (a container-query unit of the frame), so the text is set at its real size and stays sharp,
 * rather than being drawn once and scaled as a picture.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileDown, Maximize2, Minimize2, StickyNote } from "lucide-react";
import { SLIDES } from "./slides";

const COUNT = SLIDES.length;

/** Keep in step with the document-mode media query in pitch.css. */
const DOC_QUERY = "(orientation: portrait) and (max-width: 900px)";

const WORDMARK = {
  light: "/brand-kit-assets/logo-wordmark-t.svg",
  dark: "/brand-kit-assets/logo-wordmark-dark.svg",
} as const;

/** "#3" is slide 3. Anything else (no hash, a word, a number out of range) is not a slide. */
function indexFromHash(hash: string): number | null {
  const m = /^#(\d{1,2})$/.exec(hash);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= COUNT ? n - 1 : null;
}

export function PitchDeck() {
  const [index, setIndex] = useState(0);
  const [notesOpen, setNotesOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // The keyboard listener is bound once, so it reads the index from here, never from a stale closure.
  const indexRef = useRef(0);
  const rootRef = useRef<HTMLElement>(null);
  const touchRef = useRef<{ x: number; y: number } | null>(null);

  const show = useCallback((next: number) => {
    const n = Math.max(0, Math.min(COUNT - 1, next));
    if (n === indexRef.current) return;
    indexRef.current = n;
    setIndex(n);
    // replaceState, not pushState: stepping through eight slides must not take eight presses of
    // Back to leave the deck.
    const hash = `#${n + 1}`;
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void rootRef.current?.requestFullscreen?.().catch(() => {});
  }, []);

  // Open on the slide the link names, and follow the hash if it changes by hand.
  useEffect(() => {
    const sync = () => {
      const n = indexFromHash(window.location.hash);
      if (n === null || n === indexRef.current) return;
      indexRef.current = n;
      setIndex(n);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const columnMode = window.matchMedia(DOC_QUERY);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      // In the column the arrows and the space bar scroll, as they do on any page.
      if (columnMode.matches) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
          e.preventDefault();
          show(indexRef.current + 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          show(indexRef.current - 1);
          break;
        case " ":
          // A focused button answers its own space bar.
          if (target?.closest("button, a")) return;
          e.preventDefault();
          show(indexRef.current + (e.shiftKey ? -1 : 1));
          break;
        case "Home":
          e.preventDefault();
          show(0);
          break;
        case "End":
          e.preventDefault();
          show(COUNT - 1);
          break;
        case "n":
        case "N":
          setNotesOpen((open) => !open);
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        default:
          if (/^[1-9]$/.test(e.key) && Number(e.key) <= COUNT) show(Number(e.key) - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, toggleFullscreen]);

  const slide = SLIDES[index]!;

  return (
    <main ref={rootRef} className="pk" data-tone={slide.tone} data-notes={notesOpen ? "open" : "closed"}>
      <div className="pk-progress" aria-hidden="true">
        <span style={{ width: `${((index + 1) / COUNT) * 100}%` }} />
      </div>

      <div
        className="pk-stage"
        role="region"
        aria-roledescription="carousel"
        aria-label="Lumenia pitch deck"
        onTouchStart={(e) => {
          const t = e.touches[0];
          touchRef.current = t ? { x: t.clientX, y: t.clientY } : null;
        }}
        onTouchEnd={(e) => {
          const start = touchRef.current;
          const t = e.changedTouches[0];
          touchRef.current = null;
          if (!start || !t || window.matchMedia(DOC_QUERY).matches) return;
          const dx = t.clientX - start.x;
          const dy = t.clientY - start.y;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) show(indexRef.current + (dx < 0 ? 1 : -1));
        }}
      >
        <div className="pk-frame">
          {SLIDES.map((s, n) => (
            <section
              key={s.id}
              id={String(n + 1)}
              className={`pk-slide pk-slide--${s.id}`}
              data-tone={s.tone}
              data-active={n === index ? "true" : "false"}
              aria-roledescription="slide"
              aria-label={`${n + 1} of ${COUNT}: ${s.title}`}
            >
              {s.body}
            </section>
          ))}
        </div>

        {/* Mouse affordances at the two edges of the window. The bar below has the same two
            actions as real, focusable buttons, so these stay out of the tab order. */}
        <button
          type="button"
          className="pk-zone pk-zone--prev"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => show(index - 1)}
          disabled={index === 0}
        >
          <ChevronLeft />
        </button>
        <button
          type="button"
          className="pk-zone pk-zone--next"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => show(index + 1)}
          disabled={index === COUNT - 1}
        >
          <ChevronRight />
        </button>
      </div>

      <aside className="pk-notes" aria-label="Speaker notes" hidden={!notesOpen}>
        <p className="pk-notes-title">
          Speaker notes &middot; {index + 1}. {slide.title}
        </p>
        <ul>
          {slide.notes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </aside>

      <nav className="pk-bar" aria-label="Slides">
        <div className="pk-bar-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={WORDMARK[slide.tone]} alt="Lumenia" width={92} height={29} />
          <span className="pk-bar-title">{slide.title}</span>
        </div>
        <div className="pk-dots">
          {SLIDES.map((s, n) => (
            <button
              key={s.id}
              type="button"
              className="pk-dot"
              aria-label={`Slide ${n + 1}: ${s.title}`}
              aria-current={n === index ? "step" : undefined}
              onClick={() => show(n)}
            />
          ))}
        </div>
        <div className="pk-bar-actions">
          <span className="pk-count" aria-hidden="true">
            {index + 1} / {COUNT}
          </span>
          <button type="button" onClick={() => show(index - 1)} disabled={index === 0} aria-label="Previous slide" title="Previous (Left arrow)">
            <ChevronLeft />
          </button>
          <button type="button" onClick={() => show(index + 1)} disabled={index === COUNT - 1} aria-label="Next slide" title="Next (Right arrow)">
            <ChevronRight />
          </button>
          <button type="button" onClick={() => setNotesOpen((o) => !o)} aria-pressed={notesOpen} aria-label="Speaker notes" title="Speaker notes (N)">
            <StickyNote />
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? "Leave full screen" : "Full screen"}
            title="Full screen (F)"
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </button>
          <button type="button" onClick={() => window.print()} aria-label="Save as PDF" title="Save as PDF (one slide per page)">
            <FileDown />
          </button>
        </div>
      </nav>

      <p className="pk-sr" aria-live="polite">{`Slide ${index + 1} of ${COUNT}: ${slide.title}`}</p>
    </main>
  );
}
