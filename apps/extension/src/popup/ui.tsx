/**
 * The popup's small component set: buttons, fields, notices, the header bars. Every class here is
 * styled in styles/popup.css from the Periwinkle tokens; nothing in this file picks a colour.
 */
import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { ext } from "../lib/browser";
import type { NetId } from "../lib/types";
import { IconBack, IconCheck, IconInfo, IconList, IconSliders } from "./icons";

export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(" ");

/** Open a web page in a new tab. The popup closes itself once the tab exists. */
export function openUrl(url: string): void {
  try {
    void Promise.resolve(ext.tabs.create({ url })).then(
      () => window.close(),
      () => undefined,
    );
  } catch {
    /* no tabs API in this context */
  }
}

/** A link to a web page that opens in a tab (a bare href would navigate the popup itself). */
export function ExtLink({ href, children, class: cls }: { href: string; children: ComponentChildren; class?: string }) {
  return (
    <a
      class={cx("link", cls)}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => {
        e.preventDefault();
        openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

export function Spinner() {
  return (
    <svg class="spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="38 60" />
    </svg>
  );
}

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

interface ButtonProps {
  children?: ComponentChildren;
  variant?: ButtonVariant;
  small?: boolean;
  /** shows a spinner and the busy label, and blocks a second press */
  busy?: boolean;
  busyLabel?: string;
  class?: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: (e: MouseEvent) => unknown;
  "aria-label"?: string;
  "aria-pressed"?: boolean;
  title?: string;
  id?: string;
}

export function Button(props: ButtonProps) {
  const { variant = "primary", small, busy, busyLabel, class: cls, children, disabled, type = "button", ...rest } = props;
  return (
    <button
      {...rest}
      type={type}
      class={cx("btn", `btn--${variant}`, small && "btn--sm", cls)}
      disabled={Boolean(disabled) || Boolean(busy)}
      aria-busy={busy ? true : undefined}
    >
      {busy ? (
        <>
          <Spinner />
          <span>{busyLabel ?? children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onValue: (v: string) => void;
  type?: "text" | "email" | "password" | "tel";
  inputMode?: "text" | "decimal" | "numeric" | "email";
  autoComplete?: string;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  /** locked while something is in flight, but still focusable, so a refusal leaves the cursor where it was */
  readOnly?: boolean;
  invalid?: boolean;
  describedBy?: string;
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement>;
  /** something that sits inside the right edge of the field (a Show button) */
  trailing?: ComponentChildren;
  class?: string;
}

export function TextField(p: TextFieldProps) {
  const own = useRef<HTMLInputElement>(null);
  const ref = p.inputRef ?? own;
  useEffect(() => {
    if (p.autoFocus) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div class={cx("field", p.class)}>
      <label class="field__label" for={p.id}>
        {p.label}
      </label>
      <div class={cx("field__box", p.invalid && "is-invalid")}>
        <input
          ref={ref}
          id={p.id}
          class="field__input"
          type={p.type ?? "text"}
          inputMode={p.inputMode}
          autoComplete={p.autoComplete}
          placeholder={p.placeholder}
          maxLength={p.maxLength}
          disabled={p.disabled}
          readOnly={p.readOnly}
          value={p.value}
          spellcheck={false}
          autocapitalize="off"
          aria-invalid={p.invalid ? true : undefined}
          aria-describedby={p.describedBy}
          onInput={(e) => p.onValue(e.currentTarget.value)}
        />
        {p.trailing}
      </div>
    </div>
  );
}

/** An on/off switch with its label; announced as a switch. */
export function Switch({
  id,
  checked,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ComponentChildren;
}) {
  return (
    <label class="switch-row" for={id}>
      <span class="switch-row__label">{children}</span>
      <input
        id={id}
        class="switch"
        type="checkbox"
        role="switch"
        checked={checked}
        aria-checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
    </label>
  );
}

/** A calm inline message. Errors are announced at once; everything else politely. */
export function Notice({
  tone = "info",
  children,
  id,
  class: cls,
}: {
  tone?: "info" | "error";
  children: ComponentChildren;
  id?: string;
  class?: string;
}) {
  return (
    <div id={id} class={cx("notice", `notice--${tone}`, cls)} role={tone === "error" ? "alert" : "status"}>
      <IconInfo class="notice__icon" />
      <div class="notice__body">{children}</div>
    </div>
  );
}

/** An indeterminate bar: something is happening and we do not know for how long. */
export function Progress({ label }: { label: string }) {
  return (
    <div class="progress" role="progressbar" aria-label={label} aria-busy="true">
      <span class="progress__bar" />
    </div>
  );
}

/** The screen heading. Takes focus when the screen appears, so a screen reader starts at the top. */
export function Heading({ children, focus = true, class: cls }: { children: ComponentChildren; focus?: boolean; class?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} class={cx("h1", cls)}>
      {children}
    </h1>
  );
}

/**
 * Which money, always in the header: two halves, one tap. Practice is calm; real, when it is on, is
 * the accent (solid), because it is a safety cue and is loud on purpose. What a tap does, including
 * the real-money ceremony, lives in netswitch.tsx.
 */
export function NetSwitch({
  net,
  disabled = false,
  realTitle = "Real money: capped per link",
  onPick,
}: {
  net: NetId;
  disabled?: boolean;
  /** what real money is for this account right now (format.ts realMoneyTitle), never a fixed claim */
  realTitle?: string;
  onPick: (net: NetId) => void;
}) {
  return (
    <div class="netswitch" role="group" aria-label="Which money">
      <button
        type="button"
        class={cx("netswitch__opt", net === "testnet" && "is-on")}
        aria-pressed={net === "testnet"}
        aria-label="Practice money"
        title="Practice money: play dollars"
        disabled={disabled}
        onClick={() => onPick("testnet")}
      >
        Practice
      </button>
      <button
        type="button"
        class={cx("netswitch__opt", "netswitch__opt--real", net === "public" && "is-on")}
        aria-pressed={net === "public"}
        aria-label="Real money"
        title={realTitle}
        disabled={disabled}
        onClick={() => onPick("public")}
      >
        Real
      </button>
    </div>
  );
}

/** The header of the screens before there is an account to talk about: the wordmark alone. */
export function BrandBar() {
  return (
    <header class="bar">
      <Wordmark />
    </header>
  );
}

/** The header of the home screens: wordmark, the money switch, and the two places to go. */
export function TopBar({
  net,
  switchDisabled = false,
  realTitle,
  onPick,
  onLinks,
  onSettings,
}: {
  net: NetId;
  switchDisabled?: boolean;
  realTitle?: string;
  onPick: (net: NetId) => void;
  onLinks: () => void;
  onSettings: () => void;
}) {
  return (
    <header class="bar">
      <Wordmark />
      <NetSwitch net={net} disabled={switchDisabled} realTitle={realTitle} onPick={onPick} />
      <span class="bar__spacer" />
      <button type="button" class="icon-btn" aria-label="Links" title="Links" onClick={onLinks}>
        <IconList />
      </button>
      <button type="button" class="icon-btn" aria-label="Settings" title="Settings" onClick={onSettings}>
        <IconSliders />
      </button>
    </header>
  );
}

/** The header of Links and Settings: a way back and the screen's name. */
export function SubBar({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header class="bar bar--sub">
      <button type="button" class="icon-btn" aria-label="Back" title="Back" onClick={onBack}>
        <IconBack />
      </button>
      <h1 class="bar__title">{title}</h1>
    </header>
  );
}

/** The small round badge that marks an arrival: the accent and a check, never green. */

/* ------------------------------------------- brand ------------------------------------------- */

/** The wordmark, as the landing page draws it: the periwinkle mark on light, the recoloured one on dark. */
export function Wordmark({ class: cls }: { class?: string }) {
  return (
    <span class={cx("wordmark", cls)}>
      <img class="wordmark__light" src="brand/wordmark.svg" alt="Lumenia" draggable={false} />
      <img class="wordmark__dark" src="brand/wordmark-dark.svg" alt="" aria-hidden="true" draggable={false} />
    </span>
  );
}

export type Pose = "wave" | "messenger" | "thumbsup" | "celebrate" | "phone";

const POSE_ALT: Record<Pose, string> = {
  wave: "The Lumenia messenger, waving",
  messenger: "The Lumenia messenger, holding a glowing envelope",
  thumbsup: "The Lumenia messenger, giving a thumbs up",
  celebrate: "The Lumenia messenger, celebrating with both arms up",
  phone: "The Lumenia messenger, holding a phone",
};

/**
 * The messenger, at a beat (brand.md section 9): the hello, a question, a link that is ready, a
 * claim, an empty list. Decorative unless `label` says it carries the screen, so a screen reader is
 * not told the same thing twice.
 */
export function Mascot({
  pose,
  size = "md",
  label = false,
  class: cls,
}: {
  pose: Pose;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  label?: boolean;
  class?: string;
}) {
  return (
    <div class={cx("mascot", `mascot--${size}`, `mascot--${pose}`, cls)}>
      <span class="mascot__halo" aria-hidden="true" />
      {/* The body casts the shadow and the picture inside it fades its feet out. Two elements,
          because a mask clips its own element's filter: on one element the shadow is cut square. */}
      <span class="mascot__body">
        <img class="mascot__img" src={`mascot/${pose}.webp`} alt={label ? POSE_ALT[pose] : ""} draggable={false} />
      </span>
      <span class="mascot__ground" aria-hidden="true" />
    </div>
  );
}

/** A message from the messenger: the landing page's opening bubble, small. */
export function Bubble({ children, class: cls, tail = "down" }: { children: ComponentChildren; class?: string; tail?: "down" | "left" }) {
  return (
    <div class={cx("bubble", `bubble--tail-${tail}`, cls)}>
      <div class="bubble__top">
        <img class="bubble__mark" src="brand/mark-link.webp" alt="" draggable={false} />
        <span class="bubble__time">now</span>
      </div>
      <p class="bubble__text">{children}</p>
      <span class="bubble__tail" aria-hidden="true" />
    </div>
  );
}
