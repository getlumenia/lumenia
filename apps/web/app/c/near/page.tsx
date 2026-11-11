/**
 * /c/near: the claim screen of the NEAR rail. A link is https://getlumenia.com/c/near#ed25519:<secret>;
 * the secret rides in the fragment, which a browser never sends to any server, and the page reads it
 * in the browser only (NearClaim.tsx), then takes it out of the address bar.
 *
 * Same posture as the v2 Stellar claim route: a static segment beside /c/[id] (a static segment
 * wins over the dynamic one), the same fixed preview card for every link (no amount, no name: the
 * metadata is what every chat app's preview fetcher receives), noindex here and in the X-Robots-Tag
 * header next.config.ts sets for /c/*, Referrer-Policy no-referrer from the same place, no
 * analytics (this route is outside the (site) group, where the Analytics component lives), and
 * the explorer is never the primary action.
 */
import type { Metadata, Viewport } from "next";
import { privateClaimMetadata } from "../../../lib/link-preview";
import { NearClaim } from "./NearClaim";
import "../../../components/site/fonts.css";
import "../../../components/near/near.css";
import "./near-claim.css";

/** The same title, description and image for every link: nothing in the URL reaches a preview. */
export function generateMetadata(): Metadata {
  return privateClaimMetadata();
}

/** maximumScale 5 undoes the root's user-scalable=no (a person reading an amount zooms). Light-only paper. */
export const viewport: Viewport = { maximumScale: 5, themeColor: "#F5F3EF", viewportFit: "cover" };

export default function NearClaimPage() {
  return (
    <main className="claim-pw nc">
      <div className="nc-glow" aria-hidden="true" />
      <NearClaim />
    </main>
  );
}
