/**
 * The claim card image a chat preview shows, as a ROUTE HANDLER (Note A fix): the special
 * `opengraph-image` file convention only receives `params`, never the query, and the card's inputs
 * ride in the query.
 *
 * It paints ONLY for a link whose sender chose to show the amount and their name (`preview=rich`),
 * only for a real link id (`l`, 64 hex), and only when the ledger answers with a LIVE drop or pool
 * behind that id (lib/claim-metadata.ts `ogCard`). The amount is read from the ledger here, never
 * taken from an `a=`. The name can only come from the query (the sender typed it, nothing can verify
 * it), which is exactly why it is drawn only next to money the ledger vouches for: a made-up id, a
 * spent link or an escrow that cannot be read gets the fixed /og.png, so nobody can mint a
 * "<any name> sent you money" card on our domain with no money behind it. Every private link and
 * every pre-D2 `?a=..&s=..` card URL still cached in a chat is a 307 to /og.png as well.
 *
 * satori has no system fonts, so we embed one weight (Plus Jakarta Sans Bold, which covers Turkish
 * sender names). Referenced from the v2 page's generateMetadata, made absolute by metadataBase.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { ogCard } from "@/lib/claim-metadata";
import { PRIVATE_PREVIEW_IMAGE } from "@/lib/link-preview";

export const runtime = "nodejs";
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };

// The embedded font is read from apps/web/assets (a bracket-free path, kept in the
// OG function bundle via next.config `outputFileTracingIncludes`).
// fetch(new URL(...import.meta.url)) does NOT work here: the .ttf isn't emitted
// beside the compiled route module.
const FONT_PATH = join(process.cwd(), "assets", "PlusJakartaSans-Bold.ttf");

/**
 * The fixed card. 307, not 308: what this URL answers can change (a link that has just been funded
 * becomes readable, a sender may still turn previews on), so no client is told to remember it for
 * good. Kept at the edge for a minute, so a burst of requests for made-up ids is answered there
 * instead of becoming one ledger read each.
 */
function staticCard(requestUrl: URL): Response {
  return new Response(null, {
    status: 307,
    headers: {
      location: new URL(PRIVATE_PREVIEW_IMAGE.url, requestUrl).toString(),
      "cache-control": "public, max-age=60, s-maxage=60",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const card = await ogCard(url.searchParams);
  if (card.kind === "static") return staticCard(url);

  const font = await readFile(FONT_PATH);
  const line = card.group ? `${card.name} sent money to a group` : `${card.name} sent you money`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#F5F3EF",
          fontFamily: "Jakarta",
          padding: 80,
        }}
      >
        <div style={{ display: "flex", fontSize: 46, color: "#67626E" }}>{line}</div>
        <div style={{ display: "flex", fontSize: 168, color: "#6E5FCE", marginTop: 6, letterSpacing: -4 }}>
          {card.usd}
        </div>
        {card.group ? <div style={{ display: "flex", fontSize: 32, color: "#67626E" }}>each share</div> : null}
        <div style={{ display: "flex", fontSize: 32, color: "#6E5FCE", marginTop: 40 }}>
          {"Tap to claim · Lumenia"}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: "Jakarta", data: font, weight: 700, style: "normal" }],
      /* Drawn only for a live link, with the escrow record's own amount, which never changes. The
         link may be claimed later; the card then still says what was sent, which stays true. (Left
         alone, this route answers `max-age=0, must-revalidate`.) */
      headers: { "cache-control": "public, max-age=86400" },
    },
  );
}
