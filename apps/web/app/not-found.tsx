import type { Metadata } from "next";
import Link from "next/link";
import { copy } from "../lib/copy";

export const metadata: Metadata = {
  title: "Page not found | Lumenia",
  robots: { index: false },
};

/**
 * Root 404 — renders through the ROOT layout (no group), so it can't use the
 * (site) .pg token scope or the .app-pw scope, and the global :root tokens are
 * the legacy palette the frozen claim route still renders against. So it carries
 * its own self-contained Periwinkle values (same brand.md §4 set feedback.css
 * uses), with a data-theme dark override for visitors arriving from a themed
 * page. Webfont-free like everything at the root.
 */
export default function NotFound() {
  return (
    <main className="nf">
      <style>{`
        .nf{--nf-paper:#F5F3EF;--nf-ink:#1E1B22;--nf-muted:#67626E;--nf-accent:#6E5FCE;--nf-on-accent:#F6F4FD;
          min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
          background:var(--nf-paper);color:var(--nf-ink);text-align:center;padding:0 24px;
          font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}
        :root[data-theme="dark"] .nf{--nf-paper:#15121C;--nf-ink:#EDEAF3;--nf-muted:#A59DB2;--nf-accent:#B7ACE8;--nf-on-accent:#1A1622;}
        .nf-brand{font-size:15px;font-weight:700;letter-spacing:.02em;color:var(--nf-accent);}
        .nf-msg{font-size:16px;color:var(--nf-muted);max-width:340px;line-height:1.5;}
        .nf-home{display:inline-flex;align-items:center;height:44px;padding:0 22px;border-radius:999px;
          background:var(--nf-accent);color:var(--nf-on-accent);font-size:14.5px;font-weight:600;text-decoration:none;}
      `}</style>
      <p className="nf-brand">Lumenia</p>
      <p className="nf-msg">{copy.errors.notFound}</p>
      <Link href="/" className="nf-home">
        Go home
      </Link>
    </main>
  );
}
