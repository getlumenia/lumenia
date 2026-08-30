/**
 * Money formatting. The user sees only USD ($) and TRY (₺) — never "USDC".
 * `usd` is the canonical balance; `try` is an indicative display conversion.
 */
export function formatUsd(amount: string | number): string {
  const n = typeof amount === "string" ? Number.parseFloat(amount) : amount;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatTry(amount: string | number): string {
  const n = typeof amount === "string" ? Number.parseFloat(amount) : amount;
  return `₺${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Indicative USD→TRY for display only (real rate comes from a quote service later). */
export function usdToTryIndicative(usd: string | number, rate: number): string {
  const n = typeof usd === "string" ? Number.parseFloat(usd) : usd;
  return formatTry(n * rate);
}

/**
 * The filter every amount field runs its keystrokes through.
 *
 * A Turkish or European keyboard puts a COMMA where the decimal point goes, so the plain
 * digits-and-dots filter this replaces turned "1,50" into "150": a field showing one hundred and
 * fifty dollars for an intended one-fifty, with nothing but the ledger balance bounding the
 * mistake on a cash-out.
 *
 * The invariant: what the field SHOWS must parse to the number the app will send. A separator is
 * never silently reinterpreted into another magnitude — input this cannot read unambiguously
 * ("1.234,56") is cut where the person can see it, not re-scaled behind their back.
 */
export function sanitizeAmountInput(raw: string): string {
  if (!raw) return "";
  const kept = raw.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const first = kept.indexOf(".");
  if (first < 0) return kept;
  const rest = kept.slice(first + 1);
  const second = rest.indexOf(".");
  // Truncated, never rounded: entry may not invent money the person did not type.
  const frac = (second < 0 ? rest : rest.slice(0, second)).slice(0, 2);
  // A separator typed before any digit still has to read as money — formatUsd(".") is "$NaN".
  return `${kept.slice(0, first) || "0"}.${frac}`;
}
