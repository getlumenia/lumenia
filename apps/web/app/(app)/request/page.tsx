/**
 * /request — "ask someone to pay you with a link" (REQUEST_MONEY.md §10). The
 * server half only carries metadata; everything real happens client-side in
 * RequestClient. Deliberately works WITHOUT an account (value-first: a first-time
 * asker sets up nothing until money exists) — see lib/request.ts for the full
 * §5.1 decision. noindex: an ask is somebody's money business.
 */
import type { Metadata } from "next";
import { RequestClient } from "./RequestClient";

export const metadata: Metadata = {
  title: "Ask for money | Lumenia",
  description: "Make a link that asks someone to pay you. Share it in any chat.",
  robots: { index: false },
};

export default function RequestPage() {
  return <RequestClient />;
}
