/**
 * /c/near: the OLD path of the practice-money claim screen, now at /claim. A link's secret rides in
 * the #fragment, and a server never sees a fragment, so a server-side redirect would drop the money
 * out of the link. This page is therefore a tiny client forward: it reads window.location.hash in
 * the browser and replaces the location with /claim plus the same hash (Forward.tsx). Links minted
 * before the move, and the ones the agent MCP still writes on /c/near#, keep opening.
 *
 * Same headers as /claim (next.config.ts: no-referrer, noindex), the same fixed preview card, no
 * analytics (outside the (site) group).
 */
import type { Metadata, Viewport } from "next";
import { privateClaimMetadata } from "../../../lib/link-preview";
import { Forward } from "./Forward";
import "../../../components/site/fonts.css";
import "../../../components/near/near.css";
import "../../claim/claim.css";

export function generateMetadata(): Metadata {
  return privateClaimMetadata();
}

export const viewport: Viewport = { maximumScale: 5, themeColor: "#F5F3EF", viewportFit: "cover" };

export default function LegacyClaimPath() {
  return (
    <main className="claim-pw nc">
      <div className="nc-glow" aria-hidden="true" />
      <Forward />
    </main>
  );
}
