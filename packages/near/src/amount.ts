// USDC amounts: the user-facing form is a decimal string with at most two
// decimals ("2.50"); the chain form is an integer number of 6-decimal units
// ("2500000"). Every conversion goes through strings so no float ever touches
// a balance.

export const USDC_DECIMALS = 6;
export const UNITS_PER_USDC = 1_000_000n;

const AMOUNT_RE = /^(\d{1,12})(?:\.(\d{1,2}))?$/;

export class AmountError extends Error {
  override name = "AmountError";
}

/** Parse a human amount (number or string) into 6-decimal USDC units. */
export function parseUsdcAmount(input: number | string): bigint {
  let text: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new AmountError("amount must be a finite number");
    text = input.toString();
  } else if (typeof input === "string") {
    text = input.trim();
  } else {
    throw new AmountError("amount must be a number or a decimal string");
  }
  const m = AMOUNT_RE.exec(text);
  if (!m) {
    throw new AmountError(
      `amount "${text}" must be a positive decimal with at most 2 decimal places, like 2.50`,
    );
  }
  const whole = BigInt(m[1] ?? "0");
  const frac = (m[2] ?? "").padEnd(USDC_DECIMALS, "0");
  const units = whole * UNITS_PER_USDC + BigInt(frac);
  if (units <= 0n) throw new AmountError("amount must be greater than zero");
  return units;
}

/** Format 6-decimal units as a decimal string, at least `minDecimals` decimals, no trailing noise. */
export function formatUsdc(units: bigint | string | number, minDecimals = 2): string {
  const u = BigInt(units);
  const negative = u < 0n;
  const abs = negative ? -u : u;
  const whole = abs / UNITS_PER_USDC;
  let frac = (abs % UNITS_PER_USDC).toString().padStart(USDC_DECIMALS, "0");
  while (frac.length > minDecimals && frac.endsWith("0")) frac = frac.slice(0, -1);
  const text = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${text}` : text;
}

/** Format yoctoNEAR as NEAR with `decimals` decimals (display only). */
export function formatNear(yocto: bigint | string, decimals = 4): string {
  const y = BigInt(yocto);
  const ONE = 10n ** 24n;
  const whole = y / ONE;
  const frac = (y % ONE).toString().padStart(24, "0").slice(0, decimals);
  return decimals > 0 ? `${whole}.${frac}` : `${whole}`;
}
