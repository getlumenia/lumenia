/**
 * AmbientVideo — the landing's decorative background loops (hero bloom, fears, CTA band, footer).
 *
 * Why this exists rather than a `<video>` and a CSS media query.
 *
 * These loops are lovely on a laptop and expensive on a phone: five of them decoding continuously,
 * under a scrim, at opacity .24–.5, for an effect that is nearly invisible at that size. The obvious
 * fixes do not actually work:
 *   - `preload="none"` does not defer an autoplaying video. The spec lets a user agent ignore
 *     preload when autoplay is set, and Chrome does exactly that.
 *   - `display:none` does not stop the fetch either — measured: the videos still downloaded on a
 *     375px viewport with the element hidden.
 * The only thing that reliably stops a video loading is not having the element. So the <video> is
 * mounted from an effect, and only where it earns its keep.
 *
 * The poster is a real <img> and is server-rendered, so the background is painted at first paint,
 * with or without JS, at every size — phones simply keep it. Tablets and up get the video layered
 * over it once mounted; both carry the same className, so the section's existing opacity, transform
 * and theme rules apply to whichever is showing without duplicating a single value.
 *
 * Reduced motion drops the video too — matching the rule that already did this in landing.css.
 */
"use client";

import { useEffect, useState } from "react";

/** Below this, the poster does the job. Tablets and up can afford the decode, and the motion reads. */
const VIDEO_MIN_WIDTH = 641;

export interface AmbientVideoProps {
  /** Shared by the poster and the video — the section's own background layer class. */
  className: string;
  /** Painted at first paint, server-rendered, and the whole background on phones. */
  poster: string;
  /** [webm, mp4] — webm first, mp4 for Safari's sake. */
  sources: readonly [string, string];
}

export function AmbientVideo({ className, poster, sources }: AmbientVideoProps) {
  const [showVideo, setShowVideo] = useState(false);

  useEffect(() => {
    const wide = window.matchMedia(`(min-width: ${VIDEO_MIN_WIDTH}px)`);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    const decide = () => setShowVideo(wide.matches && !still.matches);
    decide();
    // Rotating a tablet or dragging a window across the breakpoint should settle correctly.
    wide.addEventListener("change", decide);
    still.addEventListener("change", decide);
    return () => {
      wide.removeEventListener("change", decide);
      still.removeEventListener("change", decide);
    };
  }, []);

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={className} src={poster} alt="" aria-hidden="true" loading="lazy" decoding="async" />
      {showVideo && (
        <video className={className} poster={poster} autoPlay loop muted playsInline aria-hidden="true">
          <source src={sources[0]} type="video/webm" />
          <source src={sources[1]} type="video/mp4" />
        </video>
      )}
    </>
  );
}
