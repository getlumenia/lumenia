// USDC amounts on NEAR. On chain a USDC amount is a u128 string with 6 decimals ("5000000" = 5 USDC).
// People type dollars and cents, so the parser accepts at most 2 decimals, and a decimal comma.
// Everything goes through BigInt strings: no float ever touches a balance.

export const USDC_DECIMALS = 6;
const UNIT = 1_000_000n;

export type ParsedAmount = { ok: true; units: string } | { ok: false; reason: string };

/**
 * "5" -> "5000000", "0.1" -> "100000", "12.34" -> "12340000". A decimal comma is accepted.
 * Rejects more than 2 decimals, zero, negatives, and anything above `maxUnits` when given.
 */
export function parseUsdcAmount(input: string, opts: { maxUnits?: string } = {}): ParsedAmount {
  const s = input.trim().replace(",", ".");
  if (s === "") return { ok: false, reason: "Enter an amount." };
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) {
    return { ok: false, reason: "Use digits and at most one decimal point, like 5 or 2.50." };
  }
  const [intPart = "", fracPart = ""] = s.split(".");
  if (fracPart.length > 2) return { ok: false, reason: "Use at most 2 decimals (whole cents)." };
  const cents = BigInt((fracPart + "00").slice(0, 2));
  const units = BigInt(intPart || "0") * UNIT + cents * 10_000n;
  if (units <= 0n) return { ok: false, reason: "The amount must be more than zero." };
  if (opts.maxUnits !== undefined && units > BigInt(opts.maxUnits)) {
    return { ok: false, reason: `The limit here is ${formatUsdc(opts.maxUnits)} USDC per link.` };
  }
  return { ok: true, units: units.toString() };
}

/** "5000000" -> "5.00", "5123456" -> "5.123456", "100" -> "0.0001". Never fewer than 2 decimals. */
export function formatUsdc(units: string | bigint): string {
  const v = BigInt(units);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / UNIT;
  let frac = (abs % UNIT).toString().padStart(USDC_DECIMALS, "0");
  frac = frac.replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

/** "$5.00" */
export function formatUsd(units: string | bigint): string {
  return `$${formatUsdc(units)}`;
}

/** Generic unit formatting for other tokens (Intents quotes can be 7-decimal Stellar amounts). */
export function formatUnits(units: string | bigint, decimals: number, minFraction = 2): string {
  const v = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < minFraction) frac = frac.padEnd(minFraction, "0");
  return frac.length ? `${whole}.${frac}` : whole.toString();
}

/** yoctoNEAR -> "1.2345" NEAR (4 decimals, trimmed). */
export function formatNear(yocto: bigint, decimals = 4): string {
  const base = 10n ** 24n;
  const whole = yocto / base;
  const frac = (yocto % base).toString().padStart(24, "0").slice(0, decimals).replace(/0+$/, "");
  return frac.length ? `${whole}.${frac}` : whole.toString();
}
