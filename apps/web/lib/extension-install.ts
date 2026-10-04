/**
 * Where the browser extension installs from: the one place the site reads the two store addresses.
 *
 * Neither listing exists yet, so neither address is known, and none is guessed. A made-up store URL
 * is a button that lands on a 404, or on someone else's extension. Each is a build-time env var
 * instead, and NEXT_PUBLIC_ values are baked into the build, so a store going live is a Vercel env
 * change plus a redeploy:
 *
 *   NEXT_PUBLIC_EXTENSION_CHROME_URL   the Chrome Web Store page. The item is Unlisted, so the store
 *                                      search will not find it; /extension is how people do.
 *   NEXT_PUBLIC_EXTENSION_FIREFOX_URL  optional: where the AMO-signed file is, if not here. The
 *                                      page itself turns "Add to Firefox" on when the signed file
 *                                      is committed at public/extension/lumenia-firefox.xpi
 *                                      (app/(site)/extension/page.tsx); next.config.ts serves it as
 *                                      application/x-xpinstall, which is what makes Firefox offer
 *                                      to install it instead of downloading it.
 *
 * Unset means "not available yet": /extension renders that button disabled and says so.
 */
export interface ExtensionInstallLinks {
  chrome: string | null;
  firefox: string | null;
}

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
    chrome: installHref(process.env.NEXT_PUBLIC_EXTENSION_CHROME_URL),
    firefox: installHref(process.env.NEXT_PUBLIC_EXTENSION_FIREFOX_URL),
  };
}
