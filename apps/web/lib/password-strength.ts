/**
 * Recovery-password strength floor (security review F1). The password copy of the seed is
 * server-stored ciphertext an attacker can fetch and crack OFFLINE (Argon2id-bounded only) —
 * so "your password is the only key to your money" is TRUE only if the password is strong.
 * A 6-char or common password is instant to crack = fund theft.
 *
 * This is a dependency-free heuristic floor (a full zxcvbn score is the ideal, noted). It runs
 * CLIENT-SIDE only: the server is zero-knowledge and never sees the password — its only lever is
 * the Argon2id param minimum (see apps/sponsor recovery-store.ts). Applies to SETTING a recovery
 * password (secure), not to entering an existing one (restore).
 */

// A small set of the most-abused passwords + obvious patterns (not exhaustive — the length +
// variety + sequence checks catch the long tail; a breached-list check is the real upgrade).
const COMMON = new Set([
  "password", "password1", "password123", "123456", "12345678", "123456789", "1234567890",
  "qwerty", "qwertyuiop", "111111", "000000", "abc123", "letmein", "iloveyou", "admin",
  "welcome", "monkey", "dragon", "football", "baseball", "sunshine", "princess", "whatever",
  "trustno1", "starwars", "master", "hello123", "test1234", "changeme", "passw0rd",
]);

export interface Strength {
  ok: boolean;
  reason?: string;
}

/** True if the recovery password is strong enough to be the offline-crack floor for the seed. */
export function passwordStrength(pw: string): Strength {
  const p = pw;
  if (p.length < 10) return { ok: false, reason: "Use at least 10 characters. This is the only key to your money." };
  const lower = p.toLowerCase();
  // The 10-char floor already puts the bare entries out of reach, so the list only earns its keep
  // against the stem: "Password12" and "qwerty!!!" are the same guess with a suffix bolted on.
  const stem = lower.replace(/[^a-z]+$/, "");
  if (COMMON.has(lower) || COMMON.has(stem)) {
    return { ok: false, reason: "That's a very common password. Pick something only you would choose." };
  }
  if (/^(.)\1+$/.test(p)) return { ok: false, reason: "Too easy to guess. Don't repeat one character." };
  if (/^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/i.test(p)) {
    return { ok: false, reason: "Too easy to guess. Avoid keyboard or number runs." };
  }
  // Variety OR a long passphrase. A single character class under 14 chars is weak.
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
  if (classes < 2 && p.length < 14) {
    return { ok: false, reason: "Mix in a capital, a number or a symbol, or make it a longer phrase." };
  }
  return { ok: true };
}
