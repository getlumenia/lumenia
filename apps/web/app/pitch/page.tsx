/**
 * /pitch: the partner deck, served from our own domain so the link and the product live in the
 * same place.
 *
 * It sits OUTSIDE the (site) group on purpose: a deck wants the whole viewport, and the group's
 * layout brings a nav, a footer and a theme toggle that would all fight a presentation. noindex,
 * and left out of sitemap.ts: it is a page people are sent to, not one we want ranking for
 * "Lumenia". Static: nothing on it reads an endpoint, so a slow venue network cannot break a slide.
 */
import type { Metadata, Viewport } from "next";
import { PitchDeck } from "./PitchDeck";
import "../../components/site/fonts.css";
import "./pitch.css";

const TITLE = "Lumenia | Send dollars by link";
const DESCRIPTION =
  "An eight-slide introduction for partners: send USDC by link, and the person you pay needs no app, no wallet and no seed phrase, and pays no gas.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: { index: false, follow: true },
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", url: "/pitch" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: "#F5F3EF",
  width: "device-width",
  initialScale: 1,
};

export default function PitchPage() {
  return <PitchDeck />;
}
