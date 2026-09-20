/**
 * /pro-hackathon-deck - the pitch deck for the Rise In x Stellar Pro Hackathon (Scale Track,
 * Istanbul, 19-21 Sept 2026), served from our own domain so the submission link and the product
 * live in the same place.
 *
 * It sits OUTSIDE the (site) group on purpose: a deck wants the whole viewport, and the group's
 * layout brings the nav, the footer and a theme toggle that would all fight a presentation. The
 * palette is the LOCKED Periwinkle dark set (brand.md 4.2), hardcoded in deck.css rather than read
 * from --pw-* tokens, because a deck must look the same on a projector whatever theme the viewer's
 * machine reports.
 *
 * noindex: this is a submission artefact with a date on it, not a page we want ranking for
 * "Lumenia". Every number on it is measured and every claim is one the README backs.
 */
import type { Metadata } from "next";
import { Deck } from "./Deck";
import "../../components/site/fonts.css";
import "./deck.css";

export const metadata: Metadata = {
  title: "Lumenia | Pro Hackathon deck",
  description:
    "Send dollars by link. The person receiving needs no wallet, no app and no XLM. Scale Track deck for the Rise In x Stellar Pro Hackathon, Istanbul, 19-21 September 2026.",
  robots: { index: false, follow: false },
};

export default function ProHackathonDeckPage() {
  return <Deck />;
}
