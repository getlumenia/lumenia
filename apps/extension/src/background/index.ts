/**
 * The background entry: Chrome's service worker, Firefox's event page.
 *
 * Every listener is registered synchronously at the top level, as MV3 requires: a worker that wakes
 * for an event finds its handler only if it was added during the first turn of the script.
 *
 * On every start the worker (1) keeps storage.session away from content scripts, (2) locks a session
 * whose deadline passed while it slept, (3) forgets a `sending` flag left by a worker that died
 * mid-send (the record that send kept is then finished by the settle loop, by reading the escrow),
 * and (4) runs one settle pass.
 */
import { ext } from "../lib/browser";
import { K, session } from "../lib/storage";
import { AUTOLOCK_ALARM, isUnlockedNow, lock } from "./account";
import { createMenus, onMenuClicked } from "./insert";
import { ensureSettleAlarm, route, runSettle } from "./router";
import { SETTLE_ALARM } from "./settle";

ext.runtime.onInstalled.addListener(() => {
  createMenus();
});

ext.runtime.onStartup?.addListener(() => {
  createMenus();
});

// Firefox for Android has no context menus; a missing API must not stop the listeners below.
ext.contextMenus?.onClicked.addListener((info, tab) => {
  void onMenuClicked(info, tab);
});

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOLOCK_ALARM) void lock();
  if (alarm.name === SETTLE_ALARM) void runSettle();
});

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  void route(msg, sender).then(sendResponse);
  return true; // the answer is sent asynchronously (Chrome and Firefox both honour this form)
});

// The popup holds a port open while it is visible; an open port is activity, nothing more is needed.
ext.runtime.onConnect.addListener((port) => {
  if (port.sender?.id !== ext.runtime.id) port.disconnect();
});

async function boot(): Promise<void> {
  try {
    // Chrome's default already excludes content scripts; saying it explicitly costs nothing.
    await (ext.storage.session as chrome.storage.StorageArea & {
      setAccessLevel?: (o: { accessLevel: string }) => Promise<void>;
    }).setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    /* Firefox's session area is not reachable from content scripts either */
  }
  await isUnlockedNow(); // locks an expired session
  await session().remove(K.sending);
  await ensureSettleAlarm();
  await runSettle().catch(() => undefined);
}

void boot();
