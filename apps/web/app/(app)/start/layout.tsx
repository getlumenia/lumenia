import type { Metadata } from "next";

/** The page itself is a client component, so its tab title lives here ("Get started | Lumenia"). */
export const metadata: Metadata = { title: "Get started" };

export default function StartLayout({ children }: { children: React.ReactNode }) {
  return children;
}
