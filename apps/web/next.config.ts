import type { NextConfig } from "next";

// Minimal config. PWA service worker (Serwist) to be added at M0 — research:
// @serwist/turbopack 9.5.11 is viable; @serwist/next + `next build --webpack`
// is the safer fallback (Next 16 still supports the webpack opt-in).
const nextConfig: NextConfig = {};

export default nextConfig;
