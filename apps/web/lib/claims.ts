/**
 * Claim lookup (server-side). In production this reads a claim by the link's
 * secret hash from Postgres (only hash(secret) is stored — see @lumenia/shared)
 * and returns the public, value-first display data. Stubbed here so the claim
 * page + OG card render. The bearer secret in the link fragment is never sent
 * to the server; the server only knows the public claim metadata by id.
 */
export interface ClaimView {
  id: string;
  senderName: string;
  usd: string; // canonical amount the recipient receives
  status: "pending" | "claimed" | "expired";
}

const INDICATIVE_USD_TRY = 38.0; // display-only; replace with a live quote service

export function indicativeRate(): number {
  return INDICATIVE_USD_TRY;
}

export async function getClaim(id: string): Promise<ClaimView | null> {
  // TODO: real lookup by id → DB row (created at link-generation time).
  if (!id || id.length < 3) return null;
  return { id, senderName: "Annen", usd: "20.00", status: "pending" };
}
