/**
 * The popup's icons, drawn here as inline SVG (no icon library). 24 x 24 grid, 1.8 stroke, round
 * caps, colour from currentColor. Every icon is decorative: the control that holds it carries the
 * accessible name.
 */
import type { ComponentChildren } from "preact";

function Svg({ children, class: cls }: { children: ComponentChildren; class?: string }) {
  return (
    <svg
      class={cls ? `icon ${cls}` : "icon"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

type P = { class?: string };

/** Links: a list with leading dots. */
export const IconList = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 6h10.5M9.5 12h10.5M9.5 18h10.5" />
    <circle cx="4.5" cy="6" r="0.9" />
    <circle cx="4.5" cy="12" r="0.9" />
    <circle cx="4.5" cy="18" r="0.9" />
  </Svg>
);

/** Settings: two sliders. */
export const IconSliders = (p: P) => (
  <Svg {...p}>
    <path d="M4 8h8M18 8h2M4 16h2M12 16h8" />
    <circle cx="15" cy="8" r="2.2" />
    <circle cx="9" cy="16" r="2.2" />
  </Svg>
);

export const IconBack = (p: P) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);

export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2.6" />
    <path d="M5 15V6.6A2.6 2.6 0 0 1 7.6 4H15" />
  </Svg>
);

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);

export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2.6" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);

export const IconInfo = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.2M12 7.9h.01" />
  </Svg>
);

export const IconExternal = (p: P) => (
  <Svg {...p}>
    <path d="M8 16L16 8M9.5 7.5H16.5V14.5" />
  </Svg>
);

export const IconPaste = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="5" width="14" height="16" rx="2.6" />
    <path d="M9 5V4.2A1.2 1.2 0 0 1 10.2 3h3.6A1.2 1.2 0 0 1 15 4.2V5M9 12h6M9 16h4" />
  </Svg>
);
