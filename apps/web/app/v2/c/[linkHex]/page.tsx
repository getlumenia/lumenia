/**
 * /v2/c/[linkHex] — the v2 (Soroban LumenDrop) claim page. Value-first: the money is shown
 * before any action. The recipient claims walletless, and the recipient pays no gas: a fresh
 * sponsored account is created for them and the drop is paid straight into it via the /v2-claim
 * relayer (proven live).
 *
 * WHAT THE SERVER MAY SAY, AND WHY IT IS SO LITTLE (D2 private links). Every chat app fetches a
 * pasted link, and so does every bot that follows one, and what they get is this page's server
 * render: its metadata, its HTML and the RSC payload inside it. Until D2 all three named the sender
 * and printed the amount, taken from the query, for every link. Now:
 *   - the metadata is lib/claim-metadata.ts v2ClaimMetadata: the fixed private card unless the
 *     sender chose `preview=rich`, and then the amount comes from the ledger, never from `a=`;
 *   - the body carries no name and no amount for ANY link. The client component gets the link id,
 *     the `g` share-count hint and the network marker, and nothing else, because every prop handed
 *     to it is serialised into the HTML. It reads the name from the #fragment (or, on a legacy or
 *     rich link, the query) and the amount from the escrow, in the browser.
 *
 * This is a NEW route (the v1 /c/[id] is a separate one). It reuses the brand tokens.
 */
import type { Metadata, Viewport } from "next";
import { parseSlots } from "../../../../lib/link-fragment";
import { v2ClaimMetadata } from "../../../../lib/claim-metadata";
import V2ClaimButton from "./V2ClaimButton";

/**
 * Without a card the link arrives in WhatsApp as a bare https://getlumenia.com/v2/c/3f9a8c... with a
 * generic grey box, the visual signature of a phishing message. A private link gets the fixed
 * Lumenia card (it says money is waiting, not whose or how much); a rich one names the sender and
 * the ledger amount.
 *
 * `robots` is declared on both: this route sits at the top level, not inside the (app) group whose
 * layout carries the noindex, so nothing else says it for it. robots.ts Disallows the path too, and
 * next.config.ts adds the X-Robots-Tag and no-referrer headers; a Disallow alone can still leave a
 * link-discovered URL listed.
 */
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ linkHex: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { linkHex } = await params;
  return v2ClaimMetadata(linkHex, await searchParams);
}

/**
 * The root layout pins maximumScale: 1, which renders as user-scalable=no — a WCAG failure. The
 * (app) and (site) groups each override it; this route is in neither, so it kept the failure on a
 * screen showing someone their money in 12px grey.
 */
export const viewport: Viewport = { maximumScale: 5, themeColor: "#F5F3EF", viewportFit: "cover" };

export default async function V2ClaimPage({
  params,
  searchParams,
}: {
  params: Promise<{ linkHex: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { linkHex } = await params;
  const sp = await searchParams;
  /* `g` says this link holds a POT of shares rather than one payment. Anything that is not a whole
     number inside the escrow's bounds is IGNORED rather than clamped, because a clamped count would
     print a number the escrow never agreed to. It only decides which view is read first and what the
     page says while it waits; the per-share amount comes from the escrow, and so does everything that
     gets signed. It is a count, never a name or an amount, so it may cross into the client props. */
  const slots = parseSlots(sp.g);
  // `n=public` means this link carries REAL money. The honesty note below was unconditional, so a
  // friend opening a real transfer was told by the app itself that the money isn't real — on the
  // one screen a non-user ever sees, about the one thing they care about.
  const real = sp.n === "public";

  return (
    /* `claim-pw` is what makes this Periwinkle. Without it the page fell through to the retired
       green :root tokens, so the live claim screen — the only screen a recipient ever sees — was a
       different product from the one they land on right after. */
    <main className="claim-pw mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-8 bg-paper px-6 py-12 text-center text-ink">
      {/* The header (who, how much) and the action, both client-side: see the note at the top. */}
      <V2ClaimButton linkHex={linkHex} slots={slots} real={real} />
      {real ? (
        <p className="text-xs text-ink-soft">Real money, on the public Stellar record.</p>
      ) : (
        <p className="text-xs text-ink-soft">Test network. This money isn&apos;t real.</p>
      )}
    </main>
  );
}
