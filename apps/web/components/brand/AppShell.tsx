"use client";

/**
 * AppShell — the Periwinkle chrome for the logged-in money surfaces. A sticky top nav (wordmark home
 * link + Home/Activity/Account + the theme toggle) over the `.app-pw` scope; the claim page
 * deliberately has NO shell and lives outside this group. Phone-first max-w-md column.
 *
 * Wraps everything in `.app-pw` so the token override in app-theme.css turns the whole group
 * Periwinkle without any component rewrite.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { TestnetBanner } from "./TestnetBanner";
import { ThemeToggle } from "../site/ThemeToggle";

const NAV = [
  { href: "/home", label: "Home" },
  { href: "/activity", label: "Activity" },
  { href: "/account", label: "Account" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="app-pw">
      <TestnetBanner />
      <header className="app-nav">
        <div className="app-nav-inner">
          <Link href="/home" aria-label="Lumenia — home">
            {/* Wordmark swaps per theme (paper-filled counters only read on light). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand-kit-assets/logo-wordmark-t.svg" alt="Lumenia" className="app-wordmark site-wordmark-light" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand-kit-assets/logo-wordmark-dark.svg" alt="" className="app-wordmark site-wordmark-dark" />
          </Link>
          <nav className="app-nav-links">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="app-nav-link"
                data-active={pathname === n.href}
              >
                {n.label}
              </Link>
            ))}
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-md px-5 pb-16">{children}</div>
    </div>
  );
}
