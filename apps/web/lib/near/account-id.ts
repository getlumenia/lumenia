// NEAR account id rules (nearcore `AccountId`): 2 to 64 characters, lowercase a-z, 0-9, "_" "-" ".",
// each dot-separated part non-empty and not starting or ending with "_" or "-".

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isValidAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && ACCOUNT_ID.test(id);
}

/** 64 lowercase hex characters: an implicit account, which exists once something is sent to it. */
export function isImplicitAccountId(id: string): boolean {
  return /^[0-9a-f]{64}$/.test(id);
}

/** "alice" -> "alice.testnet" when the name part (2 to 32 chars) is acceptable for a new named account. */
export function namedAccountId(name: string, suffix: string): string | null {
  const n = name.trim().toLowerCase();
  if (!/^[a-z\d][a-z\d_-]{0,30}[a-z\d]$/.test(n)) return null;
  const id = `${n}.${suffix}`;
  return isValidAccountId(id) ? id : null;
}
