/**
 * "Paste a Lumenia link here": the context-menu item on editable fields, and the popup's "Paste
 * into the page" button.
 *
 * A right-click on a text field grants activeTab for that tab (a user gesture); the target is kept
 * in storage.session for ten minutes while the person makes the link, and the link is inserted the
 * moment the deposit is confirmed. Without a pending target the popup's button pastes into the
 * focused field of the active tab, which the toolbar click also granted.
 */
import { PENDING_INSERT_MS } from "../config";
import { ext } from "../lib/browser";
import { fail } from "../lib/errors";
import { K, session } from "../lib/storage";
import { insertLinkIntoFocused } from "../content/insert";

export const MENU_ID = "lumenia-paste-link";

export interface PendingInsert {
  tabId: number;
  frameId: number;
  /** the top page's host, shown in the popup's banner */
  host: string;
  /** the host of the frame that holds the box (the top page's when it is not in a frame) */
  frameHost?: string;
  at: number;
}

export function createMenus(): void {
  try {
    ext.contextMenus.removeAll(() => {
      ext.contextMenus.create({ id: MENU_ID, title: "Paste a Lumenia link here", contexts: ["editable"] }, () => {
        void ext.runtime.lastError; // a duplicate id after a fast restart is harmless
      });
    });
  } catch {
    /* menus are unavailable in this context */
  }
}

const hostOf = (url: string | undefined): string => {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
};

export async function readPendingInsert(now = Date.now()): Promise<PendingInsert | null> {
  const p = await session().get<PendingInsert>(K.pendingInsert);
  if (!p) return null;
  if (now - p.at > PENDING_INSERT_MS) {
    await clearPendingInsert();
    return null;
  }
  return p;
}

export async function clearPendingInsert(): Promise<void> {
  await session().remove(K.pendingInsert);
  try {
    await ext.action.setBadgeText({ text: "" });
  } catch {
    /* no badge */
  }
}

/**
 * The context-menu click: open the popup, remember where to paste, and mark the button.
 *
 * openPopup() is called FIRST, before anything is awaited: Firefox before 149 opens a popup only
 * while the click's user gesture is still current, and an await would spend it. The popup reads
 * the pending target when it asks for its state, which lands after this write in practice; if the
 * popup does not open at all, the badge asks for a click on the toolbar button.
 */
export async function onMenuClicked(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined || tab.id < 0) return;
  let opening: Promise<void>;
  try {
    opening = Promise.resolve(ext.action.openPopup()).then(() => undefined);
  } catch {
    opening = Promise.resolve();
  }
  const host = hostOf(tab.url ?? info.pageUrl);
  const pending: PendingInsert = {
    tabId: tab.id,
    frameId: info.frameId ?? 0,
    host,
    frameHost: info.frameUrl ? hostOf(info.frameUrl) : host,
    at: Date.now(),
  };
  await session().set({ [K.pendingInsert]: pending });
  try {
    await ext.action.setBadgeBackgroundColor({ color: "#6E5FCE" });
    await ext.action.setBadgeText({ text: "1" });
  } catch {
    /* no badge */
  }
  await opening.catch(() => {
    /* Not every browser opens the popup from here; the badge asks for a click on the button. */
  });
}

async function activeTarget(): Promise<{ tabId: number; frameId?: number } | null> {
  const [tab] = await ext.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id !== undefined && tab.id >= 0 ? { tabId: tab.id } : null;
}

/** Insert `link` into the pending target, or the active tab's focused field. */
export async function insertLink(link: string, opts: { pendingOnly?: boolean } = {}): Promise<{ inserted: boolean; how?: string }> {
  const pending = await readPendingInsert();
  const target = pending ? { tabId: pending.tabId, frameId: pending.frameId } : opts.pendingOnly ? null : await activeTarget();
  if (!target) return { inserted: false, how: "no-target" };
  // A box picked from the menu must still be on the page it was picked on (the injected function
  // checks its own frame's host); the toolbar button pastes into the page that is open right now.
  const expectedHost = pending ? pending.frameHost || pending.host || null : null;
  try {
    const results = await ext.scripting.executeScript({
      target: { tabId: target.tabId, ...(target.frameId !== undefined ? { frameIds: [target.frameId] } : {}) },
      func: insertLinkIntoFocused,
      args: [link, expectedHost],
    });
    const out = results?.[0]?.result as { ok?: boolean; how?: string } | undefined;
    if (pending) await clearPendingInsert();
    return { inserted: out?.ok === true, how: out?.how };
  } catch {
    if (pending) await clearPendingInsert();
    throw fail("insert-failed");
  }
}
