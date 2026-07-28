"use client";

/**
 * AppShell — the Periwinkle chrome for the logged-in money surfaces. A sticky top nav (wordmark home
 * link + Home/Activity/Account + a notifications bell with a ledger-derived unread dot + the theme
 * toggle) over the `.app-pw` scope; the claim page deliberately has NO shell and lives outside this
 * group. Phone-first max-w-md column.
 *
 * Wraps everything in `.app-pw` so the token override in app-theme.css turns the whole group
 * Periwinkle without any component rewrite. The unread count is DERIVED from the public ledger
 * (lib/notifications) — no server, no push subscription.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, LifeBuoy, Send, HandCoins } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { loadUnreadCount } from "../../lib/notifications";
import { TestnetBanner } from "./TestnetBanner";
import { ThemeToggle } from "../site/ThemeToggle";
import { FeedbackDialog } from "../FeedbackDialog";
import { copy } from "../../lib/copy";

const NAV = [
  { href: "/home", label: "Home" },
  { href: "/activity", label: "Activity" },
  { href: "/account", label: "Account" },
];

function NotificationsBell() {
  const { account } = useWallet();
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!account) return setUnread(0);
    let live = true;
    const refresh = () =>
      void loadUnreadCount(account.address).then((n) => {
        if (live) setUnread(n);
      });
    refresh();
    // Visibility-gated foreground poll: while the tab is open, money that arrives (a
    // paid request / a direct transfer) surfaces on the bell within ~15s WITHOUT a
    // manual reopen. Web Push is deferred (no service worker, iOS PWA install gate,
    // and no server-side money-arrival event — "waiting" is derived from Horizon
    // client-side); closed-app reach is the WhatsApp channel's job. Pauses when the
    // tab is hidden (battery + Horizon rate limits).
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 15000);
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      live = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
    // re-check on route change too (e.g. after collecting on /notifications the dot clears)
  }, [account, pathname]);

  return (
    <Link
      href="/notifications"
      className="relative grid size-9 place-items-center rounded-lg text-ink-soft transition-colors hover:text-ink"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
    >
      <Bell className="size-[18px]" />
      {unread > 0 && (
        <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-money ring-2 ring-[var(--paper)]" />
      )}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="app-pw">
      <TestnetBanner />
      <header className="app-nav">
        <div className="app-nav-inner">
          <Link href="/home" aria-label="Lumenia home">
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
            <NotificationsBell />
            {/* Report-a-problem is one tap away on EVERY money surface (owner directive) —
                a life-buoy next to the bell, opening the portaled FeedbackDialog. */}
            <FeedbackDialog
              trigger={<LifeBuoy className="size-[18px]" />}
              triggerClassName="fb-trigger-nav"
              triggerAriaLabel={copy.feedback.linkLabel}
              defaultCategory="money"
            />
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <div className="app-content mx-auto max-w-md px-5">{children}</div>
      <MoneyActionBar />
    </div>
  );
}

/**
 * The persistent money verbs. The top bar holds DESTINATIONS (Home/Activity/Account);
 * the two ACTIONS live at the bottom, in the thumb zone, reachable from every list
 * surface — so a person on /activity or /account can start a Send or an Ask in one
 * tap instead of routing back to Home (the old dead-end). Kept to the two verbs
 * (Send = hero, Ask = the retention loop); People/Split stay on Home, never a FAB
 * (its expand animation would pull Motion into the bundle). Plain <Link>s + inline
 * lucide SVG + CSS only. Hidden on the action FLOWS themselves (/send, /request, /r,
 * /sent, /unlock) — redundant there, and it keeps the bar off screens with an amount
 * input where a fixed bottom bar would fight the keyboard. Also hidden on /home,
 * which already has the richer Send/Ask/People action grid — the bar's job is to
 * follow the two verbs onto the DEEP pages (/activity, /account, /contacts,
 * /notifications, /split) that otherwise dead-end.
 */
const HIDE_ACTIONBAR = ["/home", "/send", "/request", "/r/", "/sent/", "/unlock"];

function MoneyActionBar() {
  const pathname = usePathname();
  const { account } = useWallet();
  // Only for a logged-in person on a list surface — a no-account visitor sees the
  // honest empty state, not action chrome.
  if (!account) return null;
  if (HIDE_ACTIONBAR.some((p) => pathname === p || pathname.startsWith(p))) return null;
  return (
    <nav className="app-actionbar" aria-label="Money actions">
      <Link href="/request" className="app-actionbar-btn app-actionbar-ask">
        <HandCoins className="size-5" aria-hidden="true" />
        Ask
      </Link>
      <Link href="/send" className="app-actionbar-btn app-actionbar-send">
        <Send className="size-5" aria-hidden="true" />
        Send
      </Link>
    </nav>
  );
}
