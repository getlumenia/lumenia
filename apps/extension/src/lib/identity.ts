/**
 * The three small facts every Lumenia surface shows the same way (LUMENIA ACCOUNT CONTRACT v1, 0.3):
 * the id an email's backup is filed under, an account's short address, and an email with its local
 * part hidden. Pure, so the worker, the popup and the self-tests share one copy.
 */

/** Lowercase hex SHA-256 of the UTF-8 of email.trim().toLowerCase(): the id a backup is filed under. */
export async function emailId(email: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** GCFIRY...XVYOJR: the first six characters, "...", the last six. */
export function shortAddress(a: string): string {
  return a.length > 15 ? `${a.slice(0, 6)}...${a.slice(-6)}` : a;
}

/**
 * f***@example.com: the first character of the part before the last "@", then "***@", then the
 * domain, all lowercase. Enough for the person to recognise their own address, not enough to read
 * it off a screen over a shoulder.
 */
export function maskEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 0) return "***";
  return `${e.slice(0, at).charAt(0)}***@${e.slice(at + 1)}`;
}

/** Two spellings of one address (case, spaces around it) are the same email here, as they are on the server. */
export function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
