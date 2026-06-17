import type { MetadataRoute } from "next";
import { tr } from "../lib/copy";

/** PWA manifest (Next native). Icons are placeholders to add under /public. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: tr.appName,
    short_name: tr.appName,
    description: tr.landing.sub,
    start_url: "/",
    display: "standalone",
    background_color: "#0b0b0f",
    theme_color: "#0b0b0f",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
