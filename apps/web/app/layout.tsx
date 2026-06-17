import type { Metadata, Viewport } from "next";
import { tr } from "../lib/copy";
import "./globals.css";

export const metadata: Metadata = {
  title: tr.appName,
  description: tr.landing.sub,
  applicationName: tr.appName,
  appleWebApp: { capable: true, statusBarStyle: "default", title: tr.appName },
};

export const viewport: Viewport = {
  themeColor: "#0B0B0F",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
