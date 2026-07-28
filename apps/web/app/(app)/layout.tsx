/**
 * (app) route group layout — wraps the logged-in money surfaces (/home, /send, /request, /r, /sent,
 * /unlock, /account, /activity) in the single WalletProvider context + the AppShell.
 *
 * The group is on the LOCKED Periwinkle system (brand.md §4): the same self-hosted Sentient + Switzer
 * and the same next-themes light/dark the (site) group uses, plus the `.app-pw` token scope that
 * flips the app's Tailwind brand utilities to Periwinkle WITHOUT touching the global :root tokens the
 * FROZEN claim route renders against (see components/site/app-theme.css). The claim route /c/[id]
 * lives OUTSIDE this group, so it gets neither the provider, the shell, nor the theme — and stays
 * lean + byte-identical.
 */
import type { Metadata, Viewport } from "next";
import "../../components/site/fonts.css";
import "../../components/site/app-theme.css";
import { WalletProvider } from "../../lib/wallet";
import { ThemeProvider } from "../../components/site/ThemeProvider";
import { AppShell } from "../../components/brand/AppShell";

/**
 * Money surfaces are never indexed. robots.txt already Disallows them, but a
 * Disallow alone can leave a link-discovered URL indexed (URL-only, no crawl) —
 * this meta is the belt-and-braces the repo already applies on /request + /r.
 * The pages themselves are client components (no metadata exports), so the group
 * layout is the one place this can live. Title default covers them all.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: { default: "Lumenia", template: "%s | Lumenia" },
};

/**
 * `maximumScale: 5` undoes the root's `maximumScale: 1` (renders as user-scalable=no — a WCAG
 * failure) for this group only, the same scoped override `(site)/layout.tsx` carries and for the
 * same reason: the root also wraps the frozen claim route, which is not in this task's blast radius.
 * Money surfaces are exactly where people zoom.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F5F3EF" },
    { media: "(prefers-color-scheme: dark)", color: "#15121C" },
  ],
  maximumScale: 5,
  // Lets the bottom money action bar's env(safe-area-inset-bottom) resolve, so it
  // clears the iOS home indicator instead of sitting under it.
  viewportFit: "cover",
};

export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <WalletProvider>
        <AppShell>{children}</AppShell>
      </WalletProvider>
    </ThemeProvider>
  );
}
