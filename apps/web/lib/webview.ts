/**
 * Where is this page running: a real browser, or an app's built-in one?
 *
 * WHY IT MATTERS HERE. A v2 claim keeps the only key to the money in this page's IndexedDB
 * (lib/keystore.ts savePhase1), and an in-app browser (WhatsApp, Instagram, Telegram, Facebook,
 * LinkedIn, X and the like) has its own storage partition: on iOS always, on Android when the app
 * uses a WebView rather than Chrome's custom tab. A recipient who claims inside one and later opens
 * getlumenia.com in Safari or Chrome finds no account, and the host app may clear the partition at
 * any time (review W3). The claim screen uses this to say which browser holds the key, to put the
 * backup before "See my money", and on Android to offer the link in Chrome before the tap
 * (CLAUDE.md: Android intent:// is the reliable escape, iOS is best effort and the claim completes
 * inside the webview rather than sending anyone away).
 *
 * A HEURISTIC, AND A CONSERVATIVE ONE. User agents are not a contract: an app can send anything, and
 * two in-app browsers can look like Safari. The rule flags only what is known to be an in-app
 * browser (an app's own token, or the generic WebView signatures: no `Safari/` token on an iPhone,
 * `; wv)` or `Version/x.y ... Chrome/` on Android) and treats everything else as a real browser.
 * Known misses, on purpose: iOS apps that open links in SFSafariViewController (a Safari user agent,
 * and since iOS 11 its own data store), and apps with no token of their own. A miss costs a missing
 * notice; a false positive would tell a Safari user to leave Safari, which is why the rule says
 * nothing it cannot support. Pure, so test:claimhome holds it against real user-agent strings.
 */
export type InAppOs = "ios" | "android" | "other";

export interface InAppBrowser {
  /** Who owns the built-in browser, for copy: "WhatsApp", "Instagram", ... or "an app" when only the shape says so. */
  app: string;
  os: InAppOs;
}

/** The app tokens that name an in-app browser outright. Order matters only for apps that embed another's token. */
const KNOWN_APPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bFBAN\b|\bFBAV\b|\bFB_IAB\b|\bFBIOS\b|\bFB4A\b/, "Facebook"],
  [/\bInstagram\b/, "Instagram"],
  [/\bWhatsApp\b/, "WhatsApp"],
  [/\bTelegram\b/i, "Telegram"],
  [/\bLinkedInApp\b/, "LinkedIn"],
  [/\bTwitter(?:Android| for iPhone)?\b/, "X"],
  [/\bSnapchat\b/, "Snapchat"],
  [/\bmusical_ly\b|\bTikTok\b|\bBytedanceWebview\b/, "TikTok"],
  [/\bLine\//, "LINE"],
  [/\bGSA\//, "the Google app"],
];

export function osOf(ua: string): InAppOs {
  if (/\b(?:iPhone|iPad|iPod)\b/.test(ua)) return "ios";
  if (/\bAndroid\b/.test(ua)) return "android";
  return "other";
}

/**
 * The in-app browser this user agent names, or null for a real browser (and for anything unsure).
 * `standalone` is iOS's navigator.standalone: a home-screen web app also has no `Safari/` token and
 * is not an in-app browser.
 */
export function detectInAppBrowser(ua: string, opts: { standalone?: boolean } = {}): InAppBrowser | null {
  if (!ua) return null;
  const os = osOf(ua);
  for (const [re, app] of KNOWN_APPS) if (re.test(ua)) return { app, os };
  if (os === "android") {
    /* Android's WebView says so ("; wv)"), or carries the "Version/4.0" token no Chrome does. A
       Chrome custom tab (what WhatsApp and Telegram open on Android) is plain Chrome, with Chrome's
       storage, and is left alone. */
    if (/;\s*wv\)/.test(ua) || /\bVersion\/\d+(?:\.\d+)*\b.*\bChrome\//.test(ua)) return { app: "an app", os };
    return null;
  }
  if (os === "ios") {
    /* WKWebView: WebKit on an iPhone with no `Safari/` token. Safari, Chrome, Firefox and Edge on
       iOS all carry it; a home-screen web app does not, and is told apart by `standalone`. */
    if (opts.standalone) return null;
    if (/\bAppleWebKit\b/.test(ua) && !/\bSafari\//.test(ua)) return { app: "an app", os };
    return null;
  }
  return null;
}

/** The browser a person on this OS opens links in by themselves, for copy. */
export function hostBrowserName(os: InAppOs): string {
  return os === "ios" ? "Safari" : os === "android" ? "Chrome" : "your browser";
}

/** "WhatsApp's built-in browser", or "this app's built-in browser" when only the shape says so. */
export function holderName(inApp: InAppBrowser): string {
  return inApp.app === "an app" ? "this app's built-in browser" : `${inApp.app}'s built-in browser`;
}

/**
 * The same page as an Android intent, which an app's WebView hands to Chrome.
 *
 * Android's Intent.parseUri takes everything before the LAST `#` as the page, so the fragment, the
 * only place a link's key may live, travels with it and still reaches no server. Pinned to Chrome,
 * which every Play-certified device carries; without Chrome the fallback loads the plain URL where
 * the person already is. The format is Android's documented one; the hand-off was not run on a
 * device from this code (UNVERIFIED on a device).
 */
export function androidIntentHref(url: string): string {
  const u = new URL(url);
  const scheme = u.protocol.replace(/:$/, "");
  return (
    `intent://${u.host}${u.pathname}${u.search}${u.hash}` +
    `#Intent;scheme=${scheme};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`
  );
}

export type DoneScreenPlan =
  | { inApp: false }
  | {
      inApp: true;
      /** "WhatsApp's built-in browser": where the key was saved. */
      holder: string;
      /** "Safari" / "Chrome" / "your browser": where the person will look for the money later. */
      browser: string;
      /** How to get them there: an Android intent, or copying the address by hand (iOS, and anything else). */
      escape: "intent" | "copy";
    };

/** What the success screen adds, and in which order, once the money has landed in this context. */
export function doneScreenPlan(inApp: InAppBrowser | null): DoneScreenPlan {
  if (!inApp) return { inApp: false };
  return {
    inApp: true,
    holder: holderName(inApp),
    browser: hostBrowserName(inApp.os),
    escape: inApp.os === "android" ? "intent" : "copy",
  };
}

/** The one sentence that names which browser holds the key. Kept here so the test can hold it. */
export function keyHolderNotice(plan: DoneScreenPlan): string | null {
  if (!plan.inApp) return null;
  return `Your money's key is kept in ${plan.holder}, not in ${plan.browser}. Back it up now, so you can open your money anywhere.`;
}

/** The pre-claim offer on Android: open the link in Chrome, where the key will be kept. */
export function escapeOffer(inApp: InAppBrowser | null): string | null {
  if (!inApp || inApp.os !== "android") return null;
  return `You're in ${holderName(inApp)}. Open this link in Chrome instead, so your money is kept where you can always find it.`;
}
