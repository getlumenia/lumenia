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

/** The network the popup is on: calm for practice money, in the accent for real money. */
export function NetChip({ net, onClick }: { net: NetId; onClick: () => void }) {
  const real = net === "public";
  const label = real ? "Real money" : "Practice money";
  return (
    <button
      type="button"
      class={cx("chip", real && "chip--real")}
      onClick={onClick}
      aria-label={`${label}. Open settings to change.`}
      title="Open settings"
    >
      <span class="chip__dot" aria-hidden="true" />
      {label}
    </button>
  );
}

/** The header of the screens before there is an account to talk about: the wordmark alone. */
export function BrandBar() {
  return (
    <header class="bar">
      <span class="wordmark">Lumenia</span>
    </header>
  );
}

/** The header of the home screens: wordmark, which money, and the two places to go. */
export function TopBar({ net, onLinks, onSettings }: { net: NetId; onLinks: () => void; onSettings: () => void }) {
  return (
    <header class="bar">
      <span class="wordmark">Lumenia</span>
      <NetChip net={net} onClick={onSettings} />
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
export function CheckBadge() {
  return (
    <span class="badge" aria-hidden="true">
      <IconCheck />
    </span>
  );
}
