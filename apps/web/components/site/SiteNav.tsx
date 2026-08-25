/**
 * SiteNav — the (site) group's persistent top nav. A 3-column grid keeps the links optically
 * centered (logo left · links centre · actions right). Each link has an animated underline + color
 * hover. Built on the `.site-theme` Periwinkle scope so it stays on-brand.
 *
 * On the landing the pill chrome, wordmark and links start hidden and slide + fade in (Motion) once
 * you scroll past the immersive opening hero, which carries its own wordmark and must not be covered.
 * The primary CTA (the actions cell) is EXEMPT from that gate — a money product should always offer a
 * way to convert — so it is painted on first load and the pill materializes around it on scroll.
 * Every other route in the group opens on ordinary content with no wordmark of its own, so the nav is
 * simply there — the scroll gate would leave those pages chrome-less until you scrolled, with no way
 * back to the site.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./ThemeToggle";

const LINKS = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/about", label: "About" },
  { href: "/developers", label: "Developers" },
];

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="group relative rounded-lg px-3 py-1.5 text-sm font-medium text-foreground/70 transition-colors duration-200 hover:text-foreground"
    >
      {label}
      <span className="pointer-events-none absolute inset-x-3 bottom-1 h-0.5 origin-left scale-x-0 rounded-full bg-primary/80 transition-transform duration-300 ease-out group-hover:scale-x-100" />
    </Link>
  );
}

export function SiteNav() {
  // The landing is the only route with an opening hero to clear, so it is the only one that gates.
  const gated = usePathname() === "/";
  const [scrolledPastHero, setScrolledPastHero] = useState(false);
  const shown = !gated || scrolledPastHero;

  /* Whether this device already holds an account. Read once, from the keystore, after mount — the
     marketing shell has no WalletProvider and the record lives in IndexedDB, so there is nothing
     synchronous to read. It stays false until the answer arrives, which means a first-time visitor
     (the overwhelming majority here, and the one we cannot afford to confuse) never sees a flash of
     the returning-user door. Failure is treated as "no account" for the same reason. */
  const [hasAccount, setHasAccount] = useState(false);
  useEffect(() => {
    let alive = true;
    import("../../lib/keystore")
      .then((m) => m.getHome())
      .then((home) => {
        if (alive && home) setHasAccount(true);
      })
      .catch(() => {
        /* no keystore, blocked storage, private mode — treat as a new visitor */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!gated) return;
    const onScroll = () => setScrolledPastHero(window.scrollY > window.innerHeight * 1.35);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [gated]);

  return (
    // The header spans the top edge but is click-through (pointer-events-none); each cell re-enables
    // its own pointer events, so the hero beneath the invisible gated chrome is never blocked.
    <header className="site-theme pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
      {/* The width tracks the sections' own large-screen growth (see the large-screen block in
          landing.css). Capped at max-w-5xl the bar shrank to ~40% of a 2560 display while the
          content beneath it grew past — the nav read as a lost little pill. Below ~1770px this
          resolves to exactly max-w-5xl, so nothing changes at the sizes it was designed at. */}
      {/* Two columns on phones, three from md.
          The links in the middle are `hidden` below md — and a display:none grid item does not take
          a cell, so with three columns declared the ACTIONS were auto-placed into the middle one and
          the third sat empty. The bar read as logo-left, buttons-adrift-in-the-middle, nothing right.
          Declaring the columns the page actually has puts the actions back on the right edge. */}
      <nav className="relative grid w-full max-w-[clamp(64rem,58vw,90rem)] grid-cols-[1fr_auto] md:grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 py-2.5">
        {/* The pill's chrome lives on its own gated layer so it can fade with the wordmark/links while
            the actions cell painted above it stays visible. Decorative — the cells carry the clicks. */}
        <motion.div
          aria-hidden
          className="absolute inset-0 rounded-2xl border border-border/70 bg-background/75 shadow-[0_16px_44px_-24px_rgba(110,95,206,0.55)] backdrop-blur-xl"
          initial={false}
          animate={shown ? { y: 0, opacity: 1 } : { y: -22, opacity: 0 }}
          transition={{ duration: 0.5, ease: [0.2, 0.7, 0.2, 1] }}
          style={{ pointerEvents: shown ? "auto" : "none" }}
        />

        <motion.div
          className="relative justify-self-start"
          initial={false}
          animate={shown ? { y: 0, opacity: 1 } : { y: -22, opacity: 0 }}
          transition={{ duration: 0.5, ease: [0.2, 0.7, 0.2, 1] }}
          style={{ pointerEvents: shown ? "auto" : "none" }}
        >
          <Link href="/" className="group block px-1" aria-label="Lumenia home">
            {/* Wordmark swaps per theme (paper-filled counters only read on light). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand-kit-assets/logo-wordmark-t.svg" alt="" className="site-wordmark-light h-5 w-auto transition-transform duration-300 group-hover:scale-[1.04]" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand-kit-assets/logo-wordmark-dark.svg" alt="" className="site-wordmark-dark h-5 w-auto transition-transform duration-300 group-hover:scale-[1.04]" />
          </Link>
        </motion.div>

        <motion.div
          className="relative hidden items-center justify-self-center md:flex"
          initial={false}
          animate={shown ? { y: 0, opacity: 1 } : { y: -22, opacity: 0 }}
          transition={{ duration: 0.5, ease: [0.2, 0.7, 0.2, 1] }}
          style={{ pointerEvents: shown ? "auto" : "none" }}
        >
          {LINKS.map((l) => (
            <NavLink key={l.href} {...l} />
          ))}
        </motion.div>

        {/* Actions cell — EXEMPT from the gate. Painted on first load so the landing always offers a
            way to convert; pointer-events re-enabled since the header itself is click-through. */}
        <div className="pointer-events-auto relative flex items-center gap-1.5 justify-self-end">
          <ThemeToggle />
          {/* The cell answers who is looking. Someone with an account on this device gets a door to
              their money plus their next step; a first-timer gets ONBOARDING — not the demo link it
              used to point at. The demo is still the best pitch and still one tap away on /try, but
              as the answer to "Get started" it was the wrong shape: it hands you $5 of practice
              money through a claim link, which explains the product without ever giving you an
              account. /welcome now opens one in a few seconds, on practice money, which is what a
              person pressing that button is actually asking for. */}
          {hasAccount ? (
            <>
              <Button
                asChild
                variant="ghost"
                className="rounded-xl px-3 transition-transform duration-200 hover:-translate-y-0.5"
              >
                <Link href="/start">Activate</Link>
              </Button>
              <Button asChild className="rounded-xl px-4 transition-transform duration-200 hover:-translate-y-0.5">
                <Link href="/home">My money</Link>
              </Button>
            </>
          ) : (
            <Button asChild className="rounded-xl px-4 transition-transform duration-200 hover:-translate-y-0.5">
              <Link href="/welcome">Get started</Link>
            </Button>
          )}
        </div>
      </nav>
    </header>
  );
}
