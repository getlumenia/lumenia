/**
 * Put a link into the text field the user picked, on the page they are on.
 *
 * Injected on demand only (activeTab + scripting.executeScript({ func, args })), never declared as
 * a content script, and never on a page the user did not invoke the extension on. It INSERTS text
 * where the caret is and nothing more: it looks at nothing but its own page's host and the box it
 * types into (to tell whether the link landed), returns only that verdict, never reads the
 * clipboard, and never presses Send or Enter. The person sends the message themselves.
 *
 * The function must stand alone: executeScript serialises it and runs it in the page, so it may
 * reference nothing outside its own body (no imports, no helpers, no closures).
 */
export async function insertLinkIntoFocused(link: string, expectedHost: string | null): Promise<{ ok: boolean; how: string }> {
  // The person picked a box on a page with this host. If the frame has since navigated elsewhere,
  // the link is not typed into a page they did not choose.
  if (expectedHost && location.host !== expectedHost) return { ok: false, how: "page-changed" };
  let el = document.activeElement as HTMLElement | null;
  // Follow focus into open shadow roots; some editors live inside one.
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
  if (!el || el === document.body || el === document.documentElement) return { ok: false, how: "no-focused-field" };
  if (el.tagName === "IFRAME") return { ok: false, how: "inside-a-frame" };

  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const field = el;
    if (field.readOnly || field.disabled) return { ok: false, how: "read-only" };
    if (field instanceof HTMLInputElement && !["text", "search", "url", "email", ""].includes(field.type)) {
      return { ok: false, how: "not-a-text-field" };
    }
    const before = field.value;
    field.focus();
    // execCommand keeps the page's own undo history and input events; setRangeText is the fallback.
    if (!document.execCommand("insertText", false, link) || field.value === before) {
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      field.setRangeText(link, start, end, "end");
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: link }));
    }
    return { ok: field.value.includes(link), how: "text-field" };
  }

  if (el.isContentEditable) {
    const editor = el;
    editor.focus();
    const before = editor.textContent ?? "";
    if (document.execCommand("insertText", false, link)) {
      // Rich editors (WhatsApp Web, Telegram Web, Gmail) apply the insert themselves, sometimes a frame
      // later; trusting the command here avoids pasting the link twice.
      return { ok: true, how: "editor" };
    }
    // An editor that refused the command may still take a paste event. Look once more after a frame
    // first, so a late editor update is not mistaken for a refusal.
    await new Promise((r) => setTimeout(r, 50));
    if ((editor.textContent ?? "").includes(link) && !before.includes(link)) return { ok: true, how: "editor" };
    const data = new DataTransfer();
    data.setData("text/plain", link);
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
    return { ok: (editor.textContent ?? "").includes(link), how: "paste-event" };
  }

  return { ok: false, how: "not-editable" };
}
