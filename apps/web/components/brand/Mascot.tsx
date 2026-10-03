/**
 * Mascot: the Lumenia messenger, in one of its five poses, framed so every pose stands the same
 * height on screen.
 *
 * The cutouts were not made alike. The wave, phone and thumbs-up cutouts are cropped tight to the
 * character; the messenger and celebrate cutouts sit in a 1024px square with a wide transparent
 * margin. Drawn at one CSS size, the messenger came out at roughly two thirds of the height of the
 * waving one, so a flow that changes pose between steps looked like it was zooming in and out.
 * Each pose therefore carries the box its character occupies inside the image (measured from the
 * alpha channel with `magick -alpha extract -threshold 10% -format %@`), and the frame below is sized
 * to THAT box. The image overflows it only where it is transparent.
 *
 * The bottom of every pose fades out into a soft pool of light, as on the landing's greeting. That
 * is a look, and also a fix: the messenger cutout carries a small maker's mark on its foot and the
 * celebrate cutout has square edge artefacts under its feet, and the fade is what hides both.
 *
 * Brand rule for the character: use it AT an emotional beat (a hello, a question, an arrival, an
 * empty or a finished state), never as wallpaper, and never on the claim page's trust moment.
 * Decorative by default (alt=""); pass `alt` when the character itself is the message.
 * Motion is CSS only, and prefers-reduced-motion gets the settled pose.
 */
import type { CSSProperties } from "react";
import "./mascot.css";

export type MascotPose = "messenger" | "wave" | "celebrate" | "phone" | "thumbsup";
export type MascotSize = "hero" | "lg" | "md" | "sm";

interface PoseArt {
  src: string;
  /** The source image, in px. */
  w: number;
  h: number;
  /** Where the character sits inside it: x, y, width, height, in px of the source. */
  box: readonly [number, number, number, number];
  /**
   * The bottom fade, as shares of the character's height: where it starts and where the character
   * is gone. The messenger's maker's mark starts at 95%, the celebrate artefacts at 93.6%, so both
   * are fully faded before that. The tight crops only need their flat cut at the feet softened.
   */
  fade: readonly [number, number];
  /** The glowing envelope, as a share of the character box (messenger only). */
  envelope?: readonly [number, number];
}

const POSES: Record<MascotPose, PoseArt> = {
  messenger: {
    src: "/brand-kit-assets/mascot-messenger-cut.webp",
    w: 1024,
    h: 1024,
    box: [238, 187, 563, 708],
    fade: [0.74, 0.93],
    envelope: [0.29, 0.64],
  },
  celebrate: {
    src: "/brand-kit-assets/mascot-celebrate-cut.webp",
    w: 1024,
    h: 1024,
    box: [165, 187, 696, 703],
    fade: [0.72, 0.92],
  },
  wave: { src: "/brand-kit-assets/mascot-wave-cut.webp", w: 650, h: 720, box: [0, 0, 650, 720], fade: [0.82, 1] },
  phone: { src: "/brand-kit-assets/mascot-phone-cut.webp", w: 508, h: 720, box: [0, 0, 508, 720], fade: [0.82, 1] },
  thumbsup: { src: "/brand-kit-assets/mascot-thumbsup-cut.webp", w: 575, h: 720, box: [0, 0, 575, 720], fade: [0.82, 1] },
};

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

/**
 * An eased (smoothstep) fade from solid to clear between two heights. A straight linear fade has
 * a visible starting edge, a band across the body that is plainest on the dark theme; easing both
 * ends of it removes the edge.
 */
function fadeMask([start, end]: readonly [number, number]): string {
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const alpha = 1 - t * t * (3 - 2 * t);
    return `rgb(0 0 0 / ${alpha.toFixed(3)}) ${pct(start + (end - start) * t)}`;
  });
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

/** The image behind a pose, for warming the cache before the beat that shows it. */
export function mascotSrc(pose: MascotPose): string {
  return POSES[pose].src;
}

export function Mascot({
  pose,
  size = "lg",
  alt = "",
  enter = "rise",
  priority = false,
  className,
}: {
  pose: MascotPose;
  size?: MascotSize;
  /** Leave empty when the heading next to it already says everything (the usual case). */
  alt?: string;
  /** How it arrives: "rise" (a small lift), "pop" (for a celebration), or "none". */
  enter?: "rise" | "pop" | "none";
  /** The first beat's mascot is the largest thing on screen: fetch it first. */
  priority?: boolean;
  className?: string;
}) {
  const art = POSES[pose];
  const [x, y, bw, bh] = art.box;
  const mask = fadeMask(art.fade);
  const frame: CSSProperties = { aspectRatio: `${bw} / ${bh}`, maskImage: mask, WebkitMaskImage: mask };
  return (
    <div className={`mascot mascot--${size}${className ? ` ${className}` : ""}`} data-enter={enter}>
      <span className="mascot-halo" aria-hidden="true" />
      <span className="mascot-pool" aria-hidden="true" />
      {/* The body floats and casts the soft shadow; the frame inside it fades the feet out. They
          are two elements because a mask clips everything outside its own box, its element's
          filter included: on one element the shadow was cut into a visible rectangle. */}
      <div className="mascot-body">
        <div className="mascot-frame" style={frame}>
          {/* A plain img on purpose: these cutouts are already small webp files, and the frame
              positions the image against the character box, not against a next/image wrapper. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="mascot-img"
            src={art.src}
            alt={alt}
            width={art.w}
            height={art.h}
            decoding="async"
            fetchPriority={priority ? "high" : undefined}
            draggable={false}
            style={{ width: pct(art.w / bw), left: pct(-x / bw), top: pct(-y / bh) }}
          />
          {art.envelope && (
            <span
              className="mascot-envglow"
              aria-hidden="true"
              style={{ left: pct(art.envelope[0]), top: pct(art.envelope[1]) }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
