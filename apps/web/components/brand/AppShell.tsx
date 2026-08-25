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
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, LifeBuoy, Send, HandCoins } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { loadUnreadCount } from "../../lib/notifications";
import { TestnetBanner } from "./TestnetBanner";
import { FeedbackDialog } from "../FeedbackDialog";
import { copy } from "../../lib/copy";
import { AccountMenu } from "./AccountMenu";
import { ToastHost } from "./Toast";

/**
 * PLACES, and only places. "Account" used to be here and is now the first row of the account menu:
 * it was never a peer of Home and Activity — it is where you go to look after yourself, which is
 * exactly what the menu on the right is for. Two links is also what actually fits next to a
 * wordmark, three controls and a call to action on a 375px phone.
 */
const NAV: { href: string; label: string; optional?: boolean }[] = [
  // `optional` = dropped on the narrowest phones, where the wordmark next to it already goes home
  // and the alternative is trimming something that has no substitute.
  { href: "/home", label: "Home", optional: true },
  { href: "/activity", label: "Activity" },
];

/**
 * The one call to action in the nav. It appears ONLY while sending is still blocked and disappears
 * the moment it is not: a permanent link would tax every user forever to help the few in their
 * first hour. Receiving never needs any of it, so an account that only ever claims money never
 * sees it.
 *
 * It says "Activate", not "Set up". The old label named the machinery — a chore — where this names
 * turning the account on, which is the only reason any of those steps exist; the full sentence
 * rides along as the title and the accessible name, because the pill has room for one word. It is
 * also not a nav link any more but a CTA pill: it is a task, not a place, and a plain grey link at
 * the end of a full row was invisible on dark the moment the row had to trim it.
 */
function StartSendingLink() {
  const { status, account, network, pilotState } = useWallet();
  const pathname = usePathname();
  if (status === "loading" || !account) return null;
  const ready = account.phase === 2 && network === "public" && pilotState === "approved";
  if (ready) return null;
  return (
    <Link
      href="/start"
      className="app-nav-cta"
      data-active={pathname === "/start"}
      /* The pill has room for one word; the sentence it stands for goes to anyone who needs it
         spelled out, and to every screen reader. */
      title="Activate your account so you can send money"
      aria-label="Activate your account so you can send money"
    >
      Activate
    </Link>
  );
}

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
      className="app-nav-icon relative"
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
  const links = useRef<HTMLElement>(null);

  /**
   * Keep the CURRENT page's label fully on screen.
   *
   * The link row scrolls rather than wrapping when it runs out of room (which happens on a small
   * phone while the temporary "Set up" link is showing). A scroll container starts at its left
   * edge, so the label that got clipped was the rightmost one — usually the page you are actually
   * on, which is the single worst one to cut in half. This nudges it into view instead.
   */
  useEffect(() => {
    const row = links.current;
    if (!row) return;
    const measure = () => {
      const overflowing = row.scrollWidth > row.clientWidth + 1;
      // Drives a soft fade at the edges (app-theme.css), so a label that had to be cut reads as
      // "there is more this way" instead of as a broken layout.
      row.dataset.overflow = String(overflowing);
      if (!overflowing) return;
      row.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest", inline: "end" });
    };
    measure();
    // Rotating a phone changes the answer, and so does the temporary "Set up" link appearing.
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [pathname]);
  /**
   * The welcome screen is the one surface that gets the chrome taken away.
   *
   * It asks exactly one question at a time, and a nav bar plus a Send/Ask action bar answer three
   * other questions over the top of it — including "send money", which a person who has not
   * finished arriving cannot do yet. The escape hatch is not lost: every step of /welcome carries
   * its own "Skip for now", which is a better exit than a nav link because it also records that
   * they have been here.
   */
  const onboarding = pathname === "/welcome";
  return (
    <div className="app-pw">
      <TestnetBanner />
      <header className="app-nav">
        <div className="app-nav-inner">
          <Link href="/home" className="app-nav-brand" aria-label="Lumenia home">
            {/* Wordmark swaps per theme (paper-filled counters only read on light). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand-kit-assets/logo-wordmark-t.svg" alt="Lumenia" className="app-wordmark site-wordmark-light" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand-kit-assets/logo-wordmark-dark.svg" alt="" className="app-wordmark site-wordmark-dark" />
          </Link>
          {!onboarding && (
          <nav className="app-nav-links" ref={links}>
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="app-nav-link"
                data-optional={n.optional ? "true" : undefined}
                data-active={pathname === n.href}
                aria-current={pathname === n.href ? "page" : undefined}
              >
                {n.label}
              </Link>
            ))}
            <StartSendingLink />
          </nav>
          )}
          {/* Utilities, kept in their own group. Three controls that are NOT navigation were sitting
              in the same row as the four that are, in three different button shapes — so the row read
              as seven equal things and none of them looked deliberate. Grouping them behind a hairline
              lets one CSS rule give all three the same size, radius, hover and focus ring, whatever
              each component's own classes happen to be. */}
          {!onboarding && (
          <div className="app-nav-tools">
            <NotificationsBell />
            {/* Report-a-problem is one tap away on EVERY money surface (owner directive) —
                a life-buoy next to the bell, opening the portaled FeedbackDialog. */}
            <FeedbackDialog
              trigger={<LifeBuoy className="size-[18px]" />}
              triggerClassName="fb-trigger-nav"
              triggerAriaLabel={copy.feedback.linkLabel}
              defaultCategory="money"
            />
            {/* Everything about YOU — name, accounts, settings, appearance, and leaving this
                device — behind one control. Leaving used to be three disclosures deep inside a page
                about balances; it is now one tap from every screen, which is what it should always
                have been for a product whose keys live on the phone. */}
            <AccountMenu />
            {/* The theme switch used to sit here and no longer does. Measured, not guessed: the row
                needs 257px for its links and has 193px even on a 430px phone, so something had to
                leave, and this was the only control that is (a) a preference rather than something
                time-sensitive and (b) already present twice — Settings → Appearance and Account →
                Appearance both carry a live toggle, and the default still follows the phone. The
                bell announces money arriving and the life-buoy is one tap from every money surface
                by owner directive; neither can be the one to go. */}
          </div>
          )}
        </div>
      </header>
      <div className={`app-content mx-auto max-w-md px-5${onboarding ? " app-content-onb" : ""}`}>{children}</div>
      <MoneyActionBar />
      {/* Outside every chrome guard on purpose: the switch between practice and real money is
          confirmed here, and it is confirmed on /welcome too — where there is no chrome at all. */}
      <ToastHost />
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
/** Surfaces that carry their own primary action, so a second one below would compete with it.
 *  `/welcome` is here for a stronger reason: it asks one question at a time, and "Send" is not
 *  something a person who has not finished arriving can do yet. */
const HIDE_ACTIONBAR = ["/home", "/send", "/request", "/r/", "/sent/", "/unlock", "/welcome"];

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
