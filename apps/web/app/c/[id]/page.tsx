/**
 * Claim page — THE HERO, value-first (UX/product review + WhatsApp-webview research).
 *
 * The money is shown IMMEDIATELY — "Alvin sent you money · $20.00" — with no credential to make
 * and nothing to install (vocabulary law §8; the only two nouns the page names, it names to say
 * the person needs neither). It also carries the same network badge and the same two event lines
 * as the v2 claim page, because a queue at a hackathon table meets whichever of the two it is
 * handed and must not be told two different stories.
 *
 * The public claim metadata (amount, sender, balanceId) rides in the URL query so the server
 * renders it value-first; the bearer key rides in the #fragment and is read only client-side
 * (ClaimButton). Periwinkle (via the `.claim-pw` scope in globals.css), light-only, CSS-only — still
 * no Motion or webfont on this route; only the colours match the rest of the site, the mechanics are
 * byte-identical (re-proven by the live-claim regression after every deploy).
 */
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { getServerRate } from "../../../lib/rate";
import { formatUsd, usdToTryIndicative } from "../../../lib/money";
import { copy } from "../../../lib/copy";
import { PersonChip } from "../../../components/brand/PersonChip";
import ClaimButton from "./ClaimButton";

type SP = Record<string, string | undefined>;

interface ClaimView {
  senderName: string;
  usd: string;
  balanceId: string;
}

/** A real claim link carries the public metadata in the query. No query → not a
 *  claim link (the fake-data stub is gone — no-mock-data rule). */
function readClaim(sp: SP): ClaimView | null {
  if (sp.a && sp.b) return { senderName: sp.s ?? "Someone", usd: sp.a, balanceId: sp.b };
  return null;
}

// The claim page ships light-only Periwinkle; override the root themeColor to the Periwinkle paper.
export const viewport: Viewport = { themeColor: "#F5F3EF" };

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}): Promise<Metadata> {
  const { id } = await params;
  const claim = readClaim(await searchParams);
  if (!claim) return { title: copy.appName };
  const qs = new URLSearchParams({ a: claim.usd, s: claim.senderName }).toString();
  const title = `${claim.senderName} sent you ${formatUsd(claim.usd)}`;
  const images = [`/c/${id}/og?${qs}`];
  return {
    title,
    openGraph: { title, images },
    twitter: { card: "summary_large_image", title, images },
  };
}

export default async function ClaimPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const { id } = await params;
  const claim = readClaim(await searchParams);
  if (!claim) notFound();
  // The live ECB reference rate, cached for an hour by Next's fetch cache; falls back to the
  // labeled constant if the feed is unreachable. No client JS, no webfont — the route's budget is
  // untouched.
  const { rate } = await getServerRate();

  return (
    <main className="claim-pw flex min-h-dvh flex-col items-center justify-center bg-paper px-6 py-10 text-ink">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
        {/* Which money this is, before anything else: real dollars and practice dollars must
            never look alike on the one screen a stranger ever sees. The v2 claim page reads the
            network off the link; this route cannot, and does not need to: ClaimButton pins it to
            the test network and its receipt links to the test record, so the label is fixed. */}
        <span className="rounded-full border border-line px-3 py-0.5 text-xs font-semibold text-ink-soft">
          Practice money
        </span>
        <PersonChip name={claim.senderName} size="lg" nameless joyRing />
        <p className="text-xl text-ink-soft">{copy.claim.youReceived(claim.senderName)}</p>

        {/* value-first: the money, huge, tabular, before any action or hydration */}
        <div className="text-[3.5rem] font-bold leading-none tracking-tight tabular-nums text-money">
          {formatUsd(claim.usd)}
        </div>
        <p className="text-sm text-ink-soft">
          ≈ {usdToTryIndicative(claim.usd, rate)} <span className="opacity-70">indicative</span>
        </p>
        {/* The v2 claim page's line, word for word. It replaces "No app, no sign-up - just tap.",
            which said the same thing minus the part that matters most to the person reading it:
            the network cost is the sponsor's, not theirs. */}
        <p className="mt-1 text-sm font-medium text-ink">No app. No wallet. You pay nothing.</p>

        <div className="mt-4 w-full">
          <ClaimButton claimId={id} balanceId={claim.balanceId} sender={claim.senderName} />
        </div>

        <p className="mt-1 text-xs text-ink-soft">Test network. This money isn&apos;t real.</p>
      </div>
    </main>
  );
}
