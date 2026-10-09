/**
 * Where the browser extension installs from: the one place the site reads the two store addresses.
 *
 * Both listings are public (checked 2026-10-09): the Chrome Web Store item ccdnjnckaldkmjnlpgpmdmnbajmakhmn
 * and the addons.mozilla.org listing "lumenia", both at version 0.1.2. Each address is a build-time
 * env var, and NEXT_PUBLIC_ values are baked into the build, so moving a listing is a Vercel env change
 * plus a redeploy:
 *
 *   NEXT_PUBLIC_EXTENSION_CHROME_URL   the Chrome Web Store page. Unset, the public listing below.
 *   NEXT_PUBLIC_EXTENSION_FIREFOX_URL  the addons.mozilla.org listing, which is where Firefox gets
 *                                      updates from. Unset, /extension falls back to the AMO-signed
 *                                      file committed at public/extension/lumenia-firefox.xpi (an
 *                                      older unlisted build with no update channel), which
 *                                      next.config.ts serves as application/x-xpinstall so Firefox
 *                                      offers to install it rather than download it.
 *
 * A value that is not an https address (or a path on this site) counts as unset.
 */
export interface ExtensionInstallLinks {
  /** Always an address: the env var's, or the public listing. */
  chrome: string;
  /** The env var's address, or null when it is unset (the page then decides the fallback). */
  firefox: string | null;
}

/** The public Chrome Web Store listing, the default for "Add to Chrome" when no env var names another. */
export const CHROME_WEB_STORE_URL =
  "https://chromewebstore.google.com/detail/lumenia-send-dollars-by-l/ccdnjnckaldkmjnlpgpmdmnbajmakhmn";

/** The public addons.mozilla.org listing: the value NEXT_PUBLIC_EXTENSION_FIREFOX_URL should carry. */
export const AMO_LISTING_URL = "https://addons.mozilla.org/firefox/addon/lumenia/";

/**
 * An https address, or a path on this site (the self-hosted Firefox file). Anything else, such as a
 * placeholder left in the env or a `javascript:` URL, counts as unset: a disabled button is a better
 * failure than a live one pointing somewhere wrong.
 */
function installHref(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

export function extensionInstallLinks(): ExtensionInstallLinks {
  return {
    // Spelled out in full on purpose: Next inlines a NEXT_PUBLIC_ value only where its whole name
    // is written as process.env.NAME, never through a computed key.
    chrome: installHref(process.env.NEXT_PUBLIC_EXTENSION_CHROME_URL) ?? CHROME_WEB_STORE_URL,
    // No default here: unset means the page's own fallback (the hosted file), decided where the file is.
    firefox: installHref(process.env.NEXT_PUBLIC_EXTENSION_FIREFOX_URL),
  };
}
