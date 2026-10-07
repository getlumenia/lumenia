/**
 * Claim page: THE HERO, value-first (UX/product review + WhatsApp-webview research).
 *
 * The money is shown as soon as the ledger says what it is, with no credential to make and
 * nothing to install (vocabulary law section 8; the only two nouns the page names, it names to
 * say the person needs neither). It also carries the same network badge and the same two event
 * lines as the v2 claim page, because a queue at a hackathon table meets whichever of the two it
 * is handed and must not be told two different stories.
 *
 * PRIVATE BY DEFAULT (D2). Every chat app and every bot that is handed this link fetches it, so
 * what the server renders here is what they all get: the badge, the layout and a skeleton, and
 * the same metadata for every link (lib/link-preview.ts). No sender name and no amount, for ANY
 * link, old or new. The name rides in the #fragment behind the key and the amount is read from the
 * ledger by the balance id; both are filled in by ClaimView in the browser. The query carries only
 * the balance id `b` (plus `i` and `seeded=1` where a builder adds them); a pre-D2 link's `a` is
 * ignored and its `s` is read client-side only. The bearer key is read only client-side
 * (ClaimButton). Periwinkle (via the `.claim-pw` scope in globals.css), light-only, CSS-only, still
 * no Motion or webfont on this route; the claim mechanics are byte-identical (re-proven by the
 * live-claim regression after every deploy).
 */
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { getServerRate } from "../../../lib/rate";
import { privateClaimMetadata } from "../../../lib/link-preview";
import ClaimView from "./ClaimView";

type SP = Record<string, string | string[] | undefined>;

/** A real claim link carries its balance id in the query. No id, not a claim link (the
 *  fake-data stub is gone: no-mock-data rule). Nothing else in the query is read here. */
function readClaim(sp: SP): { balanceId: string } | null {
  const b = Array.isArray(sp.b) ? sp.b[0] : sp.b;
  return typeof b === "string" && b ? { balanceId: b } : null;
}

// The claim page ships light-only Periwinkle; override the root themeColor to the Periwinkle paper.
export const viewport: Viewport = { themeColor: "#F5F3EF" };

/** The same title, description and image for every link: nothing in the URL reaches a preview. */
export function generateMetadata(): Metadata {
  return privateClaimMetadata();
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
  // labeled constant if the feed is unreachable. A market number, not the link's: ClaimView turns
  // the LEDGER amount into lira with it once that amount is known.
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
        <ClaimView claimId={id} balanceId={claim.balanceId} rate={rate} />

        <p className="mt-1 text-xs text-ink-soft">Test network. This money isn&apos;t real.</p>
      </div>
    </main>
  );
}
