/**
 * The WebExtension API object, whichever name the browser gives it.
 *
 * Firefox exposes `browser` (and `chrome` as an alias); Chrome exposes `chrome`, and `browser` only
 * from version 148. In MV3 both return promises, so one typed object serves both builds and no
 * polyfill is bundled.
 */
export const ext: typeof chrome =
  (globalThis as unknown as { browser?: typeof chrome }).browser ?? (globalThis as unknown as { chrome: typeof chrome }).chrome;

/** True in the Firefox build's runtime (an event page, optional host permissions). */
export function isFirefox(): boolean {
  try {
    return ext.runtime.getURL("").startsWith("moz-extension://");
  } catch {
    return false;
  }
}
