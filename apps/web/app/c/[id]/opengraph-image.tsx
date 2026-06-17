/**
 * Per-claim OG card (next/og) — value-first, so the WhatsApp preview itself
 * already says "you got money". Each claim has a unique URL, so WhatsApp's
 * crawler cache self-resolves (stack.md §3.1). Rendered server-side.
 */
import { ImageResponse } from "next/og";
import { getClaim, indicativeRate } from "../../../lib/claims";
import { formatUsd, usdToTryIndicative } from "../../../lib/money";

export const alt = "Lumenia";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: { id: string } }) {
  const claim = await getClaim(params.id);
  const usd = claim ? formatUsd(claim.usd) : "$—";
  const tryStr = claim ? `≈ ${usdToTryIndicative(claim.usd, indicativeRate())}` : "";
  const sender = claim?.senderName ?? "Birisi";

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
          background: "#0b0b0f",
          color: "#f5f5f7",
          fontFamily: "sans-serif",
          gap: 16,
        }}
      >
        <div style={{ fontSize: 40, color: "#9a9aa5" }}>{sender} sana para gönderdi</div>
        <div style={{ fontSize: 140, fontWeight: 700 }}>{usd}</div>
        <div style={{ fontSize: 36, color: "#9a9aa5" }}>{tryStr}</div>
        <div style={{ fontSize: 30, color: "#4ade80", marginTop: 24 }}>Almak için dokun · Lumenia</div>
      </div>
    ),
    size,
  );
}
