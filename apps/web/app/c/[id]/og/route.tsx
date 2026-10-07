/**
 * The claim card image a chat preview shows, as a ROUTE HANDLER (Note A fix): the special
 * `opengraph-image` file convention only receives `params`, never the query, and the card's inputs
 * ride in the query.
 *
 * It paints ONLY for a link whose sender chose to show the amount and their name (`preview=rich`)
 * and only for a real link id (`l`, 64 hex). Even then the amount is read from the ledger here,
 * never taken from an `a=` (lib/claim-metadata.ts richCard), and a ledger that does not answer in
 * time leaves the name alone on the card. Everything else, every private link and every pre-D2
 * `?a=..&s=..` card URL still cached in a chat, is a 307 to the fixed /og.png: this route never
 * draws a figure or a name that only a query string vouches for.
 *
 * satori has no system fonts, so we embed one weight (Plus Jakarta Sans Bold, which covers Turkish
 * sender names). Referenced from the v2 page's generateMetadata, made absolute by metadataBase.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { ogDecision, richCard } from "@/lib/claim-metadata";
import { PRIVATE_PREVIEW_IMAGE } from "@/lib/link-preview";

export const runtime = "nodejs";
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };

// The embedded font is read from apps/web/assets (a bracket-free path, kept in the
// OG function bundle via next.config `outputFileTracingIncludes`).
// fetch(new URL(...import.meta.url)) does NOT work here: the .ttf isn't emitted
// beside the compiled route module.
const FONT_PATH = join(process.cwd(), "assets", "PlusJakartaSans-Bold.ttf");

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const decision = ogDecision(url.searchParams);
  if (decision.kind === "static") {
    // 307, not 308: what this URL answers can change (a sender may still turn previews on), so no
    // client should be told to remember the redirect for good.
    return Response.redirect(new URL(PRIVATE_PREVIEW_IMAGE.url, url), 307);
  }

  const [card, font] = await Promise.all([richCard(decision), readFile(FONT_PATH)]);
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
        <div style={{ display: "flex", fontSize: card.usd ? 46 : 64, color: "#67626E" }}>{line}</div>
        {card.usd ? (
          <div style={{ display: "flex", fontSize: 168, color: "#6E5FCE", marginTop: 6, letterSpacing: -4 }}>
            {card.usd}
          </div>
        ) : null}
        {card.usd && card.group ? (
          <div style={{ display: "flex", fontSize: 32, color: "#67626E" }}>each share</div>
        ) : null}
        <div style={{ display: "flex", fontSize: 32, color: "#6E5FCE", marginTop: 40 }}>
          {"Tap to claim \u00B7 Lumenia"}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: "Jakarta", data: font, weight: 700, style: "normal" }],
      /* A card that carries the ledger amount can be kept: an escrow record's amount never changes.
         One the ledger did not answer for is kept for one minute only, so the next fetch after that
         can still get the amount, while a burst of requests for made-up link ids is served from the
         edge instead of becoming one RPC simulation each. (Left alone, this route answers
         `max-age=0, must-revalidate` either way.) */
      headers: { "cache-control": card.usd ? "public, max-age=86400" : "public, max-age=60, s-maxage=60" },
    },
  );
}
