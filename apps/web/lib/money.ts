/**
 * Money formatting. The user sees only USD ($) and TRY (₺) — never "USDC".
 * `usd` is the canonical balance; `try` is an indicative display conversion.
 */
export function formatUsd(amount: string | number): string {
  const n = typeof amount === "string" ? Number.parseFloat(amount) : amount;
  return `$${n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatTry(amount: string | number): string {
  const n = typeof amount === "string" ? Number.parseFloat(amount) : amount;
  return `₺${n.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Indicative USD→TRY for display only (real rate comes from a quote service later). */
export function usdToTryIndicative(usd: string | number, rate: number): string {
  const n = typeof usd === "string" ? Number.parseFloat(usd) : usd;
  return formatTry(n * rate);
}
