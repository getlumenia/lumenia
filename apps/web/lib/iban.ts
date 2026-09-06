/**
 * IBAN check, mod-97 (ISO 13616). Used before a bank account number is sent anywhere, so a typo
 * is caught on this device rather than by an anchor's rejection, or worse, by a payout to the
 * wrong account. A valid checksum is not proof the account exists or is the person's; it is
 * proof the string was copied correctly.
 */

/** Country-specific lengths for the countries this product expects to see first. */
const LENGTHS: Record<string, number> = { TR: 26, DE: 22, NL: 18, FR: 27, GB: 22, ES: 24, IT: 27, BE: 16, AT: 20 };

/** Upper-case, no spaces: the form the anchor wants and the checksum is defined on. */
export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const expected = LENGTHS[iban.slice(0, 2)];
  if (expected && iban.length !== expected) return false;
  // Move the first four characters to the end, map letters to 10..35, take the number mod 97.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" ? ch.charCodeAt(0) - 55 : Number(ch);
    // Digit by digit (two digits for letters) keeps the running value small.
    remainder = (remainder * (v > 9 ? 100 : 10) + v) % 97;
  }
  return remainder === 1;
}

/** "TR33 0006 1005 1978 6457 8413 26": groups of four, for a screen. */
export function formatIban(raw: string): string {
  return normalizeIban(raw).replace(/(.{4})/g, "$1 ").trim();
}
