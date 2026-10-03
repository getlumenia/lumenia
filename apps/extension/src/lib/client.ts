/**
 * The popup's side of the contract: one typed call per request, and a live view of the records.
 *
 * The popup never holds a key, never signs and never talks to the network itself; it asks the
 * background worker, which keeps going when Chrome closes the popup on a focus change (it does so
 * on every click outside it, and a send can take a minute).
 */
import { ext } from "./browser";
import type { RequestOf, RequestType, ResponseMap } from "./messages";
import type { Result } from "./types";

/** Ask the worker. A worker that went away mid-request answers `internal`; the caller re-reads state. */
export async function call<T extends RequestType>(req: RequestOf<T>): Promise<Result<ResponseMap[T]>> {
  try {
    const res = (await ext.runtime.sendMessage(req)) as Result<ResponseMap[T]> | undefined;
    if (!res || typeof res !== "object" || typeof (res as { ok?: unknown }).ok !== "boolean") {
      return { ok: false, code: "internal", message: "The extension did not answer. Try again." };
    }
    return res;
  } catch {
    return { ok: false, code: "internal", message: "The extension did not answer. Try again." };
  }
}

/**
 * Keep the worker awake while the popup is open (an open port counts as activity), and let it know
 * when the popup closes. Returns the disconnect function.
 */
export function holdOpen(): () => void {
  try {
    const port = ext.runtime.connect({ name: "popup" });
    return () => {
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
    };
  } catch {
    return () => {};
  }
}

/**
 * Call `onChange` whenever a link record changes. Listens to the LOCAL area only: the session
 * area holds the unlocked key, and the popup has no reason to be handed it in a change event.
 */
export function onLinksChanged(onChange: () => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
    if (Object.keys(changes).some((k) => k.startsWith("links:") || k === "settings")) onChange();
  };
  // The LOCAL area's own event (every browser this extension supports has it). There is
  // deliberately no fallback to storage.onChanged: that one also carries the session area, where
  // the unlocked key lives, and the popup has no reason to be handed it.
  const local = ext.storage.local as typeof ext.storage.local & {
    onChanged?: chrome.events.Event<(changes: Record<string, chrome.storage.StorageChange>) => void>;
  };
  if (!local.onChanged) return () => {};
  local.onChanged.addListener(handler);
  return () => local.onChanged?.removeListener(handler);
}
