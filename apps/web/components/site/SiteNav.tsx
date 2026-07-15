/**
 * SiteNav — the landing's persistent top nav. Hidden over the immersive opening hero (which has its
 * own wordmark), it slides + fades in (Motion) once you scroll past the hero. A 3-column grid keeps
 * the links optically centered (logo left · links centre · actions right). Each link has an animated
 * underline + color hover. Built on the `.site-theme` Periwinkle scope so it stays on-brand.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > window.innerHeight * 1.35);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.header
      className="site-theme fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4"
      initial={false}
      animate={shown ? { y: 0, opacity: 1 } : { y: -22, opacity: 0 }}
      transition={{ duration: 0.5, ease: [0.2, 0.7, 0.2, 1] }}
      style={{ pointerEvents: shown ? "auto" : "none" }}
    >
      {/* The width tracks the sections' own large-screen growth (see the large-screen block in
          landing.css). Capped at max-w-5xl the bar shrank to ~40% of a 2560 display while the
          content beneath it grew past — the nav read as a lost little pill. Below ~1770px this
          resolves to exactly max-w-5xl, so nothing changes at the sizes it was designed at. */}
      <nav className="grid w-full max-w-[clamp(64rem,58vw,90rem)] grid-cols-[1fr_auto_1fr] items-center gap-4 rounded-2xl border border-border/70 bg-background/75 px-4 py-2.5 shadow-[0_16px_44px_-24px_rgba(110,95,206,0.55)] backdrop-blur-xl">
        <Link href="/" className="group justify-self-start px-1" aria-label="Lumenia — home">
          {/* Wordmark swaps per theme (paper-filled counters only read on light). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand-kit-assets/logo-wordmark-t.svg" alt="" className="site-wordmark-light h-5 w-auto transition-transform duration-300 group-hover:scale-[1.04]" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand-kit-assets/logo-wordmark-dark.svg" alt="" className="site-wordmark-dark h-5 w-auto transition-transform duration-300 group-hover:scale-[1.04]" />
        </Link>

        <div className="hidden items-center justify-self-center md:flex">
          {LINKS.map((l) => (
            <NavLink key={l.href} {...l} />
          ))}
        </div>

        <div className="flex items-center gap-1.5 justify-self-end">
          <ThemeToggle />
          <Button asChild className="rounded-xl px-4 transition-transform duration-200 hover:-translate-y-0.5">
            <Link href="/demo">Try the demo</Link>
          </Button>
        </div>
      </nav>
    </motion.header>
  );
}
