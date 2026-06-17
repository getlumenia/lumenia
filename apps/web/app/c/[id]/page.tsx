/**
 * Claim page — the hero, VALUE-FIRST (Kaan/Nicole + WhatsApp-webview research).
 *
 * The page shows the money IMMEDIATELY — "Annen sana para gönderdi · $20" — with
 * NO credential, wallet, or crypto term in sight. The "30s promise" is kept here,
 * before any signer/recovery exists. The actual claim + credential setup happen in
 * the client component AFTER the user has seen the value (deferred-credential).
 */
import { notFound } from "next/navigation";
import { getClaim, indicativeRate } from "../../../lib/claims";
import { formatUsd, usdToTryIndicative } from "../../../lib/money";
import { tr } from "../../../lib/copy";
import ClaimButton from "./ClaimButton";

export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claim = await getClaim(id);
  if (!claim) notFound();

  return (
    <main className="center">
      <div className="card">
        <p className="muted">{tr.claim.youReceived(claim.senderName)}</p>
        <div className="amount">{formatUsd(claim.usd)}</div>
        <div className="amount-try">≈ {usdToTryIndicative(claim.usd, indicativeRate())}</div>
        <p className="muted" style={{ marginTop: "1.5rem" }}>{tr.claim.amountNote}</p>
        {/* Value already shown above — the credential/claim work lives here, deferred. */}
        <ClaimButton claimId={claim.id} />
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "1rem" }}>{tr.claim.holdHint}</p>
      </div>
    </main>
  );
}
